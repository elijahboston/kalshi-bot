# Confidence-tier sizing: scale up the $10 bet on conf ≥ 0.95 signals

**Date:** 2026-05-23
**Status:** Implemented (config + execution + tests)

## Why

The [conviction-sizing](./conviction-sizing.md) Apr 23 work flattened all bets to $5 and left "tiered sizing ($5 at 80% confidence, $10 at 85%+)" as a follow-on once the regime was clean. After the four May 5 fixes (tail markets, cost-basis math, bias-correction horizon, config drift) and the May 9 σ blend, ~2 weeks of post-restart paper data is now available. Bucketed by signal confidence:

| Confidence | Resolved trades | Win rate | Total PnL |
|---|---|---|---|
| **≥ 0.95** | 21 | **56.5%** | **+$8,380** |
| 0.90 – 0.95 | 40 | 32.5% | -$5,590 |
| 0.85 – 0.90 | 6 | 50.0% | +$2,280 |
| < 0.85 | 1 | 0% | -$500 |

Confidence IS predictive — but **non-monotonic**. The 0.90–0.95 band is the dominant *losing* bucket; scaling up there would compound losses. The 0.95+ band is the entire edge. The right move is a single high-conf tier above the $5 base, not a graduated $5/$10/$15 ladder.

## Change

Two new knobs in [`packages/config/src/index.ts`](../../packages/config/src/index.ts):

| Knob | Default | Notes |
|---|---|---|
| `highConfidenceThreshold` | **0.95** | Confidence ≥ this triggers tier sizing. `0` = disabled. |
| `highConfidenceBetSizeCents` | **1000** ($10) | Stake when threshold met. |

Env vars: `HIGH_CONFIDENCE_THRESHOLD`, `HIGH_CONFIDENCE_BET_SIZE_CENTS`.
Runtime keys: `high_confidence_threshold`, `high_confidence_bet_size_cents`.

### Sizing logic ([`app/execution/services/execution.ts`](../../app/execution/services/execution.ts))

```ts
const isHighConfidence =
  config.bot.highConfidenceThreshold > 0 &&
  signal.confidence >= config.bot.highConfidenceThreshold &&
  config.bot.highConfidenceBetSizeCents > 0;
const flatSize = isHighConfidence
  ? config.bot.highConfidenceBetSizeCents
  : config.bot.flatBetSizeCents;
const betAmount = flatSize > 0 ? flatSize : Math.floor(balance * cappedKelly);
```

All existing gates remain authoritative: Kelly EV-sign (cappedKelly > 0), `minContractPrice`, `maxExposurePerTicker`, `maxContractsPerOrder`, `minBetSizeCents`, anti-churn cooldown, loss-elevated-edge. The tier never bypasses them — it only swaps the dollar amount.

The `Executing:` log line now appends `HIGH-CONF(0.97)` when the tier triggers and surfaces `flat:` alongside Kelly/edge.

## Expected effects

- Same trade volume (the gate is `minConfidence = 0.80`, untouched).
- ~25% of recent traded signals (21/68) clear 0.95 → those get $10 instead of $5.
- 0.90–0.95 signals (40/68 = ~60% of volume) still get $5 — they bleed historically, but this PR doesn't widen the exposure there.
- Per-signal max loss doubles for the high-conf tier, capital allocation tilts toward the empirically-winning bucket.

## Runtime-config follow-ups (NOT shipped automatically)

The current production `runtime_config` table overrides:
```
max_exposure_per_ticker = 800   # $8 cap per ticker
```

This will trim a $10 first entry down to $8 worth of contracts (still passes the $5 min). To let the full $10 tier through cleanly, bump it:
```sql
UPDATE runtime_config SET value = '2000' WHERE key = 'max_exposure_per_ticker';
-- ($20 = room for a $10 entry plus one $10 add)
```

The two new tier knobs ship with the documented defaults baked into `loadConfig()`, so no runtime_config insert is required to activate the feature. Override them only if you want to shift the threshold (e.g. to 0.93) or stake ($15 instead of $10) without redeploying.

## Verification

- Unit tests: `app/execution/services/execution.test.ts` — new `confidence-tier sizing` describe block covers tier activation, exact-threshold (`>=`), below-threshold fallback, disabled tier (`= 0`), Kelly-gate interaction, exposure-cap trim, and Kelly fallback when `flatBetSizeCents = 0`.
- Smoke: with `DRY_RUN=true`, watch for log lines tagged `Executing: HIGH-CONF(0.9x)` on signals that score above 0.95. Expect `flat: 1000¢` on those; `flat: 500¢` otherwise.
- Post-deploy recheck (≥ 5 trading days, ~2026-05-30): re-run the confidence-bucket PnL table above. The 0.95+ bucket should remain in the black at the larger size; if it inverts, drop `high_confidence_bet_size_cents` back to 500 via runtime_config (no redeploy).

## Out of scope

- Raising `minConfidence` from 0.80 to filter out the 0.90–0.95 losing band — bigger behavior change, defer until we have a longer post-tier-sizing window to attribute outcomes.
- Adding a tier 2 ($15 at 0.97+) — sample at 0.95+ is only n=21; another threshold would split too thin to learn from. Revisit after volume accumulates.
- Tuning `maxExposurePerTicker` runtime override — flagged above; user-managed.
