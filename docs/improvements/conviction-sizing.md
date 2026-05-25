# Conviction sizing: flat $5 bets on high-confidence signals

**Date:** 2026-04-23
**Status:** Implemented

## Problem

The bot was placing many sub-$5 bets and slowly bleeding capital. Three reinforcing causes:

1. **Micro-bets baked into config.** With seed capital $175.56, `maxKellyFraction=0.025` mathematically capped any single bet at ~$4.39. `maxExposurePerTicker=500¢` capped any ticker at $5. A $5+ bet was impossible.
2. **Kelly sizes tiny on low-edge, low-price NO bets.** A 5¢-edge, 10¢-priced NO contract Kelly-sizes to pennies. `minBetSizeCents=0` left those unchecked.
3. **Calibration was inverted on the bets the bot made most.** Per [post-sharpening-regression.md](./post-sharpening-regression.md): when predicting `P(YES)<10%`, actuals hit YES **33.8%**, losing −$352 across 263 trades. `historicalPriorWeight=0` disabled the blend that would correct this. The small bets weren't just small — they were systematically −EV.

## Change

Shift from Kelly-as-sizer to **conviction sizing**: strict gate + flat $5 stake.

### Knob changes (`packages/config/src/index.ts`)

| Knob | Old | New | Notes |
|---|---|---|---|
| `edgeThreshold` | 0.15 | **0.20** | Require 20¢ edge |
| `minConfidence` | 0.65 | **0.80** | Require 80% confidence; enforced at [orchestrator.ts:233](../../app/engine/services/orchestrator.ts#L233) |
| `flatBetSizeCents` *(new)* | — | **500** | Flat $5 per signal; bypasses Kelly's dollar math. `0` falls back to Kelly |
| `minBetSizeCents` | 0 | **500** | Safety net: skip if sized spend falls below $5 |
| `maxExposurePerTicker` | 500 | **1000** | Allow a $5 entry plus room for one add |
| `maxKellyFraction` | 0.025 | **0.05** | Kept as secondary guard; primary sizing is now flat |
| `historicalPriorWeight` | 0 | **0.3** | Blend raw probability toward observed historical hit rate — fixes NO overconfidence bleed |

### Execution path (`app/execution/services/execution.ts`)

Kelly is still computed. `cappedKelly <= 0` still skips the signal — Kelly remains the EV-sign gate. But the dollar amount now comes from `flatBetSizeCents` when set:

```ts
const betAmount = config.bot.flatBetSizeCents > 0
  ? config.bot.flatBetSizeCents
  : Math.floor(balance * cappedKelly);
```

All existing guards — `minContractPrice`, `maxExposurePerTicker`, `maxContractsPerOrder`, `minBetSizeCents`, anti-churn — continue to apply. The `minBetSizeCents` floor now doubles as a trim-detection safety net: if exposure caps shrink contracts below $5, the signal skips instead of placing a trimmed micro-bet.

### Historical prior blend (`app/signals/services/estimator.ts:205-222`)

Unchanged — blend logic was already in place and tested. Flipping `historicalPriorWeight` from 0 → 0.3 activates it. When `historicalHitRate` is available for a bucket, the final probability becomes `0.7 × raw + 0.3 × hist`, pulling over-confident NO predictions toward observed base rates.

## Expected effects

- Trade count per day drops sharply from the recent ~9/day baseline.
- Every trade stakes ≥ $5 (or skips).
- The `P(YES)<10%` bucket — the dominant loser — sees fewer entries as the prior blend pulls probabilities above the 20¢-edge threshold fewer times.
- Capital is no longer thinly sprayed across many −EV micro-positions.

## Post-funding knobs to revisit

After the user tops up bankroll:
- `seedCapital` (currently `17556` = $175.56)
- `minBalanceFloor` (currently `5000` = $50)
- `maxExposurePerTicker` — may want to scale proportionally past `1000¢`
- ~~`flatBetSizeCents` — consider tiered sizing ($5 at 80% confidence, $10 at 85%+) once current regime shows clean behavior~~ **Shipped 2026-05-23 as a single high-conf tier ($10 at conf ≥ 0.95) — see [confidence-tier-sizing.md](./confidence-tier-sizing.md). Data showed the 0.90–0.95 band is a *loser*, so no intermediate tier was added.**

## Verification

- Unit tests: `app/execution/services/execution.test.ts` — flat sizing describe block covers flat-override, Kelly fallback, no-edge skip, and exposure-cap trim.
- Unit tests: `app/signals/services/estimator.test.ts` — existing "historical prior blend" describe block covers weight=0.3 math, weight=0 regression guard, and clamping.
- Smoke: run with `DRY_RUN=true`, confirm most signals skip on edge/confidence/Kelly, surviving signals log `N × P¢ ≈ 500¢`.

## Out of scope

- Repairing the `station_bias` / `weather_forecasts` retention chain (tracked in [post-sharpening-regression.md](./post-sharpening-regression.md)). Historical prior blend is the short path; the bias chain is the deeper repair.
