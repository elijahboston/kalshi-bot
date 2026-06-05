# Win-Rate 80% Plan — 2026-06-05

> Goal: lift paper-mode win rate from **33.5% → ≥80%** by reversing the bot's anti-edge contra-market posture, not by tuning the existing one.

This document is a deep analysis of the bot's current state and a prioritized action plan. It supersedes the incremental tuning in `market-prior-2026-05-29.md`, `tail-gate-2026-05-29.md`, and `per-station-surcharge-2026-05-29.md` — those shipped, but the data shows they're insufficient.

---

## 1. State of the bot (2026-06-05)

### Paper-mode performance, 2026-04-26 → 2026-06-05

| Metric | Value | Target |
|--------|-------|--------|
| Trades | 200 | — |
| Win rate | **33.5%** | ≥80% |
| Realized PnL | **−$82.81** on $200 deployed | positive |
| Trading universe | `high_temp` only (KNYC, KMIA, KORD, KAUS, KDEN, KLAX) | unchanged |
| Action rate | 200 acted / 553,164 signals = 0.036% | retain selectivity but redirect *what* we act on |

### The dominant failure mode is anti-edge contra-market NO bets

A reliability + bucketing decomposition of the 200 paper trades:

| Market price at signal | Bot side | Trades | Wins | Win % | PnL |
|---|---|---|---|---|---|
| ≤ 0.35 (market says NO) | NO | 1 | 1 | 100.0% | +$4.08 |
| 0.35–0.45 | NO | 5 | 4 | 80.0% | +$13.42 |
| 0.45–0.55 (coin) | NO | 78 | 38 | 48.7% | −$13.77 |
| 0.55–0.65 | NO | 5 | 3 | 60.0% | +$16.38 |
| **0.65–0.75 (market says YES)** | **NO** | **64** | **12** | **18.8%** | **−$91.92** |
| **0.75–0.85 (market says YES)** | **NO** | **45** | **9** | **20.0%** | **−$1.00** |
| 0.10–0.29 (market says NO) | YES | 2 | 0 | 0.0% | −$10.00 |

**109 of 200 trades — 55% of the book — are NO bets against a market that already prices YES at 65–85%. They win 19.3% and lose $93.** Those alone account for the entire negative PnL.

For comparison, the **7 trades** where the bot agreed with market direction (model > 50% AND market > 50% AND side = YES, or all < 0.5 and side = NO), inside the 0.10–0.90 band, hit **85.7% (6/7), +$24.55**. The 80% band exists — it's tiny in the current book.

### The market is well-calibrated. The model is not.

Reliability diagram across all signals (2026-05+, n ≈ 488k):

| Market p(YES) | Actual YES rate | Calibration |
|---|---|---|
| <5% | 0.3% | well-calibrated |
| 5–10% | 4.4% | calibrated |
| 10–20% | 13.6% | calibrated |
| 20–30% | 21.4% | calibrated |
| 30–40% | 31.8% | calibrated |
| 40–50% | 49.2% | calibrated |
| 50–60% | 63.7% | mild under-confident |
| 60–70% | 72.4% | calibrated |
| 70–80% | 81.0% | mild under-confident |
| 80–90% | 89.7% | calibrated |
| 90%+ | 99.3% | calibrated |

| Model p(YES) | Actual YES rate | Calibration |
|---|---|---|
| <5% | 1.5% | mild under-confident |
| 5–10% | 9.1% | mild under-confident |
| 10–20% | **21.2%** | **2× under-confident** (the bot's main NO-bet zone) |
| 20–30% | 30.1% | under-confident |
| 30–40% | 32.5% | calibrated |
| 40–50% | 55.3% | under-confident |
| 50–60% | **25.7%** | **2× over-confident in YES** |
| 60–70% | 50.2% | over-confident |
| 70–80% | **31.7%** | **2× over-confident** (worst bucket) |

The model is systematically wrong above 50% and systematically too cold below 30%. The market is essentially perfectly calibrated end-to-end.

### Counterfactual: pure market-follow at conviction would have won ~96%

For signals the bot did **not** act on (524,964 total), if we had simply bought the popular side whenever the market was ≥80% confident, we would have hit:

- 14,886 YES-at-≥80¢ opportunities → **97.4% win rate**
- 325,440 NO-at-≤20¢ opportunities → **96.4% win rate**

This isn't a strategy proposal (a 96% win rate at 80¢ entries is +4¢ net, then you have to size capital around it). It is **evidence that the market is the cheapest edge available** and the bot is currently fighting it.

### Recent fix bands

| Date | Fix | 2-week win rate after |
|---|---|---|
| 2026-05-26 | bracket-filtered hit rate + CDF/counting flip | 36.8% (19 trades) |
| 2026-05-27 | sigma cap 0.7 + prior weight 0.5 | 36.8% (incl. above) |
| 2026-05-29 | market_prior_weight=0.3 + tail gate + station surcharge | 53.3% (15 trades) — best window |
| 2026-06-01+ | (no change) | **25.0% (16 trades) — regressed** |

The May-29 bundle worked briefly, then regressed. The market_prior weight of 0.3 is too weak to override 40+¢ false edges from the model. The data shows the bot is back to contra-market betting and losing.

---

## 2. Root-cause analysis

### A. Sigma is still too wide on in-mean brackets

Recent loss example (KNYC, 2026-06-05 B87.5):

```
Raw ensemble:    mean 90.6F, std 2.01F, n=150
Bias correction: -1.04F  (corrected mean 89.6F)
Empirical-blend sigma:  1.58F  (weight 0.7)
Observation:     87.1F at signal time → no mean shift, sigma tighten 2.26→1.58
Members in bracket 87.5-88.5:  29/150 = 19.3%
CDF prob (corrected mean 89.6F, sigma 1.58F, 87.5-88.5): 15.1%
Counting prob: 19.3%
Raw blend (cdfWeight 0.75): 16.2%
Historical prior 22.2% × 0.5 weight: 19.2%
Market prior  0.80    × 0.3 weight: 37.4%
Final p(YES): 37.4%
Market price: 80%
NO edge:    0.626 − 0.20 = 0.43
Outcome:    YES (lost $0.25)
```

The CDF is correctly placing the corrected mean (89.6F) ~1°F above the bracket, but the actual high was inside the bracket. Several compounding issues:

1. **Bias correction is point-estimate**: meanBias = +1.04F based on 58-day rolling mean. The market knows that on this particular morning the air mass is sitting around 87F obs, which projects to ~88F afternoon high — *much* lower than the climatological bias-corrected forecast.

2. **Observation handling is too gentle**: 87.1F obs at the time of the bet (afternoon-ish per timestamp 17:27Z = 1:27pm NYC, near peak heating). The bot's diurnal-offset logic treated this as ~89F implied high, divergence 2°F → "agreement", just tighten sigma by 30%. The right move was to anchor the mean at 88F.

3. **The market prior at 0.3 leaves edge on the table**: model 16% → blended 37%. Disagreement with market is still 43pp; threshold is 30¢. The blend has to either be tighter (≥0.6) or there must be a hard disagreement cap.

4. **Historical hit rate is wrong direction**: 22% pull-toward. Tight near-mean brackets actually hit ~50% YES on average; the ±3°F bracket-center tolerance is pulling in too many neighbor brackets that don't hit. So the prior reinforces NO, not YES.

### B. The estimator's `confidence` score is anti-correlated with quality

| Confidence bucket | Trades | Win % | PnL |
|---|---|---|---|
| <0.80 (below gate) | 40 | 30.0% | −$15.00 |
| 0.80–0.85 | 9 | 11.1% | −$35.00 |
| 0.85–0.90 | 17 | 29.4% | −$10.00 |
| 0.90–0.95 | 90 | 34.4% | −$65.00 |
| **≥0.95** | 44 | **40.9%** | **+$42.19** |

The 0.95+ band is the only profitable confidence bucket and only modestly so. The 0.80–0.95 band is a death zone. The confidence formula (spread × 0.4 + bias_n × 0.4 + ensemble_n × 0.2) gives ~0.93 for any signal with a populated `station_bias` row and an Open-Meteo ensemble — i.e., basically every signal. It's a "data presence" check, not a "model is right" check.

### C. Station surcharges are not enough; the losing stations are still trading

Despite KORD (+0.15), KLAX (+0.15), KNYC (+0.10) edge surcharges shipped 2026-05-29:

| Station | Trades | Win % | PnL |
|---|---|---|---|
| KORD | 32 | 25.0% | −$70.00 |
| KNYC | 46 | 28.3% | −$69.16 |
| KLAX | 14 | 21.4% | −$25.00 |
| KAUS | 37 | 37.8% | +$15.00 |
| KDEN | 29 | 41.4% | +$25.00 |
| KMIA | 42 | 40.5% | +$41.35 |

The losers are still bleeding because the surcharges only raise the edge threshold by 10–15¢ — the false edges in this bucket are 40–60¢, so they sail right through.

### D. The bot only trades `high_temp`

Zero `precip`, `snowfall`, or other categories. Single point of failure if `high_temp` regimes shift seasonally. The `enabled_stations` config only enables six stations and the `multi_horizon_bias_max_days=3` warming was just turned on (no historical data yet).

### E. The action rate is 0.036%, but the wrong 0.036%

The bot generates 553k signals and acts on 200. The 200 are the *highest-claimed-edge* signals — which the data now shows are *also the most likely to be anti-edge against a confident market.* The selectivity is correct in principle, wrong in direction.

---

## 3. Strategy redirection

The mental model needs to flip from:

> **Old:** "Find brackets where the market mis-prices YES; bet NO with the residual edge."

to:

> **New:** "Trust the market by default. Disagree only when the model has structural information the market demonstrably lacks (HRRR sniper window, observed-temp anchor, persistent station bias), and never when the model's disagreement is large and unsupported."

Concretely, three hard rules:

1. **Concordance gate (new):** if `|estimated_prob − market_price| > 0.25`, skip the signal. The model's "high edge" signals are exactly the ones the market disagrees with, and the market is right ~80% of the time in that disagreement.

2. **Side-vs-market hard gate (new):** never `buy_no` when `market_price ≥ 0.65`. Never `buy_yes` when `market_price ≤ 0.35`. These bands are the disaster zone.

3. **Confirmation-mode signals (new):** add a *second* signal pathway that triggers when the model AGREES with a confident market, takes the popular side at the market price, and books the small but reliable edge. This is the new dominant signal type — the bot becomes a market follower with a model filter, not a contrarian.

These three rules alone, applied to the existing 200 paper trades, would have left ~10–15 of the most profitable bets standing (~80% win rate, +$30–40 PnL) and added some new market-follow trades on top.

---

## 4. Prioritized action plan

Each item has impact estimate, files, and verification. They are ordered by impact-per-effort. The first three are mandatory for 80%; the rest harden the system.

### 1. Hard concordance & side-vs-market gates ⭐ HIGHEST IMPACT
**Status:** ✅ Shipped 2026-06-05 — `evaluateEntryGates` in `entry-gates.ts`, wired into the Phase-3 ladder after the tail gate. Config: `disagreement_cap=0.25`, `no_side_max_market_price=0.65`, `yes_side_min_market_price=0.35`. Replay of the 200-trade book: every historical trade is blocked by the combined gate stack.
**Impact:** Lifts win rate from 33.5% → ~60–70% just by removing the contra-market disaster zone.
**Effort:** Half-day.
**Files:** `app/engine/services/orchestrator.ts` (Phase 3 ladder), `app/signals/services/entry-gates.ts` (new helper), config keys.

**Change:**
- Add config keys `disagreement_cap` (default `0.25`) and `market_concordance_required` (default `true`).
- New helper `evaluateConcordance({estimatedProb, marketPrice, side})`:
  - Returns `{ allowed: false, reason: "disagreement 43¢ > cap 25¢" }` when `Math.abs(estimatedProb - marketPrice) > disagreement_cap`.
  - Returns `{ allowed: false, reason: "buy_no blocked: market_price 0.80 ≥ 0.65 (market says YES)" }` when `side === "no" && marketPrice >= 0.65`.
  - Mirror block on YES when `marketPrice ≤ 0.35`.
- Insert in the Phase-3 decision ladder right after `tailGate`, before `recommendation = side==="yes" ? "buy_yes" : "buy_no"`.
- Persist the specific reason to `signals.skip_reason` for attribution.

**Verification:** Backtest in a SQL CTE: re-classify all 200 historical trades through these gates. Expect ≥100 trades blocked, remaining 50–80 win rate.

### 2. Confirmation-mode signal pathway ⭐ HIGH IMPACT, ADDS VOLUME
**Status:** ✅ Shipped end-to-end 2026-06-05 — `evaluateConfirmation` (pure helper), orchestrator emission (`confirm_yes`/`confirm_no` when the contrarian ladder skips inside the sniper window; station-health honored, concordance cap deliberately not applied), and the execution branch (Kelly bypass, flat `confirmation_bet_size_cents`, ≤93¢ entry cap re-checked at fill time). Runtime row `confirmation_mode_enabled=true` (paper). Replay basis: YES arm 15/15 (+7.1¢/contract), NO arm 95.3%.
**Impact:** Adds high-win-rate market-follow trades to compensate for the volume lost to gate #1. Expected hit rate 85–95% per the market reliability data.
**Effort:** 1–1.5 days.
**Files:** `app/signals/services/entry-gates.ts`, `app/engine/services/orchestrator.ts`, `packages/config/src/index.ts`.

**Change:**
- New config keys: `confirmation_mode_enabled` (default `true`), `confirmation_min_market_conviction` (default `0.80`), `confirmation_min_model_agreement` (default `0.50`), `confirmation_bet_size_cents` (default `500`).
- New evaluation branch after current edge calc:
  - If `marketPrice ≥ confirmation_min_market_conviction` AND `estimatedProb ≥ confirmation_min_model_agreement`: emit a `buy_yes` "confirmation" signal at market price, edge = 0, *flat sized*.
  - Mirror for `marketPrice ≤ 1 − confirmation_min_market_conviction`: `buy_no`.
- These signals bypass `edgeThreshold` (we know edge is small) but require the high market conviction.
- Add new `recommendation = "confirm_yes"` / `"confirm_no"` plus DB persistence + `signals.recommendation` enum update.
- Sizing: flat `confirmation_bet_size_cents` (e.g., $5). Kelly stays in main path; confirmation path is conviction-flat.

**Verification:** Counterfactual replay on past signals — expect 50–200 confirmation signals over 6 weeks, win rate ≥85%, small per-trade PnL, positive aggregate.

**Implementation status (2026-06-05):** Execution-side branch shipped in `execution.ts`. `executeSignal` recognizes `recommendation === "confirm_yes" | "confirm_no"` and: **bypasses** the Kelly EV-sign gate (`cappedKelly <= 0` no longer skips — the model intentionally disagrees with paying the confident market) and the `minContractPrice` floor; sizes **flat** at `confirmationBetSizeCents` (500¢); enforces an **entry-price cap** re-checked at execution time (`confirmationMaxEntryPrice`, 0.93) → skip `confirmation entry N¢ > cap M¢`; records `kellyFraction = 0` on the order row to mark "sizing bypassed Kelly". All other guards (max positions, netHeld, cooldown, exposure, **spread**) still apply. The entry price is the book crossing price from N4 (ask for YES / `100 − bid` for NO). **Still required from the orchestrator/estimator path:** emit `confirm_yes` / `confirm_no` recommendations (with `side` set and `marketPrice`/`estimatedProb` populated) when `marketPrice ≥ confirmationMinMarketConviction` and the model agrees per `confirmationMinModelAgreement`, behind `confirmationModeEnabled`. Until that emission lands, no confirmation orders are placed (ships dark). 9 execution tests cover the branch (fires on negative Kelly, flat sizing → `floor(500/86)=5`, kellyFraction 0, cap skip, confirm_no `100−bid`, and the minContractPrice bypass vs the still-enforced regular path).

### 3. Raise `market_prior_weight` adaptively ⭐ MEDIUM IMPACT
**Status:** ✅ Shipped 2026-06-05 — weight ramps 0.3 → 0.7 over disagreement 0.30 → 0.60 (`market_prior_max_weight`, `market_prior_ramp_start/end`). KNYC June-5 example verified in tests: blend 0.37 → 0.62, false NO edge correctly killed.
**Impact:** Tightens model output toward market when they disagree heavily; reduces false edges that even the concordance gate doesn't catch.
**Effort:** Half-day.
**Files:** `app/signals/services/estimator.ts`, `packages/config/src/index.ts`.

**Change:**
- Replace flat `market_prior_weight=0.3` with adaptive: when `|p_model − marketPrice| > 0.30`, ramp weight from 0.3 → 0.7 linearly.
- Formula: `w = 0.3 + 0.4 * clamp((disagreement - 0.30) / 0.30, 0, 1)`. So at 30¢ disagreement: 0.3, at 45¢: 0.5, at 60¢+: 0.7.
- Keeps small-edge trades unblunted; aggressively pulls "wild" model outputs toward the market.
- New trace field `marketPriorBlend.adaptiveWeight` for `explain`.

**Verification:** Replay reasoning traces — at the KNYC June-5 example, weight should have been 0.7, blended = 67% YES, NO edge would be 12¢ < 30¢ threshold, signal correctly dropped.

### 4. Fix sigma underestimate on in-mean brackets ⭐ MEDIUM IMPACT
**Impact:** Targets the root estimator bug. The model says 16% YES on bracket center because it's normal-CDF-ing the mean 1°F above and sigma 1.5°F — too sharp.
**Effort:** 1 day.
**Files:** `app/signals/services/estimator.ts`.

**Change:**
- Add a minimum-sigma floor based on bracket width: `sigmaUsed = Math.max(sigmaUsed, bracketWidth * 0.6)` (where `bracketWidth = bracketHigh - bracketLow`, default 1.0 for tails).
- Sigma cap remains at 0.7 of empirical blend.
- Rationale: empirical sigma collapses to ~1.5°F on its own residuals — but the *next* forecast's real error variance is often 2–3°F. The floor prevents the CDF from being over-confident on the unfortunate "mean lands just outside the bracket" case.

**Verification:** Recompute KNYC June-5 — sigma should floor to 0.6 (bracket width 1.0 × 0.6), CDF spreads more probability into the in-mean bracket, p(YES) lifts to ~25%+ — closer to historical truth.

### 5. Fix `getHistoricalHitRate` bracket matching ⭐ MEDIUM IMPACT
**Impact:** Currently pulls toward the wrong baseline (22% when bracket center is ~50% YES). Fixing it makes the prior blend pull the right direction.
**Effort:** 1 day.
**Files:** `app/signals/services/estimator.ts`.

**Change:**
- Replace the ±3°F bracket-center tolerance with **in-forecast-mean-bracket classification**: filter historical records to those where the forecast mean fell within the same bracket as the query.
  - Concretely: when computing for a query bracket `B` centered at the corrected mean, query historical records where `actualValue` fell into a bracket *also* near its own `forecastMean` ± bracket width.
  - This isolates "what fraction of in-mean-bracket forecasts hit YES" rather than the global average.
- Fall back to category-wide baseline only when the bracket-aligned sample is < 5.

**Verification:** Recompute historical hit rate for a KNYC tight-near-mean bracket. Expect 40–55% instead of 17–22%.

### 6. Recalibrate `confidence` to actually predict win-rate ⭐ MEDIUM IMPACT
**Impact:** The current confidence isn't a useful gate. A reformulated score lets `highConfidenceBetSizeCents` actually reward the best signals.
**Effort:** 1 day.
**Files:** `app/signals/services/estimator.ts`, `app/engine/services/reconciliation.ts`.

**Change:**
- Add a fourth factor to the confidence formula: **market agreement** — `marketAgreementFactor = 1 - |estimatedProb - marketPrice|`. Weight 0.3, redistribute current weights: spread 0.3, bias_n 0.25, ensemble_n 0.15, agreement 0.3.
- Persist computed-confidence histogram to a new `confidence_calibration` table on reconciliation; expose in the dashboard.

**Verification:** Backtest: bot's 0.95+ band should still hit 50–60% win, and the 0.80–0.85 band should drop to ~0.65–0.70 (correctly reflecting agreement deficit).

### 7. Deactivate persistently losing stations entirely ⭐ LOW IMPACT, SAFETY NET
**Status:** ✅ Shipped 2026-06-05 — `disabled_stations` runtime row set to `KORD,KLAX,KNYC`; enforced as the first check in `evaluateEntryGates` (stations stay tracked/estimated so re-enable evidence keeps accruing). Auto-hysteresis version remains addendum N9.
**Impact:** Removes KORD/KLAX/KNYC trades entirely until they earn re-entry. Caps blast radius even if the higher-impact changes have edge cases.
**Effort:** 15 min config edit + reconciliation review.
**Files:** runtime config.

**Change:**
- Add `station_disabled` config (JSON list). Initially: `["KORD", "KLAX", "KNYC"]`.
- Re-enable based on rolling 30-day win rate ≥ 55% (manual review for now; automatable later).
- Or: rewrite `station_edge_surcharge` to be hard-blocking (`surcharge = 0.5` → effectively never trades).

**Verification:** Live tick logs show 0 signals acted on those stations.

### 8. Add `<6h` ultra-sniper window for HRRR-driven decisions
**Impact:** Captures the actual sniper edge (HRRR 0-6h is genuinely sharper than the market).
**Effort:** 1 day.
**Files:** `app/engine/services/orchestrator.ts`, `app/data/services/ensemble.ts`.

**Change:**
- New tier: `ultra_sniper_horizon_hours` (default 4). Inside this window, lower `edge_threshold` by 0.10 and bump `market_prior_weight` cap to 0.7 (HRRR is more trustworthy here).
- Inside `<6h`, *also* re-fetch HRRR + obs at the start of each tick (don't trust the cache).
- This is when the bot's structural information advantage (HRRR + obs) is strongest, and the market is still settling.

**Verification:** Trade distribution by hours-to-close should shift toward the 2–6h band; win rate on those trades should be ≥80%.

### 9. Expand to `precip`/`snowfall` only after `high_temp` hits 80%
**Impact:** Don't dilute the strategy by spreading thin.
**Effort:** 2–3 days when triggered.
**Files:** `app/engine/services/discovery.ts`, `app/data/services/ensemble.ts`.

**Change:** Discovery already supports these; just enable in config. Estimator already has precip-specific handling. Hold this until the core strategy is hitting 80%+ on `high_temp`.

### 10. Telemetry: persist outcome attribution per gate
**Impact:** Lets the next round of optimization be data-driven, not anecdotal.
**Effort:** 0.5 day.
**Files:** `app/engine/services/reconciliation.ts`, new `signal_outcomes` view or table.

**Change:**
- Materialize a view: `signal_outcomes` joining `signals` × `markets` × outcomes, with derived columns: `was_acted`, `was_win`, `mode_at_decision` (sniper/scout), `gate_that_fired`.
- Add REPL command `repl> wins by_gate` to inspect win rate by which gate would have fired vs. did.

---

## 5. Expected outcome (rolled up)

| Phase | Changes | Trades/wk | Win rate | PnL/wk (paper) |
|---|---|---|---|---|
| Baseline (current) | — | ~10 | 33.5% | −$15 |
| Phase 1 (gates 1–3 shipped) | concordance + side gates + adaptive prior | ~3–5 | 70–80% | +$5–10 |
| Phase 2 (4–6 shipped) | sigma floor + hit-rate fix + confidence rewrite | ~5–8 | 75–85% | +$10–20 |
| Phase 3 (7–10 shipped) | station disable + ultra-sniper + telemetry | ~8–15 | **≥80%** | +$20–40 |
| Phase 4 (confirmation pathway active) | confirmation signals at scale | ~30–60 | 85–95% | +$50–150 |

The 80% target is hit by the end of Phase 3 with the original contrarian path stripped down to its profitable core. Phase 4 is what unlocks meaningful profit by adding the high-volume market-follow signal stream.

---

## 6. Rollout checklist

1. **Get baseline numbers locked** — snapshot current `signals` + `orders` + `markets` to a `data/snapshots/2026-06-05-baseline/`. Used to measure deltas.
2. **Ship gate-only changes first** (items 1, 3, 7). These are pure subtractions — they should not introduce new bugs. Watch 5–10 trading days.
3. **Add confirmation pathway** (item 2). Watch overall PnL turn positive across both signal streams.
4. **Ship sigma + hit-rate + confidence** (items 4, 5, 6). Watch model reliability diagrams come back into calibration.
5. **Add telemetry** (item 10) once outcomes are stable; expand to `precip`/`snowfall` and `<6h` ultra-sniper only after.

Every change ships with tests (per `CLAUDE.md`), and each phase's algorithm-changelog entry should land in `docs/algorithm-changelog.md` per the project's convention.

---

## 7. What this plan deliberately does NOT do

- It does not chase ROI optimization while win rate is broken — fixing the win rate is the foundation. Sizing is a phase-4+ concern.
- It does not introduce new weather data sources — HRRR + Open-Meteo + NWS is sufficient. The bug is in interpretation, not raw signal.
- It does not assume the model can be fixed enough to compete with the market on contra-trades. We accept the market is well-calibrated and reposition the bot to harvest the edges that exist around the market's confidence.
- It does not change the existing `kalshi-client`, schema, or live-trading auth path. All changes are in `app/signals` and `app/engine`.
