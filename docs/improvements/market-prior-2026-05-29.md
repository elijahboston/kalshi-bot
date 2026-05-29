# Market price as Bayesian prior (2026-05-29)

## Why

After the [sigma cap + historical-prior bump](./sigma-cap-prior-bump-2026-05-27.md) shipped 2026-05-27, two more days of fills confirmed the same failure mode. The estimator's "raw" predictions moved a few percentage points toward truth, but it's still systematically betting NO into markets that resolve YES.

The 2026-05-29 audit of the last 30 days surfaces a finding the previous fixes did not address: **the market itself is a better-calibrated probability estimator than the model**.

### Brier score over the last 14 days of resolved signals (`calibration` table, n=540)

| Predictor | Brier |
|---|---|
| Our model (`predicted_prob`) | **0.1428** |
| Market (`market_price` at signal time) | **0.1337** |

### PnL by implied edge bucket (last 30 days, 158 buys)

`implied_edge` = our P − market P (signed, for the side we bet).

| Implied edge | Trades | Win rate | PnL |
|---|---|---|---|
| 20–30pp | 22 | 41% | −$26 |
| 30–40pp | 34 | 44% | −$20 |
| **40–50pp** | **23** | **52%** | **+$22** ← sweet spot |
| **50pp+ ("market is wildly wrong")** | **79** | **19%** | **−$64** |

The pattern is inverted — extreme edge is supposed to be highest-conviction, but in our trades the 50pp+ bucket is the worst performer by every measure. The bot is most confident when the market disagrees most, and that's exactly when the market is most likely to be right.

### Representative 2026-05-28 fills (post-sigma-cap)

```
LAX B67.5: model 17% YES, market 75% YES → YES won  (−$5)
DEN B76.5: model 19% YES, market 75% YES → YES won  (−$5)
AUS B90.5: model 21% YES, market 75% YES → YES won  (−$5)
CHI B72.5: model 12% YES, market 75% YES → YES won  (−$5)
```

In each case the model and market disagree by 50+ percentage points, the model fills NO at ~25¢, and the bracket lands YES.

## Change 1 — Blend market price as a final-stage prior in `estimate()`

[`app/signals/services/estimator.ts`](../../app/signals/services/estimator.ts) — extend `ProbabilityEstimator.estimate()` to accept an optional `marketPrice` and apply a market-prior blend immediately after the historical-prior blend. Gated by `config.bot.marketPriorWeight` (0 = disabled).

```ts
const marketPriorWeight = getConfig().bot.marketPriorWeight;
if (marketPriorWeight > 0 && marketPrice != null) {
  const w = Math.min(1, Math.max(0, marketPriorWeight));
  blendedProbability = (1 - w) * blendedProbability + w * marketPrice;
}
```

The blend happens inside the estimator so the existing edge computation in the orchestrator (`estimate.probability − marketPrice`) automatically shrinks. No downstream changes to thresholds, sizing, or execution gates required.

### Why blend rather than cap

A hard cap (e.g., "skip if `|model − market| > 0.40`") is simpler but throws away the model's signal entirely on those trades. A blend keeps the model's contribution proportional to its weight and lets the same gates handle the rest — and because the blend is uniform, it maps the disastrous 50pp+ bucket into the profitable 30–50pp range without changing what we do at small edges:

| Raw edge | Edge after `w=0.3` blend |
|---|---|
| 25pp | 17.5pp |
| 50pp | 35pp ← lands in 30–40pp historical-profit zone |
| 70pp | 49pp ← lands in 40–50pp historical-sweet-spot zone |

Confidence is **not** affected by the blend — it still reflects forecast quality (ensemble spread, bias sample size, ensemble size), not how much we agree with the market.

## Change 2 — Config knob `marketPriorWeight`

[`packages/config/src/index.ts`](../../packages/config/src/index.ts):

```ts
// BotConfig interface
marketPriorWeight: number;

// loadConfig defaults
marketPriorWeight: envNum("MARKET_PRIOR_WEIGHT", 0),

// RUNTIME_CONFIG_MAP
market_prior_weight: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.marketPriorWeight = n; },
```

Env default is `0` (disabled) so the code change is safe to land dark. The runtime row activates it.

### Initial runtime value

```sql
INSERT INTO runtime_config(key, value, updated_at)
VALUES ('market_prior_weight', '0.3', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
```

Start at 0.3 — moderate, leaves the model with 70% weight. Ramp plan:

| Week | `market_prior_weight` | Rationale |
|---|---|---|
| Wk 1 (2026-05-29 → 06-05) | 0.3 | Validate the 50pp+ bucket stops bleeding |
| Wk 2+ | 0.5 if Brier gap to market still > 0.005 | Push further if estimator hasn't closed gap |
| Wk N | revisit | If estimator catches the market, can ramp back down |

## Expected impact

Applied to the 2026-05-28 LAX B67.5 loser (model=0.17, market=0.75):

```
blended = 0.7 × 0.17 + 0.3 × 0.75 = 0.119 + 0.225 = 0.344
edge_no = (1 − 0.344) − (1 − 0.75) = 0.406
```

Old edge was 0.58, new edge is 0.41 — still above the 0.20 threshold but no longer "fighting the market by 58pp." If the edge gate or confidence gate trims the trade, that's the correct outcome — the previous version of this trade had a 20% historical win rate.

Cumulative expected effect across the 79-trade 50pp+ bucket: a meaningful share drops below `edge_threshold` (0.20) and never fires. The remainder fire smaller per-trade nominal but with edges that align with the historically profitable 30–50pp band.

## Tests

[`app/signals/services/estimator.test.ts`](../../app/signals/services/estimator.test.ts) — new `describe("ProbabilityEstimator — market prior blend")` block:

- `weight=0 leaves probability unchanged even when marketPrice is provided`
- `weight>0 blends probability toward market price` (model=0.15, market=0.75, w=0.5 → ~0.45)
- `marketPrice undefined → no blend applied`
- `weight clamped to [0, 1]` (w=2 → fully follows market)
- `blend applies after historical-prior blend` (composition order check via reasoning trace)
- `tail markets respected` (tail floor still applied last)

## Verification (target ~2026-06-05)

- New signal traces should show `marketPriorBlend.weight = 0.3` on every signal where `marketPrice` is non-null
- In the `calibration` table, the model's Brier should narrow toward the market's Brier (both move together if the blend is doing its job)
- The 50pp+ bucket should shrink — most signals there should re-bucket to 30–50pp range
- Net PnL on resolved signals over the week should be flat-to-positive (compared to current −$0.50/day bleed)

## What this still doesn't fix

- **The model is still uncalibrated** on tight near-mean brackets; the market-prior blend masks the symptom rather than fixing the underlying estimator. The right long-term fix is whatever the market knows that we don't (afternoon convection? local terrain? official forecaster intuition?) baked into a model feature.
- **`adaptive_thresholds` still empty.** Once the market-prior blend stabilizes the predictions, the threshold table should start receiving useful calibration signal.
- **Per-station P&L skew** (CHI, NY, LAX losing; MIA, DEN, AUS winning) is not addressed by this change — that's a station-bias / per-station-threshold problem, separate from estimator calibration.
