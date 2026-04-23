# Post-Sharpening Regression Diagnostic (2026-04-22)

The user proposed depositing $100 and ramping bet sizes, believing the Apr 14 forecast-sharpening work (5800acf) and the Apr 21 bug fixes (b9fee76) had improved performance. Investigation showed the premise was wrong in one direction and the root cause lies elsewhere than initially suspected.

## TL;DR

- **Brier "regression" 0.231 → 0.349 is mostly sample-size noise and outcome-distribution shift.** Post-Apr-14 trading is only 54 trades with -$8.25 combined PnL; the historical -$444.83 loss happened almost entirely pre-Apr-2.
- **The real issue** is systematic overconfidence in NO: when the bot predicts `P(YES) < 10%`, actuals hit YES **33.8%** of the time (263 trades, -$352.73 loss).
- **Root cause:** the self-improvement feedback loop is structurally dead. `station_bias` has 0 rows, `weather_forecasts` retains only 36 rows (all Apr 21–22), and `historicalHitRate` is computed but never blended into the final probability.
- **Targeted fix:** blend `historicalHitRate` into the final probability behind a `historical_prior_weight` runtime flag (defaulted to 0). Uses data already in the `calibration` table (445 rows) without waiting for the weather_forecasts retention issue to be fixed.

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

The feedback loop is `weather_forecasts` → `recomputeStationBias` → `station_bias` → `estimator.getBiasCorrection`. Two observed facts kill it:

- `SELECT * FROM station_bias` returns 0 rows.
- `weather_forecasts` holds only 36 rows, all `fetched_at` on Apr 21–22, and every row has `actual_value IS NULL`.

`recomputeStationBias` ([reconciliation.ts:1009-1096](../app/engine/services/reconciliation.ts#L1009-L1096)) requires rows where `pointForecast` and `actualValue` are both non-null. There are zero such rows. The `backfillWeatherActuals` path ([reconciliation.ts:920-1004](../app/engine/services/reconciliation.ts#L920-L1004)) does try to backfill from NWS for any market whose target date has passed, but if `weather_forecasts` doesn't retain historical rows, there's nothing to update.

Cache-refresh logic in [ensemble.ts:655-664](../app/data/services/ensemble.ts#L655-L664) deletes-then-inserts per (station, target_date, source, type). That by itself should preserve past-date rows, so the retention problem is likely external — possibly a DB recreation around Apr 21. Either way the estimator has been running blind for weeks.

Fixing the retention issue will take 10+ days of accumulated data before `station_bias` has the `sampleSize >= 10` needed to activate empirical sigma. We need something that works today.

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

### Shipped: retention-resilient actual-value backfill (2026-04-23)

`backfillActualValue` ([reconciliation.ts](../../app/engine/services/reconciliation.ts)) was only useful when a cached forecast row already existed. With `weather_forecasts` being wiped externally (DB recreations, hand-cleanup, or otherwise), resolved markets produced no (pointForecast, actualValue) pair and `station_bias` stayed at 0 rows indefinitely.

The backfill now has two branches:
- **Row exists, missing actual:** fill `actual_value` from NWS (unchanged behavior).
- **No row at all:** pull the most recent `signals.reasoning` trace for the market, extract `correctedEnsembleStats.mean` as `point_forecast` plus `rawEnsembleStats` for ensemble metadata, fetch actual from NWS, and insert a synthesized row with `source='backfilled'`.

This means a single settled market with a cached signal is enough to populate `station_bias` the next time reconciliation runs — no 10+ day data-accumulation wait even if retention continues to break.

### Deferred

- **Root-cause of weather_forecasts wipes.** Still unknown. Direct experiment (manually inserting a row with `target_date='2026-04-20'`) confirmed the cache delete-then-insert logic in `ensemble.ts` is surgical — past-date rows survive tick cycles. The wipes are external (migration run, manual DB work, or the log-review agent). The backfill fix above makes this non-blocking.
- **Observation-adjustment sigma multiplier.** Already loosened 0.5×→0.7× on Apr 21. Post-loosening data is too thin to tell if further loosening is needed. Revisit after 2 weeks.
- **Per-category calibration.** All current calibration data is `high_temp`. Before enabling precip/snow trading again, ensure those categories actually produce rows.

## Ramp-up gate

Before any deposit and before raising `max_kelly_fraction` / `max_exposure_per_ticker`:

1. Land historical-prior blend with `historical_prior_weight = 0.3`.
2. Let it run ≥5 trading days.
3. Re-run the prediction-bucket analysis above. Target: `pred<10%` bucket hit rate drops below 20% (still badly over-confident but the gap closes), or equivalently predicted probability in the `pred<10%` bucket rises above 10% on average.
4. Only then recommend the deposit.
