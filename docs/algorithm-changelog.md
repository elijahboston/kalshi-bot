# Algorithm Changelog

Chronological record of changes to the climate bot's decision-making — the **estimator** (probability), **sizing** (Kelly / flat / tier), **execution gates** (guards on order placement), and the **calibration feedback loop**. Newest first.

Each entry is intentionally terse — one line per change, with `Why:` and a link to the improvement doc for full mechanics, math, and verification. UI, infra, and Bun-migration changes are out of scope; see [`spec.md`](spec.md) for the broader feature index.

**Areas:** `estimator` · `sizing` · `execution` · `calibration` · `discovery`

---

## 2026-05-29

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
