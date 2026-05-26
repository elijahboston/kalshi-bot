# Execution unblock (2026-05-26): high-conf cheap-contract bypass + paper-mode reserve fix + skip-reason propagation

## Why this exists

The 2026-05-26 audit (see chat transcript) found that the bot was silently rejecting **6,542 of 6,599 actionable signals (99.1%)** since 2026-05-15. The two biggest offenders, ordered by lost edge:

1. **`minContractPrice = 15¢`** was filtering every actionable tail signal (1,807 over 11 days). Sample loser:
   ```
   KXHIGHLAX-26MAY25-T70  buy_yes  conf=0.92  edge=27.0¢  price=1¢  → BLOCKED
   ```
   The bot's highest-conviction, highest-edge signals live on cheap markets and were all being thrown away as "lottery tickets."

2. **Profit reserve** was locking ~$149 of paper bankroll because `seedCapital = 17556 ($175.56)` is a stale snapshot from an earlier balance, while current paper balance is **$473.51**. `availableBalance` was ~$273 instead of ~$418.

3. **Skip reasons** were collapsed to a single generic string `"execution skipped (position/size limits)"` for every blocked signal — couldn't attribute which guard was responsible without log-spelunking.

## Changes

### Change 1 — Skip-reason propagation

`executeSignal` now returns `ExecuteSignalResult = { orderId: string|null; skipReason: string|null }`. Each guard sets `skipReason` to a specific human-readable string. The orchestrator writes that string to `signals.skip_reason`, so we can now run:

```sql
SELECT skip_reason, COUNT(*) FROM signals WHERE created_at > '...' GROUP BY skip_reason;
```
…and get a real breakdown of which guard is biting.

Files:
- [`app/execution/services/execution.ts`](../../app/execution/services/execution.ts) — new `ExecuteSignalResult` type, `skip()` / `placed()` helpers, every guard updated
- [`app/engine/services/orchestrator.ts`](../../app/engine/services/orchestrator.ts) — caller updated to read `result.orderId` / `result.skipReason`

### Change 2 — `minContractPrice` bypass for high-confidence signals

When `signal.confidence >= config.bot.highConfidenceThreshold` (default 0.95), the `minContractPrice` filter no longer applies. The Kelly EV-sign gate already filters genuinely bad bets; the price floor was a safety net against low-confidence cheap-market bets that conf-gating already handles.

Disabled when `highConfidenceThreshold = 0` (preserves old behavior for anyone who explicitly turns the tier off).

[`execution.ts:278`](../../app/execution/services/execution.ts#L278)

### Change 3 — No profit reserve in dry_run

```ts
const profitReserve = config.bot.dryRun
  ? 0
  : Math.round(profit * config.bot.profitReservePct);
```

Paper bankroll has no deposited capital to protect, and a stale `seedCapital` will silently confiscate large fractions of paper gains. In live mode the reserve still applies. [`orchestrator.ts:419`](../../app/engine/services/orchestrator.ts#L419)

## Expected effects

After deploy:

- **Tail signals start trading.** Currently 0 actions / 1,807 actionable per 11 days. Expect a meaningful share of those to clear the gate once `minContractPrice` no longer blocks 1¢ pricing on high-conf signals.
- **Effective paper bankroll restored** from ~$273 → ~$418 (+53%). This unlocks the `$10` high-conf tier consistently (was at the edge of fitting through reserves).
- **DB-queryable skip-reason attribution.** Within one tick cycle, `signals.skip_reason` should show varied strings instead of one generic line. Use this to prioritize the next round of guard tuning.

## Tests

[`app/execution/services/execution.test.ts`](../../app/execution/services/execution.test.ts) — three new describe blocks:

- **`minContractPrice high-confidence bypass`** (3 tests): below-threshold blocks; above-threshold allows; disabled threshold preserves old behavior
- **`skip reason propagation`** (4 tests): max-positions / cooldown / Kelly-negative / success all return appropriate strings

Suite: 44 → 51 execution tests. Full project suite green.

## Risk

- **`minContractPrice` bypass** could let through a high-conf signal where the confidence itself is wrong (estimator calibration is still ~50pp off on near-mean tight brackets). Mitigation: the bypass requires confidence ≥ 0.95, which is empirically the only bucket where the bot doesn't bleed. Worst case we generate a few losing 1¢ bets — capped at $5–10 per signal by flat sizing.
- **Profit reserve skip** is a paper-mode-only behavior. Live mode unchanged. If/when we go live, `seedCapital` should also be updated to reflect actual deposited amount (separate todo).

## What this doesn't fix

- Underlying estimator calibration gap (~50pp on tight near-mean brackets) — see [calibration-deep-dive-2026-05.md](./calibration-deep-dive-2026-05.md).
- Adaptive thresholds table is still empty (0 rows) — separate followup.
- `recomputeStationBias` still uses mean/std (not robust to outliers).
- `synthesizeForecastFromSignal` has no staleness check.

These are queued for the post-recheck pass (target ≥2026-05-31).

## Verification

- `bun test` — full suite green
- After deploy, watch:
  - `signals.skip_reason` values diversify in DB
  - At least one upper_tail or lower_tail signal acts within 24h
  - Orchestrator log line `Reserves: ... profit (...%)` shows `profit (0%)` in dry-run instead of the 50% line
