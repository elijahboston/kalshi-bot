# Win-Rate 80% Addendum — 2026-06-05 (Second Deep Dive)

> Companion to [`win-rate-80-plan-2026-06-05.md`](win-rate-80-plan-2026-06-05.md). That plan covers the strategy redirection (concordance gates, confirmation mode, adaptive market prior, sigma floor, hit-rate fix, confidence rewrite, station disable, ultra-sniper, telemetry). **This document contains only NEW findings and NEW action items discovered in a second pass over the trades, data pipeline, and codebase.** Nothing here duplicates the first plan.

---

## New findings

### Finding 1 — Ground truth is corrupted: our "actuals" disagree with Kalshi settlements on ~70% of days ⚠️ DEEPEST ROOT CAUSE

For every settled `bracket` market that resolved YES, the official settlement high must lie inside that bracket. Cross-validating our NWS-derived `weather_forecasts.actual_value` against the YES bracket:

| Station | Days | Actual inside YES bracket | Too cold | Too hot | Avg offset vs official |
|---|---|---|---|---|---|
| KNYC | 32 | 6 (19%) | **24** | 2 | **−1.07°F** |
| KORD | 35 | 8 (23%) | 13 | **14** | **+0.78°F** |
| KLAX | 36 | 12 (33%) | 21 | 3 | −0.67°F |
| KAUS | 29 | 9 (31%) | 15 | 5 | −0.23°F |
| KMIA | 31 | 16 (52%) | 11 | 4 | −0.23°F |
| KDEN | 31 | 8 (26%) | 16 | 7 | +0.01°F |

**The per-station actual-value offset correlates almost perfectly with per-station PnL:**

| Station | Avg offset | Paper PnL |
|---|---|---|
| KNYC | −1.07°F | **−$69.16** |
| KORD | +0.78°F | **−$70.00** |
| KLAX | −0.67°F | **−$25.00** |
| KAUS | −0.23°F | +$15.00 |
| KMIA | −0.23°F | +$41.35 |
| KDEN | +0.01°F | +$25.00 |

The mechanism: `recomputeStationBias` computes `meanBias = mean(forecast − actual_value)` against these corrupted actuals. KNYC's stored bias is **+1.04°F** — almost exactly its **−1.07°F** actual-value corruption. The "bias" we subtract at KNYC is an artifact of bad ground truth, not real forecast error. Result: corrected means run ~1°F cold at KNYC (and ~1°F hot at KORD), which is **half a bracket width** — enough to move the model's favorite bracket off the market's favorite bracket, generating the contra-market NO bets that lose 80% of the time. `stdBias` (the empirical sigma) is likewise inflated by this noise.

Likely root causes in `fetchNwsActualValue` (reconciliation.ts:1066-1135):
1. **Max-of-hourly-observations undersamples the true peak.** Kalshi settles on the official NWS climate report (CLI), which uses continuous data. Hourly obs miss the actual max by 0.5–2°F. KNYC (Central Park) has notoriously sparse obs.
2. **UTC-day windowing.** The backfill queries `{date}T00:00:00Z → T23:59:59Z` — for US stations that includes the *previous* local evening (00–06Z) and clips the end of the local day. KORD's "+0.78 too hot" pattern is consistent with previous-evening contamination during frontal passages.
3. **Possibly premature backfill** — if backfill runs before the local day's peak is in the obs feed.

### Finding 2 — Event-level probabilities are incoherent: bracket probs sum to 0.79–1.69

For mutually-exclusive, exhaustive bracket sets of one event, model probabilities must sum to ~1. Sampled June-5 ticks:

| Event | Brackets | Σ p(YES) |
|---|---|---|
| KXHIGHAUS-26JUN05 | 8 | **1.69** |
| KXHIGHNY-26JUN05 | 8 | **1.68** |
| KXHIGHLAX-26JUN05 | 8 | 1.52 |
| KXHIGHMIA-26JUN05 | 8 | 1.32 |
| KXHIGHCHI-26JUN05 | 8 | **0.79** |
| KXHIGHDEN-26JUN05 | 8 | 0.80 |

Causes: the per-bracket tail floor (1–3% × 8 brackets), the historical-prior blend pulling every bracket toward a 20–50% baseline, and per-market independent estimation. ~70pp of phantom probability mass spread across the wings means **wing brackets carry inflated YES estimates and the peak bracket carries a deflated one** — precisely the pattern of the losing book (NO on the peak, occasionally YES on wings).

### Finding 3 — The bot stacks correlated NO positions within one event

Up to **4 concurrent NO positions in the same event** (KXHIGHNY-26MAY05, KXHIGHMIA-26MAY28, KXHIGHAUS-26MAY25 — all `no,no,no,no`). Since exactly one bracket resolves YES, NO bets near the model's (mis-anchored) mean are strongly correlated — when the mean is wrong, several lose together. There is no event-level exposure limit anywhere in execution.

### Finding 4 — Edge is measured against the last trade price, not the book

`feed.ts` receives `yes_bid` / `yes_ask` in every ticker message and **discards them**, storing only `price` (last trade). All signal edges and paper fills use `last_yes_price`:
- A stale last-trade on a thin market manufactures phantom edge (the book may have moved long ago).
- Paper fills assume we transact *at* last price with zero spread cost; live limit orders at that price would often not fill, or fill only when the market moves through us (adverse selection). Paper results are optimistic by roughly half the spread per trade.

### Finding 5 — Same-day observation logic can reinforce the corrupted mean

The observation adjustment compares the obs-implied high (obs + diurnal offset) to the bias-corrected mean; "agreement" → tighten sigma around that mean. Because the mean itself is mis-anchored (Finding 1), agreement-tightening makes the bot *more* confident in a wrong number. Example KNYC 2026-06-04 17:27Z: obs 84.0°F at 1:27pm local, diurnal offset +3 → implied high 87. Corrected mean 85.8. Divergence 1.2 < 2 → "agree", tighten sigma → p(YES on 86.5–87.5) = 0.34 → bet NO at market 0.80 → official high ≥86.5, **lost**. Additional gaps: the single latest obs is used (not the day's running max, which is a *hard floor* on the high), and there is no obs max-age check (`getLatestObservation` takes the first non-null of 6 with no staleness guard).

### Finding 6 — HRRR can silently vanish from the pool

HRRR fetch failures log at `debug` level and fall through to ensemble-only estimates (ensemble.ts:164-166). Nothing records which sources fed a given estimate — there is no way to know whether the bot's worst days were HRRR-less days. At <6h horizon HRRR is supposed to be 70% of the pool; its silent absence reshapes every probability.

### Finding 7 — The sniper-window cache invalidation in the docs was never built

`forecast-sharpening.md` §2 specifies: *"The sniper window should trigger a forced cache invalidation for weather data."* The code has no such invalidation — `getEnsembleValues` always serves the 6h-TTL cache if present. Measured at trade time: ensembles up to **3.2h old** on same-day sniper entries. The non-HRRR ~30% of the pool can be from a meteorologically different world by afternoon.

### Finding 8 — Exits are net-positive but cap winners

Counterfactual on all 79 settled dry-run exits: 65 exited positions would have **won** at settlement (avg exit price 88.6¢ — foregone ≈ $107), 14 would have lost (avg exit 77.5¢ — saved ≈ $176). Net exits save ~$69, so the logic stays — but a "let confirmed winners ride to settlement" carve-out recovers most of the $107 without giving back the $176.

### Finding 9 — Coin-flip markets are a structural dead zone

78 trades entered with the market at 45–55¢ won 48.7% (−$13.77): pure coin flips minus spread. These are days when the official high straddles a bracket edge and *nobody* knows the answer. Without an information edge (post-peak obs anchor), these are unwinnable; with one, they're the best trades on the board. Current gates don't distinguish.

### Finding 10 — Entry-hour analysis confirms the midday information deficit

| UTC hour | Trades | Win % | PnL |
|---|---|---|---|
| 16Z | 2 | 50.0% | +$7.00 |
| 17Z | 54 | 38.9% | +$33.77 |
| **18Z** | 40 | **27.5%** | **−$80.96** |
| 19Z | 37 | 35.1% | −$10.00 |
| 20Z | 41 | 34.1% | −$7.62 |
| 21Z | 19 | 36.8% | +$10.00 |
| 22Z | 7 | 0.0% | −$35.00 |

The 18–20Z band (midday local) is where the bot bleeds: too late for the morning HRRR edge, too early for the obs running-max to pin the answer, while the market has already priced the afternoon trajectory.

---

## New action items

Ordered by impact-per-effort. Items N1–N3 attack root causes; N4–N7 fix the information pipeline; N8–N12 are hardening.

### N1. Settlement-truth ground-truth repair ⭐⭐ HIGHEST IMPACT OF ANY ITEM IN EITHER DOC
**Impact:** Removes the ~1°F phantom bias at KNYC/KORD/KLAX that generates the contra-market book. Fixes the empirical sigma the same way. Every downstream calibration consumer benefits.
**Effort:** 1–2 days.
**Files:** `app/engine/services/reconciliation.ts` (`fetchNwsActualValue`, `backfillActualValue`, `recomputeStationBias`), one-time migration script in `scripts/`.

**Change:**
1. **Primary truth = Kalshi settlement.** After an event settles, derive the official high from the YES bracket: `actual ∈ [bracketLow, bracketHigh)`. Store the bracket midpoint as `actual_value` with a new `actual_source = 'settlement'` column (interval-censored, but unbiased — exactly what the market pays on).
2. **Secondary truth = NWS CLI product.** Fetch the official climate report (`api.weather.gov/products`, type `CLI`, by issuing office) and parse `MAXIMUM TEMPERATURE`. Use it when available (it's the literal settlement source — gives exact values, not intervals). Settlement-interval cross-checks it.
3. **Fix the obs-feed fallback:** local-calendar-day window (station TZ) instead of UTC day; reject if the window's coverage is incomplete (backfill ran too early).
4. **Cross-check guard in reconciliation:** when `|recorded_actual − settlement_interval| > 0`, log at warn, prefer settlement, increment a `ground_truth_mismatch` counter surfaced in the TUI.
5. **One-time rebuild:** wipe `station_bias`, recompute every `weather_forecasts.actual_value` from settlement/CLI, re-run `recomputeStationBias`. Embargo empirical sigma per station until n ≥ 20 clean samples (ensemble-spread fallback already exists).

**Verification:** Re-run the Finding-1 query — `pct_inside` should go to ~100%. Stored KNYC bias should move from +1.04 toward ~0. Watch the KNYC/KORD win rates over the following week.

**Implementation status (2026-06-05):** Items 1, 3, 5 + N11 shipped. Item 2 (NWS CLI product) and the explicit cross-check warn-counter (item 4) are deferred — the settlement interval is now the primary source and the N11 telemetry (below) covers the regression alarm, so the CLI exact-value parse is no longer on the critical path.
- `reconciliation.ts`: new `deriveSettlementActual(stationId, targetDate, category)` returns the settled-YES bracket center (`bracket` → midpoint, `upper_tail` → low+0.5, `lower_tail` → low−0.5, else null). New `resolveActualValue` enforces priority **settlement → obs_max** and is used by both `backfillActualValue` (market-resolution path) and `backfillHistoricalForecastActuals` (multi-horizon path). Every write tags `weather_forecasts.actual_source` ('settlement' | 'obs_max').
- Obs fallback (`fetchNwsActualValue`) now windows on the station's **local calendar day** (new exported `localDayWindowUtc` + local `STATION_TZ`, DST-correct) and **defers** until the local day is complete (returns null otherwise, so a later pass retries) — fixing the UTC-day previous-evening contamination.
- N11 telemetry: new `checkGroundTruthHealth()` (rate-limited 1×/hr, wired into `reconcile()`) logs trailing-14d pct-inside-YES-bracket per station under the stable `ground-truth health:` prefix; warns when overall < 90%. Deliberately log-only (no `bot:error` bus event — would spam the TUI).
- One-time rebuild: `scripts/rebuild-ground-truth.ts` (`--db`, `--dry-run`). Recomputes actuals from settlement, wipes `station_bias`, re-runs `recomputeStationBias` (now public, DB-only), prints before/after pct-inside + per-station offset + the new bias table. **Run by the main thread, not the agent.**
- `recomputeStationBias` made public (DB-only, no network) so the rebuild script can call it directly. Empirical-sigma n≥20 embargo NOT added here (out of scope for N1 file ownership; tracked separately).

### N2. Event-coherent probability vector ⭐⭐ STRUCTURAL FIX
**Impact:** Eliminates the 0.79–1.69 probability-sum incoherence; deflates wing-bracket phantom edges; aligns peak-bracket estimates with reality. Makes every gate in the first plan sharper.
**Effort:** 2–3 days (estimator restructure).
**Files:** `app/signals/services/estimator.ts`, `app/engine/services/orchestrator.ts`.

**Change:**
1. Estimate **per event, not per market**: one pass computes the temperature distribution (corrected mean, sigma) for the event's (station, date), then derives all bracket + tail probabilities from that single distribution. By construction they sum to 1.
2. Apply blends **vector-wise, sum-preserving**: historical-prior and market-prior blends operate on the full vector against the market's normalized price vector (strip the overround: `pMarket_i / Σ pMarket`), then renormalize after the tail floor.
3. Phase 3 evaluates the event's brackets jointly and emits **at most one signal per event** — the argmax-edge bracket — instead of independent signals per bracket.

**Verification:** Re-run the Finding-2 query — sums within 0.98–1.02. Trade log shows ≤1 position per event.

**Implementation status (2026-06-05):** ✅ Shipped (estimator + orchestrator), behind the `event_coherent_estimation` kill switch (default true; false = byte-identical legacy per-market path).
- `estimator.ts`: new `estimateEvent(eventMarkets, ensembleValues, observation?, marketPrices?, sourceMix?) → Map<ticker, EstimateResult>`. Computes ONE shared temperature distribution per event (bias → corrected mean → sigma blend → **event-level sigma floor** = `sigmaFloorBracketWidthFactor × medianRegularBracketWidth` (tail-only events fall back to 1.0) → observation adjustment, all applied once — per-market floors/means would break vector coherence). Raw vector from that distribution: `coverage = Σ raw` (≈1 over a partition; <1 with listing gaps, **preserved** — gap mass is never forced to 1). Historical prior inflates per market then **renormalizes back to coverage**; market prior de-vigs the book (`pMkt_i/Σ pMkt × coverage`) and blends with **one event-level weight** ramped by total-variation distance `TV = 0.5·Σ|pModelNorm − pMktNorm|` through the existing ramp knobs — sum-preserving over the priced slots (unpriced markets keep their model value and are excluded from the de-vig denominator). Tail floor → renormalize → final per-market clamp (no post-clamp renorm — it binds rarely; the `eventCoherence` trace catches drift). Confidence computed once (identical across the event).
- The bracket/tail CDF integral, member counting, and size-weighted blend are factored into shared module helpers (`countMembersInMarket`, `cdfProbForMarket`, `cdfBlendWeight`, plus `medianRegularBracketWidth`) called by BOTH `estimate()` (legacy, unchanged behavior — all prior tests green) and `estimateEvent()`, so the two paths share one implementation of the load-bearing math.
- `ReasoningTrace.eventCoherence?: {eventTicker, markets, rawCdfSum (=coverage), finalSum, eventBlendWeight (TV-ramped weight or null)} | null` — null on the legacy path; populated per market on the event path. `|finalSum − coverage| > 0.05` logs at info.
- `orchestrator.ts` Phase 2: `activeMarkets` grouped by `eventTicker`; per group ONE `getEnsembleWithSources` (at the group's **min** forecast horizon), one observation lookup (existing per-station cache), one `marketPrices` map (via `marketMid`), then `eventCoherentEstimation ? estimateEvent(group, …) : legacy per-market loop`. Each market's result is pushed into `estimates` unchanged (Phase 3 + exit-eval consume per-market entries as before).
- `orchestrator.ts` Phase 3: after the ladder loop, before execution — **argmax-per-event** over `buy_yes`/`buy_no` signals only. Exported pure helpers `selectArgmaxPerEvent(signals) → {kept, demoted}` and `argmaxSkipReason(winner, loser)`; losers' DB rows set `recommendation='skip'`, `acted=false`, `skipReason="event argmax: <winning-ticker> has higher edge (X.X¢ > Y.Y¢)"` and removed from `actionableSignals`. `confirm_yes`/`confirm_no` exempt (jointly coherent — at most one bracket pays). `ActionableSignal` gained `eventTicker`.
- Tests: `estimator.test.ts` +14 (partition→sum 1, prior no-inflate, vector market blend moves peak + preserves sum, gap preservation, single-market≈estimate(), tail-only fallback, confidence-identical, median-width helper, guards); `orchestrator-argmax.test.ts` +10 (pure helper: per-event argmax, cross-event independence, confirmation exemption, tie-stability, skip-reason format). Full suite 605 green (was 581). Typecheck unchanged at 358 pre-existing errors.

### N3. Observation running-max anchor (replace the diurnal blend) ⭐⭐
**Impact:** Converts same-day obs from a sigma tweak into the bot's strongest structural information edge; directly attacks the 18–20Z dead zone and makes coin-flip markets winnable late-day.
**Effort:** 1–2 days.
**Files:** `app/data/services/nws.ts`, `app/signals/services/estimator.ts`, `app/engine/services/orchestrator.ts`.

**Change:**
1. Fetch **all of today's observations** (local-day window), not the latest single reading; compute `runningMax`.
2. **Hard floor:** the daily high cannot be below `runningMax`. Truncate the estimator's distribution at `runningMax` (renormalize mass below it to zero). This is exact information the diurnal-offset heuristic throws away.
3. **Post-peak collapse:** after ~16:00 local (configurable `obs_peak_hour`), the high ≈ `runningMax + ε`; collapse sigma to ≤0.7°F and center on `runningMax + 0.3°F`. Pre-peak, keep the current implied-high logic but compare against the *repaired* mean (N1).
4. **Staleness guard:** reject observations older than 90 min; if obs are stale inside the sniper window, skip same-day signals for that station this tick (data-quality gate).

**Verification:** Replay June 1–5 losing afternoons — with truncation at the 18Z running max, p(YES) on the market-favorite bracket should jump above 50%, flipping or killing the contra-NO signals.

**Implementation status (2026-06-05) — data layer only:** The NWS observation data layer (item-N3 step 1) is shipped in `app/data/services/nws.ts`; the estimator/orchestrator wiring (steps 2–4) is a separate later slice and is NOT done here.
- New `NwsService.getTodayObservations(stationId, now = new Date()): Promise<TodayObservations | null>`. Fetches `GET /stations/{id}/observations?start={localDayStartUTC}&end={nowUTC}&limit=100`, converts Celsius → Fahrenheit (existing `* 9/5 + 32` convention), and returns `{ runningMax, latest: { tempF, timestamp }, latestAgeMinutes, count }`. `runningMax` = max of non-null temps (the hard floor); `latest` = newest by timestamp (does not assume feed ordering); `latestAgeMinutes` is measured against the injected `now` (testable staleness); `count` = usable (non-null) obs. Returns `null` on zero usable obs / empty features / all-null temps / non-OK HTTP / fetch rejection (logs at `debug`, never throws). `getLatestObservation` left untouched (estimator still uses it until N3 integration lands).
- New exported pure helper `localDayStartUtc(dateNow: Date, tz: string): Date` — the UTC instant of the local-calendar-day midnight containing `dateNow`, DST-correct via `Intl.DateTimeFormat` parts (NOT fixed offsets). For US Eastern this lands 04:00Z (EDT) / 05:00Z (EST); Pacific 07:00Z (PDT) / 08:00Z (PST); Mountain 06:00Z (MDT). Used to build the query's `start` bound and exported so the window math is unit-testable in isolation.
- New local `STATION_TZ` map in `nws.ts` (KNYC/KMIA/KPHL/KATL → America/New_York; KORD/KAUS/KIAH/KDFW → America/Chicago; KDEN → America/Denver; KLAX/KSFO → America/Los_Angeles; default America/New_York). **Intentionally duplicated** — reconciliation.ts (@kcb/engine) and estimator.ts (@kcb/signals) carry their own copies; @kcb/data must not import from engine/signals (dependency direction). A future `shared/` extraction is welcome but out of scope.
- Re-exports added to `app/data/index.ts`: `localDayStartUtc` (value) and `TodayObservations` (type).
- Tests: `app/data/services/nws.test.ts` (+17, all green) — runningMax over multiple obs (71/74/73 → 74, latest = newest not max, count); newest-by-timestamp with an oldest-first feed; local-day windowing asserts the `start`/`end`/`limit` query params (EDT 04:00Z, PDT 07:00Z, plus default-tz fallback); `localDayStartUtc` pure-helper EDT/EST/PDT/MDT + a prior-UTC-day-evening roll-back case; staleness `latestAgeMinutes` vs injected `now`; null cases (empty features, all-null temps); null-temp skipping with usable-obs aggregation; null (not throw) on 429 and on fetch rejection; C→F conversion. Full `bun test` green (564 baseline + 17), `bun run typecheck` adds zero new errors.

### N4. Bid/ask capture + spread-aware edge & entry ⭐
**Impact:** Kills phantom edges from stale last-trade prices; makes paper fills honest; tightens live execution.
**Effort:** 1 day.
**Files:** `app/engine/services/feed.ts`, `packages/db/src/schema/markets.ts` (+migration), `app/engine/services/orchestrator.ts`, `app/execution/services/execution.ts`.

**Change:**
1. Store `yes_bid` / `yes_ask` (already arriving on the ticker feed) on `markets`.
2. Signal evaluation: `marketPrice = mid = (yesBid + yesAsk) / 2 / 100` when both sides exist; skip the market when the book is one-sided or `spread > max_spread_cents` (default 10¢).
3. Edge for an entry is computed against the price we'd actually pay: ask for YES, `100 − bid` for NO.
4. Paper fills execute at the crossing price (not last trade) — honest slippage.

**Verification:** Distribution of `signals.edge` should shrink on thin markets; paper PnL per trade drops by ~spread/2 (more honest), live/paper divergence narrows.

**Implementation status (2026-06-05):** Items 1, 3, 4 shipped on the execution side; item 2 (signal-eval `marketPrice = mid`, one-sided-book skip) remains for the orchestrator/estimator path.
- `feed.ts` ticker handler now writes `yesBid`/`yesAsk` (null-tolerant) alongside last price on every `markets` update (migration 0005 columns).
- `execution.ts::executeSignal` does a per-signal `markets` book lookup after the anti-churn guards. **Spread guard:** both sides present and `yesAsk − yesBid > maxSpreadCents` (10; 0 = disabled) → skip `spread N¢ > max M¢` (applies to confirmation entries too). **Crossing-price entry:** YES pays `yesAsk`, NO pays `100 − yesBid`, clamped to [1,99]; falls back to the prior last-trade-derived price (`round(marketPrice·100)` / inverse) when the needed side is null. Kelly EV math still uses `signal.marketPrice` (probability) — only the *limit price we pay* moved to the book.
- Tests: `feed.test.ts` (+3, bid/ask persistence + null tolerance + overwrite), `execution.test.ts` (+spread guard on/off, YES-ask, NO-100−bid, book-absent fallback).

### N5. Source attribution + HRRR data-quality gate ⭐
**Impact:** Makes the 70%-weight short-horizon source auditable; stops the bot from sniping with a degraded pool.
**Effort:** 0.5–1 day.
**Files:** `app/data/services/ensemble.ts`, `app/signals/services/estimator.ts` (ReasoningTrace).

**Change:**
1. `getEnsembleValues` returns a `sourceMix` (`{hrrr: n, gfs: n, ecmwf: n, icon: n, gem: n, arpege: n, tomorrowIo: n}`) persisted into `ReasoningTrace`.
2. HRRR fetch failure inside the sniper window logs at **warn** and emits a bus event.
3. New gate: when `forecastHorizonHours <= 12` and `sourceMix.hrrr === 0`, skip the signal with `skip_reason = "hrrr unavailable in sniper window"` (configurable `require_hrrr_in_sniper`, default true).

**Verification:** Query reasoning traces by sourceMix; win-rate split HRRR-present vs absent becomes measurable (and actionable).

**Implementation status (2026-06-05):** ✅ Fully shipped — data layer (`ensemble.ts` + `estimator.ts`) plus the orchestrator ladder gate (skip contrarian sniper-window signals when `sourceMix.hrrr === 0` under `require_hrrr_in_sniper`; confirmation entries deliberately exempt — their information source is the market itself).

**🔥 Discovery (2026-06-05, the moment the warn logging went live):** HRRR **has never worked**. `fetchHrrr` requested `models=hrrr_conus`, which Open-Meteo rejects with HTTP 400 (`Cannot initialize MultiDomains from invalid String value hrrr_conus`) — and the failure was swallowed at debug level. The correct model id is `gfs_hrrr` (fixed same day, verified against the live API). **The bot's entire trading history ran HRRR-less**: the source designed to be 40–70% of the sniper-window pool contributed zero members to every estimate ever made. This retroactively explains part of why "forecast sharpening" never closed the Brier gap (the 2026-04-13 analysis measured our Brier flat at 0.161 while the market sharpened 14× — we were sharpening without the sharpest input). Finding 6's hypothesis ("we can't tell if losing days were HRRR-less") resolves to: they all were.
- New public `EnsembleService.getEnsembleWithSources(stationId, targetDate, category, horizonHours?)` returns `{ values: number[]; sourceMix: Record<string, number> }`. `getEnsembleValues` is now a thin back-compat wrapper returning just `.values` (existing orchestrator/reconciliation callers unchanged).
- **sourceMix label semantics** (documented in JSDoc): on the **fresh-fetch path** every member carries a real model tag, so the mix is authoritative — `{hrrr, gfs, ecmwf, icon, gem, arpege, tomorrow_io, other}` with counts taken AFTER horizon weighting/duplication and **summing to `values.length`**. Tomorrow.io members are tagged `tomorrow_io` (was lumped into `other`) so they report separately; they still draw the `other` horizon weight. On the **DB-cache path** the cached pool is an untagged `number[]`, so it is reported honestly as `{cached: n}` — we do NOT invent per-model attribution — plus an accurate `hrrr` count for any fresh HRRR blended on top. `cached` is the label the orchestrator treats as **hrrr-unknown**. The all-APIs-failed synthetic path reports `{synthetic: n}`.
- HRRR fetch failure **inside the sniper window** (`horizonHours <= bot.sniperHorizonHours`, both the fresh-fetch and cached-base+fresh-HRRR paths) now logs at **`log.warn`** with the stable, greppable substring **`hrrr unavailable in sniper window`** (orchestrator's `requireHrrrInSniper` gate keys on this). Outside the sniper window it stays at `debug` (far-horizon warm passes don't expect HRRR). The bus event is implicit — `createLogger`'s warn already emits a `"log"` bus event at `level: "warn"`.
- `ReasoningTrace.sourceMix?: Record<string, number> | null` added; `estimate(market, ensembleValues, observation?, marketPrice?, sourceMix?)` gained an optional 5th param stored verbatim into the trace (null when absent). No existing call site changed; sourceMix does not affect any computation.
- Tests: `ensemble.test.ts` +11 (per-source counts sum to `values.length`; fresh per-model mix; cached `{cached:n}` + fresh-HRRR blend; both-cached `{cached,hrrr}`; `getEnsembleValues` back-compat array; HRRR-warn greppable string fires inside sniper / not outside), `estimator.test.ts` +1 (trace carries sourceMix when provided, null otherwise).

### N6. Sniper-entry cache invalidation (close the docs/code gap)
**Impact:** Ensures the freshest full ensemble at decision time, not just fresh HRRR on a 6h-old base.
**Effort:** 0.5 day.
**Files:** `app/data/services/ensemble.ts`, `app/engine/services/orchestrator.ts`.

**Change:**
1. Track per-(station, targetDate) whether the market has entered the sniper window; on first entry, force-refresh the ensemble (bypass cache once).
2. Reduce ensemble cache TTL to 2h when `targetDate == today` (6h is fine for scout-mode horizons).

**Verification:** `ensemble_age_hours` at trade time (Finding-7 query) ≤ 2h for all sniper entries.

**Implementation status (2026-06-05):** ✅ Shipped in `ensemble.ts` (both items, inside `getEnsembleWithSources`; JSDoc references this finding — "docs promised forced invalidation at sniper entry; measured 3.2h-stale ensembles at trade time").
1. **Same-day TTL:** when `targetDate` equals today (UTC `YYYY-MM-DD` compare, matching how the file already derives horizons) the ensemble cache TTL is `bot.sameDayEnsembleTtlHours` (default 2h) instead of the standard `CACHE_TTL_MS` (6h). Future-day (scout) horizons keep 6h. HRRR's 1h sidecar TTL is unchanged.
2. **Sniper-entry forced refresh:** a module-level `Map<string, boolean>` keyed `${stationId}:${targetDate}` tracks first entry. When `horizonHours != null && horizonHours <= bot.sniperHorizonHours` and the key hasn't been refreshed this process, the ensemble cache is **bypassed exactly once** (fresh full pool fetched), then the key is marked so subsequent ticks serve the now-fresh cache normally. Keys for past dates are pruned opportunistically on insert. Exported `resetSniperRefreshTracking()` clears the map (test/ops hook; also re-exported from `@kcb/data`).
- Config reads go through a `botConfigNum` helper that falls back to the documented defaults (2h / 12h) when `@kcb/config` is mocked/partial in tests (Bun `mock.module` leaks process-wide and several files omit the newer bot keys) — prevents a `NaN` TTL.
- Tests (in the N6 block of `ensemble.test.ts`): same-day row cached 3h ago → stale → re-fetch; 1h-old → served (zero network); first sniper call bypasses a *fresh* cache once (open-meteo hit), second serves cache (no re-fetch), `resetSniperRefreshTracking()` re-arms the bypass.

### N7. Coin-flip dead-zone gate
**Impact:** Removes the 78-trade / 48.7% / −$14 segment unless we hold an information edge there.
**Effort:** 0.5 day (pure gate).
**Files:** `app/signals/services/entry-gates.ts`, orchestrator ladder.

**Change:** Skip signals where the market mid is in [0.40, 0.60] **unless** the N3 obs anchor is active (post-peak collapse engaged or running-max truncation moved the estimate by >5pp). `skip_reason = "coin-flip market, no obs anchor"`.

**Verification:** Re-run the market-band win-rate query after a week — the 0.45–0.55 band should be near-empty or >70% win.

**Implementation status (2026-06-05):** ✅ Shipped (unconditional form) as part of the entry-gate bundle — `coin_flip_zone_low/high` (0.40/0.60) in `evaluateEntryGates`. The obs-anchor carve-out is intentionally deferred until N3 lands (noted in the gate's JSDoc).

### N8. Let-confirmed-winners-settle exit carve-out
**Impact:** Recovers most of the ~$107 foregone on the 65 exits of would-be winners while keeping the $176 of dodged losses.
**Effort:** 0.5 day.
**Files:** `app/engine/services/exit-eval.ts`.

**Change:** Suppress edge-reversal and time-decay exits when (a) our side's market price ≥ 90¢ AND (b) hours-to-close ≤ 6 AND (c) the position is in profit. Stop-loss continues to fire regardless. Config: `exit_hold_winner_price` (default 0.90).

**Verification:** Exit counterfactual (Finding-8 query) — "exit_was_mistake" count should drop sharply; net saved should rise above the current ~$69.

**Implementation status (2026-06-05):** ✅ Shipped — `evaluateExit` winner-hold carve-out behind optional `exitHoldWinnerPrice` / `exitHoldWinnerMaxHoursToClose` config (defaults 0.90 / 6h), wired through the orchestrator's exit call. Stop-loss path untouched; 8 new tests cover hold/fire boundaries and back-compat.

### N9. Per-station auto health gate (hysteresis)
**Impact:** Self-healing version of the first plan's manual station disable — uses settlement outcomes only (immune to Finding-1 corruption).
**Effort:** 1 day.
**Files:** `app/signals/services/adaptive-threshold.ts` or new `station-health.ts`, reconciliation.

**Change:** Rolling 30-day settled win rate per station: < 45% → auto-disable (skip_reason `"station health gate"`); ≥ 55% over the trailing 15 trades → re-enable. Persist state to `runtime_config` so it survives restarts and is REPL-visible.

**Verification:** With current data the gate would disable KORD/KLAX/KNYC on day one — matching the manual intent, but reversible by evidence.

### N10. Paper-fill realism
**Impact:** Makes the 80% target measured on paper transfer to live.
**Effort:** 0.5 day (after N4).
**Files:** `app/execution/services/execution.ts`.

**Change:** Dry-run fills execute at the book's crossing price with a 1-tick adverse markup, and only when `ask − bid ≤ max_spread_cents`. Tag orders with `fill_model = 'book_v1'` so eras are comparable.

**Verification:** Paper round-trip PnL per trade drops by the realistic spread cost; no change in signal logic.

**Implementation status (2026-06-05):** Shipped via the N4 crossing-price change — dry-run entry fills now execute at the book's crossing price (ask for YES / `100 − bid` for NO) instead of the zero-spread last trade, gated by the same `maxSpreadCents` check. The explicit 1-tick adverse markup and a persisted `fill_model = 'book_v1'` tag were **not** added (no schema change in scope for this slice); the crossing price already carries the realistic spread cost. Add the era tag later if paper-era comparability is needed.

### N11. Ground-truth mismatch telemetry (permanent regression alarm)
**Impact:** Finding 1 went undetected for ~3 months; make its recurrence impossible.
**Effort:** Bundled with N1.
**Files:** reconciliation + TUI performance view.

**Change:** Every reconcile cycle recomputes the rolling 14-day `pct_inside` (recorded actual within settled YES bracket) per station; < 90% → warn log + bus event + TUI badge.

**Implementation status (2026-06-05):** Shipped as `reconciliation.checkGroundTruthHealth()` (see N1). Rate-limited to 1×/hr rather than every cycle (the metric moves slowly). Log-only via the `ground-truth health:` prefix — the bus-event + TUI badge were intentionally dropped to avoid spamming the TUI; the log line is queryable. Re-add a TUI badge later if desired.

### N12. Entry-window tuning experiment (data collection, no behavior change yet)
**Impact:** Quantifies whether 18–20Z entries should be suppressed outright or simply fixed by N3.
**Effort:** Trivial once N5/N10 land.

**Change:** Tag signals with local-hour band at entry; after 2 weeks of N1+N3 running, re-cut win rate by band. Only add an hour gate if the deficit survives the obs-anchor fix (avoid stacking gates on the same root cause).

---

## Sequencing with the first plan

```
Week 1: N1 (ground truth) + first plan #1/#3/#7 (gates)     ← stop the bleeding + fix the foundation
Week 2: N2 (coherent vector) + N4 (bid/ask) + N6 (cache)    ← honest probabilities vs honest prices
Week 3: N3 (obs anchor) + N5 (attribution) + N7 (dead zone) ← build the real information edge
Week 4: first plan #2 (confirmation mode) + N8–N11          ← add volume + harden
```

Rationale: the first plan's gates are pure subtraction and deliverable immediately, but its estimator items (#4 sigma floor, #5 hit-rate fix, #6 confidence) should land **after** N1/N2 — recalibrating against corrupted ground truth and incoherent vectors would lock in the wrong constants.

## Measurement

Lock the baseline before any change ships (same protocol as the first plan §6):

```sql
-- Win rate (paper, settled)
SELECT COUNT(*), SUM(m.result = o.side), ROUND(100.0*SUM(m.result = o.side)/COUNT(*),1)
FROM orders o JOIN markets m ON o.ticker=m.ticker
WHERE o.action='buy' AND o.status='filled' AND o.dry_run=1 AND m.result IN ('yes','no')
  AND o.created_at >= '<ship-date>';

-- Ground-truth health (must trend to ~100 after N1)
-- (Finding-1 query, by month)

-- Event coherence (must trend to 1.0 after N2)
-- (Finding-2 query)
```

Success criteria per phase: ground-truth `pct_inside ≥ 95%`, event sums 0.98–1.02, then a 30-trade rolling win rate ≥ 80% with ≥ 2 weeks of stability before any live-capital discussion.
