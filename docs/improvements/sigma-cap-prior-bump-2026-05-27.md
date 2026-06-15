# Cap empirical sigma weight at 0.7 + raise historical prior to 0.5 (2026-05-27)

**Status:** Accepted
**Date:** 2026-05-27
**Deciders:** Elijah Boston

## Why

Yesterday's overnight validation of the [execution unblock](./execution-unblock-2026-05-26.md) and [calibration deep-dive fixes](./calibration-deep-dive-2026-05.md) showed the bot is **still losing on the same failure mode**: bets NO on tight near-mean brackets, actuals come in YES.

7 post-deploy resolved trades:

| Metric | Value |
|---|---|
| Bot's avg predicted P(YES) | **14.2%** |
| Actual YES rate | **71.4%** |
| Net PnL | **−$9.50** |
| Wins / losses | 3 / 4 |

The estimator fixes from 2026-05-26 moved the bot's prediction on these markets from ~6–8% YES → 12–18% YES — a real improvement, but still 50+ percentage points below truth. The remaining gap is concentrated in **two levers we explicitly deferred yesterday**: empirical sigma collapse and timid prior weighting.

## Change 1 — `MAX_EMPIRICAL_SIGMA_WEIGHT = 0.7`

[`app/signals/services/estimator.ts:147`](../../app/signals/services/estimator.ts#L147)

Pre-fix the sigma blend was `w = min(1, n/50)`. With our current 56-sample-per-station bias windows, `w` pins at 1.0, meaning the CDF uses pure empirical sigma. Empirical sigma is residuals fit *on its own bias-correction window* — systematically tighter than out-of-sample error.

New formula caps `w` at 0.7, so **30% ensemble spread stays in the blend permanently**:

```ts
const w = Math.min(MAX_EMPIRICAL_SIGMA_WEIGHT, biasCorrection.sampleSize / 50);
sigmaUsed = w * empiricalSigma + (1 - w) * corrStd;
```

Effect on a typical losing trace (KXHIGHMIA-26MAY08-B92.5, post-yesterday's fixes):

| Quantity | Before cap | After cap |
|---|---|---|
| empiricalSigmaWeight | 1.0 | 0.7 |
| sigmaUsed | 1.02°F | ~1.5°F (blend with 2.67 ensemble std) |
| CDF P(bracket) | 0.37 | ~0.30 |

The sigma widens, CDF gets *slightly* lower on the centered case (because we're spreading probability over a wider distribution) but *meaningfully higher* on the off-center cases (where actuals were YES). Net effect: less overconfident on the failing trades.

## Change 2 — `historical_prior_weight: 0.3 → 0.5`

`runtime_config` UPDATE — no redeploy needed:

```sql
UPDATE runtime_config SET value = '0.5' WHERE key = 'historical_prior_weight';
```

Yesterday's bracket-filter fix made `historicalHitRate` actually variable per bracket position. Validated overnight: values now span 0.0 → 0.32 across signals, instead of being constant ~0.17 per station.

Now that the prior is trustworthy (matches similar-bracket history rather than global station noise), increasing its weight in the blend pulls predictions further toward observed reality.

Combined blend math at typical near-mean signal:

```
rawProbability (CDF-dominant): ~0.13
historicalHitRate (similar brackets): ~0.30
priorWeight: 0.5

blended = 0.5 × 0.13 + 0.5 × 0.30 = 0.215
```

vs. pre-bump (weight 0.3): `0.7 × 0.13 + 0.3 × 0.30 = 0.181`. The bump moves typical predictions from ~18% → ~22% YES.

## Combined expected impact

Stacking both changes on the May 8 KXHIGHMIA loser:

| Quantity | Pre-yesterday | Post-yesterday | Post-today |
|---|---|---|---|
| `cdfProbability` | 0.37 | 0.37 | ~0.30 |
| `countingProbability` | 0.06 | 0.06 | 0.06 |
| `rawProbability` (CDF-dominant) | 0.14 | 0.25 | ~0.24 |
| `historicalHitRate` (bracket-filtered) | 0.20 | 0.25 | 0.25 |
| `blendedProbability` (final) | 0.16 | 0.25 | **~0.25** |

So final predicted P(YES) goes from 0.16 (pre-fix) → ~0.25 (post-today). Still well under the ~70% actual rate, but the gap is closing. Expect:

- Fewer NO bets clearing the edge gate (their implied edge shrinks as P(YES) rises)
- Surviving NO bets are higher-confidence and on more genuinely-mispriced markets
- Some previously-uneconomic YES bets may now clear

## Tests

[`app/signals/services/estimator.test.ts`](../../app/signals/services/estimator.test.ts):

- New test `MAX_EMPIRICAL_SIGMA_WEIGHT cap kicks in at n=35 (n/50=0.7)` — explicit cap-behavior check at high sample size
- Updated `blends empirical + ensemble sigma weighted by sample size` (n=50) — now asserts capped weight, not 1.0
- Updated `empirical sigma concentrates probability on correct bracket (n=50 saturated)` — uses blended sigma math
- All other sigma-blend tests (n=10, n=16, n=25) unchanged — they were already below the 0.7 cap

Suite: 431 → 432 pass, 0 fail.

## Runtime config state

```
historical_prior_weight = 0.5   (was 0.3, updated 2026-05-27)
```

## Verification (target ~2026-05-31)

- New signal traces should show `empiricalSigmaWeight: 0.7` for any station with n≥35 bias samples
- `historicalPriorBlend.weight` in new traces should be 0.5
- `sigmaUsed` for tight-bracket markets should rise (e.g., KMIA going from ~1.0 to ~1.5)
- Watch the bucket-resolved actual YES rate vs predicted — should narrow from the 14% pred / 71% actual gap

## What this still doesn't fix

The bot's fundamental problem is that **its strategy mix is one strategy** — bet NO on tight 1°F brackets. Even with perfect calibration, this exposes us to single-mode-of-failure risk. Per the 2026-05-26 audit, opportunities exist in:

- Tail markets (now unblocked but rarely trading — needs more time)
- Adaptive thresholds (still empty table)
- Robust `recomputeStationBias` (mean/std vulnerable to outliers)

These are queued behind seeing what one clean post-cap-and-bump week of data looks like.
