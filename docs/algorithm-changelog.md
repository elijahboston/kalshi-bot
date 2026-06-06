# Algorithm Changelog

Chronological record of changes to the climate bot's decision-making — the **estimator** (probability), **sizing** (Kelly / flat / tier), **execution gates** (guards on order placement), and the **calibration feedback loop**. Newest first.

Each entry is intentionally terse — one line per change, with `Why:` and a link to the improvement doc for full mechanics, math, and verification. UI, infra, and Bun-migration changes are out of scope; see [`spec.md`](spec.md) for the broader feature index.

**Areas:** `estimator` · `sizing` · `execution` · `calibration` · `discovery`

---

## 2026-06-06

### `execution` — Confirmation exit policy + over-sell guard (first-live-night fixes)
- **Change:** (1) `evaluateExit` gains `entryKind`: positions entered via `confirm_yes`/`confirm_no` are exempt from edge-reversal and time-decay exits (their model edge is ≤ 0 **by design** — the thesis is "the market is right", not "the model sees edge"); they hold to settlement with stop-loss intact plus a new bail-out when our side's price drops below `confirmation_exit_conviction_floor` (0.60) — the market's conviction, our entire thesis, has collapsed. Orchestrator resolves entryKind from the position's most recent filled buy → originating signal. (2) `executeExit` now computes **net-held from the orders ledger** (same source of truth as the buy path) and clamps the sell quantity; net ≤ 0 skips the exit entirely.
- **Why:** First live night (2026-06-05): edge-reversal fired one tick after every confirmation entry (edge −0.30 < threshold), and the dry-run pending-sell guard is blind (paper sells fill instantly, never 'open') while the positions row lags reconciliation — so exits **double-fired**, selling 6 then 6 again into a phantom short, then cooldown expired and the bot re-bought. Four winning confirmation positions were churned into realized losses + bogus shorts. Both holes closed; the 4 trades would have settled 4/4 WIN.
- **Doc:** [`improvements/win-rate-80-plan-2026-06-05.md`](improvements/win-rate-80-plan-2026-06-05.md) (#2 — exit policy completion)

## 2026-06-05

### `estimator` — Observation running-max anchor: CLAMP the distribution + post-peak collapse (N3 estimator/orchestrator)
- **Change:** Same-day `high_temp` observations become a structural information edge, not a sigma tweak. The settled high is `H = max(X, runningMax)`, so the forecast distribution is **clamped** (NOT renormalized-truncated) at the day's observed running max: all mass below `runningMax` folds onto the point `runningMax`. Implemented in the shared bracket/tail integral (`cdfProbForMarket`, new optional `runningMax`) and member counting (`countMembersInMarket`, clamp each member to `max(member, rm)`), so BOTH `estimate()` and `estimateEvent()` get it and the event vector stays coherent automatically (a partition's clamped slices still sum to coverage ≈ 1). Clamp math: bracket `clampedCdf(hi) − clampedCdf(lo)` where `clampedCdf(x) = x < rm ? 0 : Φ((x−μ)/σ)`; lower tail `< th` = 0 when `th ≤ rm`; upper tail `> th` = 1 when `th < rm`. A shared `applyObservationAdjustment` helper (gated on obs present + fresh + `high_temp`) runs: **(1) staleness guard** — `latestAgeMinutes > obsMaxAgeMinutes` (90) ⇒ ignore the obs entirely (no shift/collapse/clamp), trace `obsStale=true`; **(2) post-peak collapse** — local hour ≥ `obsPeakHour` (16) + running max present ⇒ `corrMean = runningMax + obsPostPeakMeanOffset` (0.3), `sigmaUsed = obsPostPeakSigma` (0.7), which may legitimately go below the plan-#4 sigma floor; **(3) pre-peak** — the existing diurnal implied-high logic unchanged; **(4) clamp** at `runningMax` regardless of pre/post peak. `ObservationAdjustment` extended (`runningMax?`, `latestAgeMinutes?`, `obsCount?`; all optional/back-compat). `ReasoningTrace.observationAdjustment` gains `{runningMax, postPeakCollapse, latestAgeMinutes}`; new top-level `obsStale`. Orchestrator Phase 2 now builds the obs from `getTodayObservations` (running max + staleness) instead of `getLatestObservation`; Phase 3 adds a contrarian-only ladder branch after the HRRR gate — same-day `high_temp` in the sniper window with missing/stale obs ⇒ `skipReason = "no same-day obs in sniper window"` / `"obs stale (Xm > 90m) in sniper window"` (confirmation entries exempt, same rationale as the HRRR gate).
- **Why:** Addendum Finding 5 — the old logic compared an obs-implied high to the (mis-anchored) mean and *tightened* sigma on "agreement", making the bot more confident in a wrong number, while throwing away the running max (a hard floor on the high) and never checking obs age. Findings 9/10 — the 18–20Z midday band bleeds (-$81 at 18Z, 27.5% win) because it is too late for the morning HRRR edge and too early for the obs to pin the answer; coin-flip 45–55¢ markets are unwinnable without an information edge. The running-max clamp + post-peak collapse converts the afternoon obs into the bot's strongest same-day edge: on a confident contra-market NO, the clamp lifts P(YES) on the market-favorite bracket above 50%, killing the false NO.
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (Finding 5, N3; geometry-safe per Finding 11)

### `discovery` — Bracket geometry was half-width: parse the true settlement interval from titles (Finding 11)
- **Change:** New `parseBracketFromTitle` derives temperature-market bounds from the title's rounded-integer settlement semantics — "87-88°" → **[86.5, 88.5)** (2°F; the ticker's B-number is the *midpoint*), "<87°" → threshold 86.5, ">94°" → 94.5. The legacy parse (`bracketLow = B-number, bracketHigh = +1`) stored every bracket at HALF its true width and every tail 0.5°F off. One-time `scripts/fix-bracket-geometry.ts` migrated all 1,584 temperature rows (0 unparseable, corrected intervals tile each event exactly); `rebuild-ground-truth.ts` re-derived settlement actuals + `station_bias` v3 (midpoints −0.5°F; KNYC +0.53 → +0.99).
- **Why:** Found minutes after N2's coherence telemetry went live: a complete 6-market partition summed to 0.79. Every CDF integral had been running over half the true interval — a high of 87.0 resolves B87.5 YES while the model thought it was *outside the bracket*. The deepest mechanical root of the systemic NO-overconfidence, beneath both the ground-truth corruption (N1) and the never-working HRRR (N5). Post-fix live verification: **all 12 active events sum to exactly 1.000**.
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (Finding 11 / N13)

### `estimator` — Sigma floor at fraction of bracket width (plan #4)
- **Change:** `sigmaUsed = max(sigmaUsed, sigma_floor_bracket_width_factor × bracketWidth)` (default 0.6; tails width 1.0; event mode uses the median regular-bracket width). Applied before observation adjustments — post-peak obs knowledge (N3) may deliberately go below it. Zero-spread ensembles no longer claim near-certainty. Trace gains `sigmaFloorApplied`.
- **Why:** The empirical-sigma blend is fit on the bias window's own residuals and can collapse below the bracket scale, making the CDF mechanically overconfident when the mean sits just outside a tight bracket — the "mean 1°F out → 15% YES" trap behind the contra-market NO book.
- **Doc:** [`improvements/win-rate-80-plan-2026-06-05.md`](improvements/win-rate-80-plan-2026-06-05.md) (#4)

### `estimator` — Event-coherent probability vector + argmax-per-event entries (N2 structural fix)
- **Change:** New `ProbabilityEstimator.estimateEvent(eventMarkets, ensembleValues, observation?, marketPrices?, sourceMix?)` estimates ALL brackets/tails of one event from a **single shared distribution** (bias → corrected mean → sigma blend → **event-level sigma floor** `floorFactor × median regular-bracket width` → observation adjustment, all computed once), so the returned P(YES) vector sums to the partition's `coverage` (≈1 when brackets+tails tile ℝ; <1 with listing gaps, which is preserved — gap mass is NOT forced to 1). Priors are applied **vector-wise and sum-preserving**: the historical prior inflates then renormalizes back to coverage; the market prior de-vigs the book (`pMkt_i/Σ pMkt`, then ×coverage) and mixes with **one event-level weight** ramped by total-variation distance through the existing `marketPrior{Weight,MaxWeight,RampStart,RampEnd}` knobs. Tail floor → renormalize → final per-market clamp (no post-clamp renorm). `ReasoningTrace` gains `eventCoherence {eventTicker, markets, rawCdfSum, finalSum, eventBlendWeight}`; drift > 0.05 logs at info. Confidence is computed once per event (identical across its markets). The load-bearing CDF/counting math is now shared module helpers (`countMembersInMarket`, `cdfProbForMarket`, `cdfBlendWeight`) used by BOTH paths. Orchestrator Phase 2 groups `activeMarkets` by `eventTicker` (one ensemble fetch at the group's min horizon, one observation lookup, one `marketPrices` map) and routes to `estimateEvent` when `eventCoherentEstimation` (default true), else the byte-identical legacy per-market loop. Phase 3 adds **argmax-per-event** for contrarian entries: among an event's `buy_yes`/`buy_no` signals only the highest-edge one survives; the rest are demoted to `skip` with `skipReason = "event argmax: <winning-ticker> has higher edge (X.X¢ > Y.Y¢)"` (exported pure helpers `selectArgmaxPerEvent` / `argmaxSkipReason`). `confirm_yes`/`confirm_no` are exempt — jointly coherent.
- **Why:** Addendum Finding 2 — per-market independent estimation made one event's bracket probabilities sum to 0.79–1.69; per-bracket floors and the historical-prior baseline inflated the wings while starving the peak, producing the contra-market NO book. Finding 3 — the bot stacked up to 4 correlated NO positions per event (`no,no,no,no`) with no event-level exposure limit; exactly one bracket resolves YES, so those losses were correlated. A single shared distribution makes the vector coherent by construction; argmax caps the event to one contrarian bet.
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N2)

### `estimator` — HRRR was never fetching: invalid Open-Meteo model id (root-cause fix)
- **Change:** `fetchHrrr` requested `models=hrrr_conus`, which the Open-Meteo forecast API has never accepted — every HRRR fetch returned HTTP 400 and was swallowed by a debug-level catch. Fixed to the correct id `models=gfs_hrrr`.
- **Why:** Discovered the moment N5's warn-level logging went live: the entire trading history ran HRRR-less — the source designed to be 40–70% of the sniper-window pool contributed zero members to every estimate ever made. This silently degraded exactly the short-horizon sharpness the 2026-04-14 forecast-sharpening bundle was built around. With N5's `sourceMix` attribution and the `require_hrrr_in_sniper` gate, this failure mode is now impossible to miss.
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N5 — discovery note)

### `estimator` — Ensemble source attribution + same-day TTL + sniper-entry cache refresh
- **Change:** New `getEnsembleWithSources` returns `{values, sourceMix}` — per-model member counts after horizon weighting (`{hrrr, gfs, ecmwf, icon, gem, arpege, tomorrow_io}`; DB-cached pools report `{cached: n}` honestly rather than inventing attribution). `sourceMix` persists into `ReasoningTrace`. HRRR failures inside the sniper window now log at **warn** (stable substring `hrrr unavailable in sniper window`). Same-day ensemble cache TTL drops 6h → `same_day_ensemble_ttl_hours` (2h); first entry into the sniper window forces a one-time cache bypass per (station, date).
- **Why:** Addendum Findings 6/7 — HRRR could silently vanish from the pool with no way to know which sources fed an estimate, and the docs-promised sniper cache invalidation was never built (ensembles measured 3.2h stale at trade time).
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N5, N6)

### `execution` — Mid-price evaluation + HRRR sniper gate + confirmation pathway live
- **Change:** Orchestrator Phase 2/3 integration: (1) signal evaluation and the estimator's market prior now use the **book mid** `(yesBid+yesAsk)/2` when both sides are quoted, last trade as fallback (`marketMid` helper); (2) new ladder branch skips contrarian sniper-window signals when `sourceMix.hrrr === 0` and `require_hrrr_in_sniper` is on (`skip_reason = "hrrr unavailable in sniper window"`) — confirmation entries deliberately exempt (their information source is the market itself); (3) when the contrarian ladder skips inside the sniper window, `evaluateConfirmation` can emit `confirm_yes` / `confirm_no` — market ≥80¢ conviction + model directional agreement + ≤93¢ entry, station-health honored, concordance cap deliberately NOT applied. Runtime row `confirmation_mode_enabled=true` set (paper mode).
- **Why:** Completes the win-rate-80 strategy redirection: the contrarian book is gate-stripped to its profitable core and the confirmation pathway adds the high-win-rate market-follow volume (replay: YES arm 15/15, NO arm 95.3%).
- **Doc:** [`improvements/win-rate-80-plan-2026-06-05.md`](improvements/win-rate-80-plan-2026-06-05.md) (#2), [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N4, N5)

### `execution` — Spread-aware book pricing + paper-fill realism + confirmation-mode entry
- **Change:** The ticker feed (`feed.ts`) now persists `yes_bid` / `yes_ask` onto `markets` (was discarding them). `executeSignal` looks up the book and (1) skips when both sides present and `yesAsk − yesBid > maxSpreadCents` (10; 0 = disabled) — `skip_reason = "spread N¢ > max M¢"`; (2) prices the entry at the **crossing price** — YES pays `yesAsk`, NO pays `100 − yesBid` — falling back to last-trade-derived pricing when the needed book side is absent; (3) dry-run fills now execute at that crossing price (honest slippage, N10). New **confirmation-mode** branch for `recommendation` `confirm_yes` / `confirm_no`: bypasses the Kelly EV-sign gate and the `minContractPrice` floor, sizes flat at `confirmationBetSizeCents` (500¢), caps entry at `confirmationMaxEntryPrice` (0.93; re-checked at exec time → `"confirmation entry N¢ > cap M¢"`), and records `kellyFraction = 0` to mark Kelly-bypassed sizing. Spread/positions/netHeld/cooldown/exposure guards still apply to confirmation entries.
- **Why:** Edges and paper fills were measured against the stale last-trade price, manufacturing phantom edge on thin markets and overstating paper PnL by ~½ spread/trade. Confirmation mode is the new market-follow signal path (win-rate-80 plan #2): when the model agrees with a confident 80–93¢ market, take the popular side flat — the high-win-rate volume that offsets the gate-stripped contrarian book.
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N4, N10), [`improvements/win-rate-80-plan-2026-06-05.md`](improvements/win-rate-80-plan-2026-06-05.md) (#2)

### `calibration` — Settlement-truth ground-truth repair + health telemetry
- **Change:** `backfillActualValue` / `backfillHistoricalForecastActuals` now derive `weather_forecasts.actual_value` from the **Kalshi settlement** first (YES bracket midpoint; tails → threshold ± 0.5), tagging rows with new column `actual_source` (`settlement` | `obs_max`). The NWS-observation fallback now windows on the station's **local calendar day** (DST-correct, defers until the local day completes) instead of the UTC day. New hourly `checkGroundTruthHealth()` logs trailing-14d pct-of-actuals-inside-YES-bracket per station, warning under 90%. One-time `scripts/rebuild-ground-truth.ts` repaired 480 rows and rebuilt `station_bias`: pct-inside went **30.4% → 100%**; KORD bias −0.97 → −0.07 and KNYC +1.04 → +0.53 (phantom artifact removed), KMIA −2.65 → −2.78 (real bias preserved).
- **Why:** Recorded actuals disagreed with Kalshi settlement on ~70% of days; per-station offset correlated almost perfectly with PnL (KNYC −1.07°F / −$69, KORD +0.78°F / −$70, KDEN ±0 / +$25). Bias and empirical sigma were being trained on corrupted ground truth, mis-anchoring corrected means by ~1°F (half a bracket) at exactly the losing stations — the upstream cause of the contra-market NO book.
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N1, N11)

### `estimator` — Adaptive market-prior weight (ramps with disagreement)
- **Change:** The flat `market_prior_weight` (0.3) blend now ramps to `marketPriorMaxWeight` (0.7) as `|pModel − pMarket|` grows from `marketPriorRampStart` (0.30) to `marketPriorRampEnd` (0.60). Trace gains `baseWeight` / `disagreement` / effective `weight`. Outer ship-dark gate unchanged (`market_prior_weight > 0`).
- **Why:** Flat w=0.3 left 40¢+ residual "false edges" when the model wildly disagreed with the market — exactly the trades that won 19%. Verified on the KNYC 2026-06-05 loss: raw 0.19 vs market 0.80 → old blend 0.37 (NO edge 0.43, traded, lost); new blend 0.62 (NO edge 0.18 < 0.20 threshold, correctly dropped).
- **Doc:** [`improvements/win-rate-80-plan-2026-06-05.md`](improvements/win-rate-80-plan-2026-06-05.md) (#3)

### `execution` — Winner-settle exit carve-out
- **Change:** `evaluateExit` suppresses edge-reversal and time-decay exits when our side trades ≥ `exitHoldWinnerPrice` (0.90), close is ≤ `exitHoldWinnerMaxHoursToClose` (6h) away, and the position is in profit. Stop-loss unaffected.
- **Why:** 65 of 79 settled paper exits foreclosed positions that would have won, selling at avg 88.6¢ what paid 100¢ at close (~$107 foregone); the 14 genuinely-saved exits (~$176) all involved different conditions. The carve-out keeps the saves and recovers the foregone wins.
- **Doc:** [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N8)

### `execution` — Win-rate-80 entry gates (concordance / side-vs-market / coin-flip / station health)
- **Change:** New pure helper `evaluateEntryGates` in `@kcb/signals` (`app/signals/services/entry-gates.ts`), wired into the orchestrator Phase-3 ladder right after the tail gate. Four fail-fast sub-gates, each independently disabled by a 0/empty config value: (1) **station health** — block new entries on `disabledStations`; (2) **side-vs-market** — block `buy_no` when `marketPrice ≥ noSideMaxMarketPrice` (0.65) and `buy_yes` when `marketPrice ≤ yesSideMinMarketPrice` (0.35); (3) **concordance** — block when `|estimatedProb − marketPrice| > disagreementCap` (0.25); (4) **coin-flip dead zone** — block when `marketPrice ∈ [coinFlipZoneLow, coinFlipZoneHigh]` (0.40–0.60). Specific reason strings persist to `signals.skip_reason`.
- **Why:** 109 of 200 paper trades were contra-market `buy_no` against a market pricing YES at 65–85¢ — they won 19.4% and lost ~$85. `|edge|>25pp` trades ran 47%; 45–55¢ markets ran 48.7% (coin flip minus spread). These hard gates strip the bot's anti-edge posture rather than tune it.
- **Doc:** [`improvements/win-rate-80-plan-2026-06-05.md`](improvements/win-rate-80-plan-2026-06-05.md) (#1/#7), [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) (N7)

## 2026-05-29

### `calibration` — Multi-horizon station_bias warming + actuals backfill
- **Change:** New runtime knob `multi_horizon_bias_max_days` (default 0 = disabled). When ≥ 2, reconciliation calls two new periodic tasks: `warmMultiHorizonForecasts` (fetch + cache `today+2..today+N` ensembles for each enabled station) and `backfillHistoricalForecastActuals` (NWS backfill of past-target-date forecast rows). Both rate-limited to once per hour. With these populated, `recomputeStationBias` produces horizon 2..N rows that the estimator can use.
- **Why:** `station_bias` had only 6 rows (horizon=1 only) because the bot trades same-day in sniper mode and only same-day forecasts get cached. Multi-day market estimates run with zero bias correction. Sets up the data for any future strategy looking past 12h; no current-PnL impact while sniper mode dominates.
- **Doc:** [`improvements/multi-horizon-bias-2026-05-29.md`](improvements/multi-horizon-bias-2026-05-29.md)

### `calibration` — Persist adaptive thresholds to DB every reconcile cycle
- **Change:** New helpers `computeBucketThreshold` (pure) and `persistAdaptiveThresholds` (DB upsert) in `@kcb/signals`. Reconciliation calls the latter once per tick. The `adaptive_thresholds` table is populated per (series, bucket) plus a `__global__` aggregate. Runtime decision still uses on-the-fly `getEffectiveThreshold` — this is observability only.
- **Why:** The 2026-05-26 audit flagged `adaptive_thresholds` as "empty since launch." Investigation found the *logic* was running per-signal but only the manual CLI `retrain` command wrote the table. Without persistence we couldn't see what bar each signal had to clear, only the combined value persisted to `signals.edge_threshold`.
- **Doc:** [`improvements/adaptive-threshold-persistence-2026-05-29.md`](improvements/adaptive-threshold-persistence-2026-05-29.md)

### `execution` — Per-station edge surcharge
- **Change:** New runtime knob `station_edge_surcharge` (JSON stationId → surcharge map). Orchestrator adds the matching surcharge to the adaptive base threshold before gating. Stations missing from the map get 0. Combined threshold persists to `signals.edge_threshold`; skip reason names the surcharge.
- **Why:** 60-day per-station PnL shows three durable losers (KORD −36% ROI, KLAX −40%, KNYC −19%) against three winners (KMIA +11%, KAUS +9%, KDEN 0%). Removing stations is too blunt; a soft surcharge lets them keep trading but only on the cleanest signals. Initial runtime values: KLAX/KORD +0.15, KNYC +0.10.
- **Doc:** [`improvements/per-station-surcharge-2026-05-29.md`](improvements/per-station-surcharge-2026-05-29.md)

### `execution` — Tail-market entry gate by contract price
- **Change:** New runtime knob `tail_max_entry_price` (default 0). When > 0, signals on `upper_tail` / `lower_tail` markets are blocked unless the contract price the bot would pay is ≤ the cap. Logic lives in new pure helper `evaluateTailGate` in `@kcb/signals`; orchestrator inserts it into the Phase 3 decision ladder with a queryable `signals.skip_reason`.
- **Why:** Tails ran 11% win rate / −$38 over the audit window (9 trades, losses spanning 20–62¢ entries). The estimator isn't reliable enough on tails to take mid-priced positions. Restricting to deep-cheap entries (cap initially set to 0.10 in runtime_config) caps per-contract downside and forces correctness on rare events rather than coin-flip mid-priced tails.
- **Doc:** [`improvements/tail-gate-2026-05-29.md`](improvements/tail-gate-2026-05-29.md)

### `estimator` — Blend market price as a final-stage Bayesian prior
- **Change:** New runtime knob `market_prior_weight` (default 0). When > 0 and a market price is available, the estimator's final probability is blended toward the market: `final = (1−w) × pModel + w × pMarket`. Applied after the historical-prior blend, before the tail floor. Reasoning trace gains `marketPriorBlend`.
- **Why:** 14-day audit shows the market's Brier (0.134) beats the model's (0.143), and the bot's "extreme edge" 50pp+ bucket (79 trades) ran 19% win rate / −$64 — the more confident the model was that the market was wrong, the more it lost. A uniform blend at w=0.3 maps that disastrous tail into the historically-profitable 30–50pp range without disturbing small-edge trades.
- **Doc:** [`improvements/market-prior-2026-05-29.md`](improvements/market-prior-2026-05-29.md)

## 2026-05-27

### `estimator` — Cap empirical sigma weight at 0.7 + raise historical prior to 0.5
- **Change:** `MAX_EMPIRICAL_SIGMA_WEIGHT = 0.7` cap on the empirical-sigma blend (was uncapped at 1.0 once `n ≥ 50`). Runtime `historical_prior_weight: 0.3 → 0.5`.
- **Why:** Two days after the bracket-filter + CDF-inversion fixes, the bot was still predicting ~14% YES on tight near-mean brackets that resolved YES ~71% of the time. Empirical sigma was collapsing to its own bias-window residuals (overfit); bracket-filtered prior is now reliable enough to weight harder.
- **Doc:** [`improvements/sigma-cap-prior-bump-2026-05-27.md`](improvements/sigma-cap-prior-bump-2026-05-27.md)

## 2026-05-26

### `execution` — Unblock cheap-contract trades + paper-mode reserve + skip-reason DB attribution
- **Change:** Bypass `minContractPrice` (15¢) when `signal.confidence ≥ highConfidenceThreshold`. Skip profit reserve entirely in `dry_run`. Refactor `executeSignal` to return `{orderId, skipReason}` so the *specific* guard that fired is persisted to `signals.skip_reason`.
- **Why:** Audit found 99% of actionable signals (and 100% of 1,807 tail signals) silently rejected — including conf=0.92 / edge=27¢ on 1¢ markets, which are the highest-EV trades, not lottery tickets. Profit reserve was over-locking ~$149 of paper bankroll because `seedCapital` was stale. Generic `"execution skipped (position/size limits)"` strings prevented DB-level attribution.
- **Doc:** [`improvements/execution-unblock-2026-05-26.md`](improvements/execution-unblock-2026-05-26.md)

### `estimator` — Bracket-filter historical hit rate + invert CDF/counting blend
- **Change:** `getHistoricalHitRate` now joins with the `markets` table and filters by bracket-center proximity (±3°F tolerance, separate handling for tails). CDF/counting blend rebalanced: at 150 members the weighting flips from 75% counting / 25% CDF → 75% CDF / 25% counting.
- **Why:** Two compounding bugs jointly explained the bot's NO overconfidence on tight near-mean brackets. (1) `getHistoricalHitRate` accepted bracket arguments but ignored them, returning a station-wide ~17% baseline that the prior blend then *reinforced* into NO bets. (2) The blend was crushing CDF's correct ~30–40% estimates down to noisy counting's ~6%.
- **Doc:** [`improvements/calibration-deep-dive-2026-05.md`](improvements/calibration-deep-dive-2026-05.md)

## 2026-05-23

### `sizing` — Confidence-tier flat sizing
- **Change:** Two new config knobs `highConfidenceThreshold` (default 0.95) and `highConfidenceBetSizeCents` (default 1000 = $10). Signals at/above the threshold size to $10; everything else stays at the $5 flat base.
- **Why:** Two-week post-restart data showed confidence was predictive but **non-monotonic**: 0.95+ bucket was 56% win / +$8,380, while 0.90–0.95 was 32% / −$5,590. A single high-confidence tier captures the winning band without scaling up the losing one.
- **Doc:** [`improvements/confidence-tier-sizing.md`](improvements/confidence-tier-sizing.md)

## 2026-05-09

### `estimator` — Sample-size-weighted sigma blend
- **Change:** Replaced the `n ≥ 10` cliff for empirical sigma with a continuous blend: `w = min(1, sampleSize/50)`. Pure ensemble at n=0, pure empirical at n=50.
- **Why:** Tight 1°F brackets with corrected mean inside or adjacent to the bracket were getting ≤25% YES estimates against 60%+ actuals. Empirical sigma was systematically tighter than ensemble spread (overfit on a small bias window); blending widens it where the empirical estimate is least trustworthy.
- **Doc:** [`improvements/post-sharpening-regression.md`](improvements/post-sharpening-regression.md#2026-05-09-three-day-post-restart-review--empirical-sigma-is-too-narrow) (§"2026-05-09")

## 2026-05-05

Three execution + estimator fixes shipped same day after a deeper post-mortem of the 2026-05-04 bias-correction diagnostic. All shipped to runtime_config + code together.

### `execution` — Cost-basis math: reduce by avg entry on sell (not proceeds)
- **Change:** On a sell, `cost_basis` now decreases by `closedQty × (totalCost / totalQty)` instead of by the gross proceeds.
- **Why:** Profitable round-trips were driving cost basis *negative*, which inverted `avg_entry_price` and silently disabled the 25% stop-loss for weeks. Concrete example caught in production: 5-trade KXHIGHNY-B81.5 sequence showed `cost = -$18.60` instead of `+$5.00`.
- **Doc:** [`improvements/post-sharpening-regression.md`](improvements/post-sharpening-regression.md) §"2026-05-05 #2"

### `discovery` — Allow tail markets into estimation gate
- **Change:** Orchestrator's bracket-validity filter (`bracketHigh != null`) replaced with the same check the estimator uses (`!isTail && bracketHigh == null`).
- **Why:** Tail markets (upper_tail / lower_tail) deliberately store `bracketHigh = null` because their threshold is `bracketLow`. The filter dated to Feb 22, predating April's threshold-fix work that taught the estimator to handle tails. Tails were being filtered before they could be scored. Per-tick estimation count jumped 48 → 72.

### `infrastructure` — Realign runtime_config with conviction-sizing intent
- **Change:** `edge_threshold: 0.15 → 0.20`, `min_confidence: 0.65 → 0.80` (the `.env` file had pre-conviction-sizing values that runtime_config wasn't overriding).
- **Why:** The conviction-sizing PR's "expected effects" never materialized in production because the gates were still set to permissive pre-PR values.

## 2026-05-04

### `estimator` — Floor forecast horizon at 1
- **Change:** `forecastHorizon = Math.max(1, ceil((targetDate - now) / day))`.
- **Why:** Same-day markets resolve at midnight UTC. After that boundary, `ceil(...)` returned 0, which never matched the horizon=1 row in `station_bias` (reconciliation stores with `Math.max(1, ...)`). Same-day estimates were silently losing bias correction entirely — exactly the markets the bot trades most.
- **Doc:** [`improvements/post-sharpening-regression.md`](improvements/post-sharpening-regression.md) §"2026-05-04"

## 2026-04-23

### `sizing` — Conviction sizing (flat $5)
- **Change:** New `flatBetSizeCents = 500` overrides Kelly's dollar amount when set; Kelly still gates EV sign. Tightened gates: `edgeThreshold: 0.15 → 0.20`, `minConfidence: 0.65 → 0.80`. New `minBetSizeCents = 500` safety net. Activated `historicalPriorWeight = 0.3`.
- **Why:** Kelly × seed $175.56 × maxKellyFraction 2.5% capped every bet at ~$4.39 — micro-bets that were systematically -EV in the `pred<10%` bucket (33.8% YES rate, lost $352 across 263 trades). Pivot from "Kelly-as-sizer" to "conviction-gated flat stake."
- **Doc:** [`improvements/conviction-sizing.md`](improvements/conviction-sizing.md)

## 2026-04-22

### `estimator` — Historical prior blend (gated)
- **Change:** New runtime knob `historical_prior_weight`. When > 0 and a non-null `historicalHitRate` is available: `blended = (1-w) × raw + w × historicalHitRate`.
- **Why:** Estimator was computing `historicalHitRate` on every estimate and throwing it away — a Bayesian prior that observed reality was sitting unused while the bot was systematically NO-overconfident.
- **Doc:** [`improvements/post-sharpening-regression.md`](improvements/post-sharpening-regression.md) §"Shipped: gated historical-prior blend"

### `calibration` — Retention-resilient `backfillActualValue`
- **Change:** New branch: when `weather_forecasts` has no row for a resolved market, synthesize one from the most recent `signals.reasoning` trace + NWS actual.
- **Why:** External wipes of `weather_forecasts` (later root-caused to the test suite) were keeping `station_bias` at 0 rows indefinitely. Synthesis path needs only one resolved market per station to seed the bias chain.

## 2026-04-21

### `estimator` — Observation adjustment sigma loosening
- **Change:** Same-day observation tightens sigma to `0.7×` (was `0.5×`); divergent observations shift mean and tighten to `0.85×`.
- **Why:** Half-sigma was too aggressive — one observation against a 150-member ensemble shouldn't halve uncertainty.

## 2026-04-14

### `estimator` — Forecast sharpening bundle (5 changes)
- **Change:** (1) HRRR ingestion. (2) Sniper-mode gate (only act within `sniperHorizonHours` of close). (3) Empirical sigma from `station_bias.stdBias`. (4) Same-day NWS observations as Bayesian conditioning. (5) Horizon-weighted blending across GFS / ICON / ECMWF ensembles.
- **Why:** Close the accuracy gap with top-of-leaderboard bots. Monte Carlo ROI sims projected each change in isolation; bundled because they share the same `ReasoningTrace` plumbing.
- **Doc:** [`improvements/forecast-sharpening.md`](improvements/forecast-sharpening.md)

## 2026-04-02

### `calibration` — Adaptive threshold table (initial)
- **Change:** Per-bucket edge thresholds adjust toward observed calibration error.
- **Status:** Built but **not yet active** — `adaptive_thresholds` table is empty as of 2026-05-26 audit. The 10-row-per-bucket minimum prevents activation at current trade volume. Flagged in the 2026-05-26 audit; queued for tuning.

---

## How to update this file

When shipping a new algorithm change, prepend an entry under a new date heading at the top. Format:

```md
## YYYY-MM-DD

### `<area>` — Short title
- **Change:** What's different in one or two sentences. Code reference welcome.
- **Why:** The motivation in one or two sentences. Reference data if available.
- **Doc:** [link to detail doc in improvements/](improvements/your-doc.md) (optional but encouraged)
```

Skip the `Doc:` line for trivial changes that don't justify a standalone document. Don't add UI / infrastructure / refactor entries here — those live in their own docs and in commit history.
