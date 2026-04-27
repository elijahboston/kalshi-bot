# Post-Sharpening Regression Diagnostic (2026-04-22)

The user proposed depositing $100 and ramping bet sizes, believing the Apr 14 forecast-sharpening work (5800acf) and the Apr 21 bug fixes (b9fee76) had improved performance. Investigation showed the premise was wrong in one direction and the root cause lies elsewhere than initially suspected.

## TL;DR

- **Brier "regression" 0.231 → 0.349 is mostly sample-size noise and outcome-distribution shift.** Post-Apr-14 trading is only 54 trades with -$8.25 combined PnL; the historical -$444.83 loss happened almost entirely pre-Apr-2.
- **The real issue** is systematic overconfidence in NO: when the bot predicts `P(YES) < 10%`, actuals hit YES **33.8%** of the time (263 trades, -$352.73 loss).
- **Root cause:** the self-improvement feedback loop is structurally dead. `station_bias` has 0 rows, `weather_forecasts` retains only 36 rows (all Apr 21–22), and `historicalHitRate` is computed but never blended into the final probability.
- **Shipped Apr 22 (bce5241):** `historical_prior_weight` runtime flag blends `historicalHitRate` into the final probability. Runtime config set to `0.3` the same day; traces confirm the blend is active.
- **Shipped Apr 23 (eb8ee44):** retention-resilient `backfillActualValue` — when no cached forecast row exists for a resolved market, synthesize one from the signal's reasoning trace + NWS actual. One settled market is now enough to seed `station_bias`, independent of whatever keeps wiping `weather_forecasts`.

## Window decomposition (calibration table, n=445)

| Window | Dates | N | Brier | Hit rate | Avg pred | Traded | PnL |
|---|---|---|---|---|---|---|---|
| A pre-threshold-fix | <Apr 2 | 281 | 0.231 | 27.1% | 7.8% | 226 | -$444.83 |
| B threshold only | Apr 2–14 | 110 | 0.279 | 30.9% | 7.9% | 102 | +$0.41 |
| C sharpening | Apr 14–21 | 35 | 0.424 | 48.6% | 9.2% | 32 | -$6.92 |
| D all fixes | Apr 21+ | 19 | 0.349 | 42.1% | 8.5% | 18 | -$1.33 |

The Brier jump in C is real but on 35 samples, and most of it is the Brier-decomposition `uncertainty` term: mean outcome rose from 27% to 49%, which alone adds ~0.05 to Brier independent of estimator quality. Post-fix losses (-$8.25 total) are a rounding error vs the pre-fix -$444.83. The visible "balance decline from $78.78 to $67.58 since Apr 2" is dominated by closeout friction on positions opened earlier.

All 445 rows are `high_temp` / `KXHIGH`. The memory note that other categories are supported end-to-end does not hold for calibration in practice.

## Prediction bucket analysis (only traded rows)

| Predicted P(YES) | N | Actual YES rate | Total PnL |
|---|---|---|---|
| <10% | 263 | **33.8%** | -$352.73 |
| 10–25% | 103 | **35.9%** | -$93.29 |
| 25–50% | 10 | 30.0% | -$34.23 |
| >50% | 2 | 100% | +$27.58 |

The bot's "low YES probability" calls are wildly miscalibrated. Saying `P(YES)=4%` when true `P(YES)=34%` means NO-side bets priced at the market's ~0.3 are routinely wrong.

## Reasoning-trace inspection (10 biggest post-Apr-14 losses)

Sampled biggest losers from the `calibration`/`signals` join. Four findings:

1. **`biasCorrection: null` on every single trace.** The estimator's bias path never fires.
2. **`sigmaUsed = sigmaAfter = 0.5 × sigmaBefore`** in Apr 17–21 traces (observation adjustment was halving sigma based on a single same-day obs). Commit b9fee76 loosened this to 0.7× on Apr 21, so pre-fix losses in this cohort are not comparable going forward.
3. **`historicalHitRate ≈ 0.39`** is recorded in traces (e.g., KAUS 88.5–89.5 high_temp, 33/84 similar resolves YES) but never influences the final probability. The estimator surfaces the right signal in debug and throws it away.
4. **`rawEnsembleStats.count = 120–150`** consistently — ensemble size is healthy. HRRR is being ingested. Not a data-fetch bug.

## Why bias correction never fires

The feedback loop is `weather_forecasts` → `recomputeStationBias` → `station_bias` → `estimator.getBiasCorrection`. Two observed facts kill it (state at time of diagnostic, 2026-04-22):

- `SELECT * FROM station_bias` returns 0 rows.
- `weather_forecasts` holds only 36 rows, all `fetched_at` on Apr 21–22, and every row has `actual_value IS NULL`.

`recomputeStationBias` ([reconciliation.ts:1100](../../app/engine/services/reconciliation.ts#L1100)) requires rows where `pointForecast` and `actualValue` are both non-null. There were zero such rows. The original `backfillActualValue` only *updated* existing rows — if `weather_forecasts` was empty for the market's date, it did nothing.

Cache-refresh logic in [ensemble.ts](../../app/data/services/ensemble.ts) deletes-then-inserts per (station, target_date, source, type) — a direct experiment on 2026-04-23 (manually inserting a row with `target_date='2026-04-20'` and watching it survive tick cycles) confirmed the cache logic is surgical. The wipes are external (DB recreations, manual cleanup, or the log-review agent touching the DB). The backfill fix below makes this non-blocking.

Original concern: fixing the retention issue would take 10+ days of data accumulation before `station_bias` has the `sampleSize >= 10` needed to activate empirical sigma. The synthesis fix below collapses this to one resolved market per station/horizon.

## Why `historicalHitRate` is wasted

`ProbabilityEstimator.getHistoricalHitRate` ([estimator.ts:295-321](../app/signals/services/estimator.ts#L295)) queries the `calibration` table for same-station/category/bracket resolutions over `calibrationWindowDays` (30d, 281+ rows available) and returns the hit rate when ≥5 samples exist. It's called on every estimate and stored in the reasoning trace, but `rawProbability` at [estimator.ts:197](../app/signals/services/estimator.ts#L197) is `countingWeight * countingProb + (1 - countingWeight) * cdfProb` — no historical term. The value is informational only.

Closing this gap is cheap, reversible, data-driven, and uses the table that's currently the only healthy source of ground truth.

## Remediation

### Shipped: gated historical-prior blend (commit bce5241, 2026-04-22)

`BotConfig.bot.historicalPriorWeight` (env `HISTORICAL_PRIOR_WEIGHT`, runtime key `historical_prior_weight`, default `0`). When the knob is > 0 and `historicalHitRate != null`:

```
blended = (1 - w) * rawProbability + w * historicalHitRate
probability = clamp(blended, floor, 1 - floor)
```

Runtime config has `historical_prior_weight = 0.3` since 2026-04-22 17:13. Signal traces confirm the blend is active — e.g. KAUS 87.5–88.5 on 2026-04-24 shows `rawProbability=0.108 → blendedProbability=0.186` with `historicalHitRate=0.370`.

### Shipped: retention-resilient actual-value backfill (commit eb8ee44, 2026-04-23)

`backfillActualValue` ([reconciliation.ts:921](../../app/engine/services/reconciliation.ts#L921)) was only useful when a cached forecast row already existed. With `weather_forecasts` being wiped externally, resolved markets produced no (pointForecast, actualValue) pair and `station_bias` stayed at 0 rows indefinitely.

Refactored into three methods:
- `backfillActualValue` — orchestrator with two branches.
- `fetchNwsActualValue` ([reconciliation.ts:986](../../app/engine/services/reconciliation.ts#L986)) — extracted NWS observation fetch (max/min temp, precip) with unit conversion.
- `synthesizeForecastFromSignal` ([reconciliation.ts:1046](../../app/engine/services/reconciliation.ts#L1046)) — new: reconstructs a forecast row from the most recent `signals.reasoning` trace for the ticker.

The branches:
- **Row exists, missing actual:** fill `actual_value` from NWS (unchanged behavior).
- **No row at all:** pull the most recent `signals.reasoning` trace for the market, extract `correctedEnsembleStats.mean` as `point_forecast` plus `rawEnsembleStats` for ensemble metadata, fetch actual from NWS, and insert a synthesized row with `source='backfilled'`.

Result: a single settled market with a cached signal is enough to populate `station_bias` on the next reconciliation — no 10+ day accumulation wait even if retention continues to break. Callers already pass the full market row, so `ticker` is available for the signal lookup without a signature change at call sites.

**Test coverage** ([reconciliation.test.ts](../../app/engine/services/reconciliation.test.ts)): 7 new tests covering update-existing, synthesize-when-missing, no-op-when-filled, no-synthesis-without-reasoning, no-synthesis-without-ticker, no-synthesis-without-NWS-actual, and end-to-end recomputeStationBias-readiness. Full suite: 378 pass, 0 fail.

### Deferred

- **Root-cause of weather_forecasts wipes.** ~~Still unknown.~~ **Resolved 2026-04-26**: the wipes were the test suite. Tests using `runMigrations()` with no path defaulted to `./data/kalshi-bot.db` (production), then `beforeEach` `db.delete(...)` cleanups silently destroyed live data. See [test-db-wipe-incident.md](test-db-wipe-incident.md) for the full post-mortem. Fixed via `bunfig.toml` test preload that forces `DB_PATH=:memory:`. The Apr 23 retention-resilient backfill above remains useful as defense in depth.
- **Observation-adjustment sigma multiplier.** Already loosened 0.5×→0.7× on Apr 21. Post-loosening data is too thin to tell if further loosening is needed. Revisit after 2 weeks.
- **Per-category calibration.** All current calibration data is `high_temp`. Before enabling precip/snow trading again, ensure those categories actually produce rows.

## Ramp-up gate

Before any deposit and before raising `max_kelly_fraction` / `max_exposure_per_ticker`:

1. ~~Land historical-prior blend with `historical_prior_weight = 0.3`.~~ ✅ Done 2026-04-22 (bce5241), runtime weight set to 0.3.
2. Let it run ≥5 trading days. ~~**Clock started 2026-04-22; earliest evaluation window 2026-04-27.**~~ Clock reset by Apr 26 DB wipe. **New earliest evaluation: 2026-05-07** (10 days for calibration rebuild + blend activation).
3. Re-run the prediction-bucket analysis above. Target: `pred<10%` bucket hit rate drops below 20% (still badly over-confident but the gap closes), or equivalently predicted probability in the `pred<10%` bucket rises above 10% on average.
4. Only then recommend the deposit.

Secondary signal now that Apr 23 backfill is shipped: `SELECT COUNT(*) FROM station_bias` should become > 0 within a few days of settled markets, and `biasCorrection` in reasoning traces should stop being `null` for stations with ≥10 samples. If it stays empty, investigate whether the synthesis path is firing (log.debug `"Synthesized weather_forecast…"`).

## 2026-04-27 Five-day recheck — INCONCLUSIVE (DB wipe invalidated the window)

### Runtime config

```
historical_prior_weight = 0.3  (set 2026-04-22 17:13:32) ✅
```

### Blend activation: NOT ACTIVE

Sampled 3 post-wipe acted signals (2026-04-26 17:16–20:04). All show:
- `historicalHitRate`: NULL
- `blendedProbability`: NULL
- `biasCorrection`: null

Root cause: the [2026-04-26 production DB wipe](test-db-wipe-incident.md) destroyed 457 of 459 calibration rows. `getHistoricalHitRate` requires ≥5 same-station/category resolutions per bracket. With only 2 surviving calibration rows (both from 2026-04-20 test fixtures), the function returns `null` for every estimate and the blend silently falls back to unblended `rawProbability`. The bot has been running in effectively pre-fix mode since the wipe.

### Post-fix calibration data

| Metric | Value |
|---|---|
| Calibration rows resolved after 2026-04-22 | **0** |
| Total calibration rows | 2 |
| Post-wipe signals (since Apr 26) | 7,440 (3 acted) |
| station_bias rows | 0 |

**No prediction-bucket or Brier analysis is possible.** Zero markets have resolved and been reconciled into the calibration table since the wipe.

### Baseline comparison

| Metric | Baseline (2026-04-22) | Current (2026-04-27) |
|---|---|---|
| pred<10% hit rate | 29.86% (N=211) | — (N=0) |
| pred<10% avg pred | 3.9% | — |
| Total traded PnL | -$455.66 | — |
| Brier (all) | 0.268 | — |
| Blend active? | N/A (not yet deployed) | ❌ Silently inactive |

### Why the evaluation window is invalid

1. **DB wipe (Apr 26 06:25)** destroyed calibration, signals, and balance_history. The 5-day evaluation window (Apr 22–27) was cut short to ~4 days of data accumulation, then reset to zero.
2. **Blend is structurally disabled** post-wipe because `getHistoricalHitRate` has no calibration rows to query. Even if markets had resolved, the estimator would produce unblended probabilities — defeating the purpose of the test.
3. **Paper-trading clock also reset.** The Apr 24 paper run (2 days of dry_run data) was lost.

### What needs to happen before re-evaluation

1. **Rebuild calibration data.** The bot needs to accumulate ≥30 resolved markets into the calibration table. At current volume (~3 acted signals/day on high_temp), this requires roughly 10+ trading days assuming daily market resolution cycles.
2. **Re-seed historicalHitRate.** Once ≥5 rows exist per station/category/bracket, `getHistoricalHitRate` will return non-null and the blend will activate automatically (no restart needed — it checks per-estimate).
3. **Verify blend activation.** After ~5 calibration rows per bracket accumulate, spot-check: `json_extract(reasoning, '$.historicalHitRate')` should be non-null in new signals.

### Recommendation: WAIT

- **Do NOT deposit $100.** The fix has not been testable since the DB wipe.
- **Do NOT raise bet sizes.** The bot is currently running with the same overconfident-in-NO behavior documented in the original diagnostic.
- **Re-evaluate on 2026-05-07** (10 days from now). By then the bot should have accumulated enough calibration rows for the blend to activate and produce a meaningful sample.
- **Verify the `bunfig.toml` test preload is working** to prevent another wipe: `bun test` should show `DB_PATH=:memory:` in test output. The fix (commit 8370471) is in place but has only been live for ~1 day.
- Consider the LaunchAgent for this recheck: the annual recurrence (Apr 27) won't fire again for a year. Either create a new one-shot agent for May 7, or run the check manually.

### Anomalies

- **Only 3 acted signals since the wipe** (1.5 days). This is low but consistent with paper-trading mode (`dry_run=true`) and the bot's selectivity. Worth confirming the bot loop is healthy: `SELECT COUNT(*), MAX(created_at) FROM signals WHERE created_at > '2026-04-26'` should show continuous tick activity.
- **station_bias still 0 rows.** Expected — no markets have resolved post-wipe, so the backfill synthesis path hasn't had a chance to fire.
