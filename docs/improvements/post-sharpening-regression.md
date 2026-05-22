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

## 2026-05-04 Three-day-early recheck — bias correction silently disabled

Calibration table is back at 194 rows (mostly KXHIGH same-day brackets resolving daily). `station_bias` finally has 6 rows — one per enabled station, all `forecast_horizon_days=1`, sample sizes 16 each. Mean biases are large and consistent: KORD -2.06°F, KMIA -1.58°F, KAUS -1.51°F, KDEN -1.18°F, KLAX -0.65°F, KNYC +0.43°F. Forecasts run consistently cold across most stations.

### Calibration result is worse where it matters

| Bucket | Status | N | YES rate | Avg pred | Avg mkt | PnL |
|---|---|---|---|---|---|---|
| <10% | skipped | 81 | 9.9% | 5.9% | 22.2% | — |
| <10% | **traded** | 22 | **59.1%** | 6.2% | 30.3% | -$8.50 |
| 10–20% | skipped | 68 | 10.3% | 13.4% | 23.5% | — |
| 10–20% | **traded** | 10 | **80.0%** | 14.9% | 28.5% | -$17.50 |
| 20–30% | traded | 2 | 100% | 21.8% | 32.5% | -$10.00 |

Skipped markets calibrate fine (~10% pred → ~10% YES). The bot is **selectively wrong on the markets it actually trades**. Cumulative paper PnL: -$36 over 30 days, -$25 today, -$21 yesterday.

### Root cause: same-day markets miss bias correction

`signals.reasoning` traces show the historical-prior blend IS firing (e.g. KXHIGHCHI-26MAY04-B80.5: rawProb=0.005 → blended=0.060 with hist=0.19, w=0.3). But every recent trace has `biasCorrection: null` despite station_bias being populated.

The mismatch:
- `recomputeStationBias` ([reconciliation.ts:1154](../../app/engine/services/reconciliation.ts#L1154)) stores rows with `forecastHorizon: Math.max(1, trace.forecastHorizon ?? 1)` — minimum 1.
- `ProbabilityEstimator.estimate` ([estimator.ts:79-83](../../app/signals/services/estimator.ts#L79-L83)) computed `forecastHorizon = Math.ceil((targetDate - now) / 86400_000)`. For same-day markets, `targetDate` is parsed as midnight-UTC and is in the past for any tick after 00:00 UTC, yielding `horizon = 0`.
- `getBiasCorrection` looks up by exact horizon match; horizon=0 query against horizon=1 rows returns nothing. Bias silently null.

This kills both bias correction AND the empirical-sigma path that depends on `biasCorrection.sampleSize >= 10`. Same-day markets are most of the bot's volume (sniper window 12h before close), so the production bot has been running with neither correction nor empirical sigma since station_bias started populating.

Effect on the failing trades: KORD's -2°F bias would shift ensemble means up 2°F. Bracket B80.5 markets sit ~2°F above the (uncorrected) ensemble mean, so a 5% predicted YES becomes much higher with the correction applied. That matches the observed 59% actual YES rate.

### Shipped: floor estimator horizon at 1

[estimator.ts:79-91](../../app/signals/services/estimator.ts#L79-L91): wrap the horizon computation in `Math.max(1, …)` so estimator and reconciliation use the same horizon space. Test added in [estimator.test.ts](../../app/signals/services/estimator.test.ts) covering same-day market with horizon=1 bias row, asserting both biasCorrection fires and sigmaSource is "empirical".

Verification path post-deploy: spot-check `json_extract(reasoning, '$.biasCorrection.meanBias')` is non-null for new signals on enabled stations within one tick cycle.

### Still recommend: WAIT on deposit

The blend was the documented fix; bias correction was assumed working. With both now in place, give it ≥5 trading days of resolved calibration rows before evaluating. If `pred<10% TRADED` hit rate drops below 30% (currently 59%), the bias-correction fix is doing real work.

## 2026-05-05 Follow-up: three more bugs and a config-drift discovery

After yesterday's bias-correction fix, deeper inspection turned up three more issues, all material. Combined effect on the eval framework: the May 7 recheck date is invalidated again — too many model variables changed in a single day to attribute outcomes cleanly to any one. New eval clock starts from bot restart with all four fixes deployed.

### 1. Tail markets never reached the estimator

[orchestrator.ts:102](../../app/engine/services/orchestrator.ts#L102) skipped any market with `bracketHigh == null`. Discovery deliberately stores tails (upper_tail / lower_tail) with `bracketHigh = null` because the threshold is `bracketLow` and there's no upper bound. The estimator's tail branch (`marketType === "upper_tail" || "lower_tail"`) was reachable in code but never receivable any markets — every tail was filtered out one phase earlier. Fixed: filter now mirrors the estimator's check (`!isTail && bracketHigh == null`). Per tick the estimation count goes from 48 → 72 (24 more tails: 12 upper + 12 lower across 6 stations). Tails fill the [0.7, 1.0] and [0.0, 0.3] tails of the prediction distribution that brackets structurally can't reach.

This filter dates to commit 2cb2e1b (Feb 22, 2026), pre-dating the April threshold-fix work that taught the estimator to handle tails. The estimator change never relaxed the upstream gate.

### 2. Position cost-basis math broken — disabled stop-loss

[reconciliation.ts:330](../../app/engine/services/reconciliation.ts#L330) reduced cost basis by *sell proceeds* (`qty × sell_price`) instead of by the proportional avg entry of contracts being closed. A profitable round-trip drove cost basis below zero, then the next buy inherited a negative starting point and produced an inverted avg entry price. Concrete example caught in production: KXHIGHNY-26MAY05-B81.5 with 5 trades (buy 20@25, sell 20@84, buy 20@25, sell 20@84, buy 10@50) showed `quantity=10, avg_entry_price=-186, cost_basis=-1860` — correct values are `cost=500, avg=50`.

Downstream effect on profitability: stop-loss check at [exit-eval.ts:42](../../app/engine/services/exit-eval.ts#L42) is `liveUnrealized = qty × currentPrice − costBasis`. With negative cost basis, unrealized always looked massively positive and stop-loss never fired. The 25% stop-loss has been **structurally disabled** for the entire evaluation window. Same for the per-ticker exposure cap at [execution.ts:280](../../app/execution/services/execution.ts#L280). This is a previously-unknown silent failure that contaminates the post-sharpening PnL data — losses captured in calibration include trades that should have been stopped out earlier.

Fixed: on sell, reduce cost by `closedQty × (totalCost / totalQty)`; snap to flat (`qty=0, cost=0`) on full close. Three regression tests added covering partial sell, profitable buy/sell/rebuy, and oversell.

### 3. `.env` config drift since Apr 23 conviction-sizing change

`.env` (last modified 2026-04-26) still has pre-conviction-sizing overrides:

```
EDGE_THRESHOLD=0.15      → intended 0.20
MIN_CONFIDENCE=0.65      → intended 0.80
MAX_KELLY_FRACTION=0.025 → intended 0.05  (covered by runtime_config: 0.05 ✓)
```

`maxKellyFraction` was already corrected via runtime_config. `edgeThreshold` and `minConfidence` were not — they sat at the old values for nearly two weeks. Effect: signals at confidence 0.74-0.77 (entire same-day cohort) cleared the gate, where conviction-sizing intended only ≥0.80 to clear. Edge gate at 15¢ vs intended 20¢ also let smaller-edge trades through. The conviction-sizing doc's expected-effects section ("Trade count drops sharply", "P(YES)<10% bucket sees fewer entries") never materialized because the gates weren't actually tightened in production.

Shipped: inserted `min_confidence=0.80` and `edge_threshold=0.20` into `runtime_config`, which overrides `.env` on next config load. `.env` itself left unchanged (user-managed file), but runtime_config is now authoritative.

### Combined impact on the May 4 calibration table

The 30-day calibration data in this doc covers a window during which:
- Bias correction was off for same-day markets (fixed yesterday)
- Tail markets weren't being signaled (fixed today)
- Cost-basis math broke stop-loss (fixed today)
- Confidence/edge gates were running at pre-conviction values (fixed today)

The −$36 paper PnL over 30 days is the *combined* loss across all four problems. Attribution of any individual fix to outcome change is impossible without a fresh window.

### New eval clock

Bot restart is required — the four fixes are in code (estimator.ts, orchestrator.ts, reconciliation.ts) and the runtime_config rows. Process config is a singleton cached at first `getConfig()` call ([config/src/index.ts:243-249](../../packages/config/src/index.ts#L243-L249)), so even runtime_config changes need a restart.

After restart:
1. Spot-check first tick logs: `Estimated N market(s)` should show ~72 (vs prior 48), confirming tails flow.
2. Confirm same-day signal traces have `biasCorrection: non-null` and `sigmaSource: "empirical"`.
3. Confirm signal recommendation rate drops sharply — most current signals have conf 0.74-0.77 and would now skip.
4. Watch for first stop-loss event in `orders` table (signalId pattern `bot-exit`) — should fire on positions losing >25% from now on, where previously they wouldn't.
5. Re-run prediction-bucket analysis after 5 trading days of post-restart calibration rows. Earliest meaningful eval: 2026-05-12.

### Status of earlier deferred items

- **Per-category calibration:** still 0 rows for precip/snow. Today's tail unlock will start showing precip predictions, but the markets are series-gated by config — see [enabledSeries](../../packages/config/src/index.ts) (currently empty = all). No change needed; will populate organically as the signal mix diversifies.
- **Observation-adjustment sigma multiplier (0.7×):** May 5 is the 2-week mark from the Apr 21 loosening. Cannot evaluate yet — same-day trades dominated the window and were running with broken bias correction, so sigma path is contaminated. Defer until clean post-restart data exists.

## 2026-05-09 Three-day-post-restart review — empirical sigma is too narrow

Trade review across the 15 resolved + 4 open trades since the May 5 restart. Net PnL is **+$0.20** (six +$5–$20 wins offset nine –$5 losses), so the bot is no longer bleeding — but every loss shares one shape.

### Failure mode

All nine losses were `buy_no` on bracket markets where the **corrected ensemble mean sits inside or right at the bracket edge**, but the model still assigned ≤25% to YES. Examples (all resolved YES):

| Ticker | Bracket | Corr. mean | σ used | Pred YES | Outcome |
|---|---|---|---|---|---|
| KXHIGHCHI-26MAY07-B60.5 | [60.5, 61.5] | 60.24°F | 1.16 | 25% | YES |
| KXHIGHNY-26MAY07-B64.5 | [64.5, 65.5] | 64.50°F | 1.15 | 22% | YES |
| KXHIGHMIA-26MAY07-B91.5 | [91.5, 92.5] | 91.73°F | 1.06 | 17% | YES |
| KXHIGHAUS-26MAY07-T70 (lower_tail) | <70°F | 70.27°F | 2.02 | 28% | YES |

When the corrected mean is inside a 1°F bracket, a well-calibrated model with realistic σ should assign 30–40% YES, not 17–25%.

### Root cause: empirical σ overfits its own bias-correction window

`station_bias` rows currently hold n=24 samples per station and the `stdBias` is the std of (forecast – actual) residuals **over those same 24 samples after subtracting the empirical mean bias from them**. Residuals fit on small data are systematically tighter than out-of-sample errors. Production averages bear this out:

| Station | empirical σ (°F) | ensemble σ (°F) | sigma used |
|---|---|---|---|
| KMIA | 1.20 | 2.30 | 0.94 |
| KLAX | 1.79 | 4.68 | 1.52 |
| KAUS | 2.29 | 4.64 | 1.77 |
| KORD | 1.60 | 1.67 | 1.25 |

KMIA's effective σ is 2.5× tighter than ensemble spread. At those σs, a 1°F bracket two σs from the mean gets <5% probability — directly producing the over-confident NO calls.

### Shipped: sample-size-weighted σ blend (commit pending, 2026-05-09)

[estimator.ts:130–155](../../app/signals/services/estimator.ts#L130) — replaced the `n ≥ 10` cliff with a continuous blend:

```
w        = min(1, sampleSize / 50)
sigmaUsed = w * empiricalSigma + (1 - w) * ensembleSigma
```

`sigmaSource` keeps the union type (`"empirical" | "ensemble"`) and labels by which side dominates (`w ≥ 0.5`). New trace field `empiricalSigmaWeight` exposes the actual weight for debugging. Pure-empirical at n=50 (matches old behavior); pure-ensemble at n=0; intermediate sample sizes get a defensible widening.

Effect on the documented losers (with current n=24, w=0.48):
- KMIA σ: 0.94 → 1.78°F. P(91.5≤X≤92.5 | μ=91.73, σ=1.78) jumps from 17% to ~30%.
- KCHI σ: 1.16 → 1.42°F. Edge against market collapses below the 0.20 gate; trade likely skipped instead of buying NO.
- KAUS σ: 2.02 → 3.46°F. Tail probability widens enough to skip the trade.

The 20¢ edge gate doing the heavy lifting here: when σ widens, the bot's edge over market price shrinks, and most of these marginal NO bets stop clearing the gate.

### Tests

[estimator.test.ts:555–701](../../app/signals/services/estimator.test.ts#L555) — six tests covering: blend at n=50 (full empirical), n=25 (50/50, sigma strictly between), n=10 (mostly ensemble, "ensemble" label), no-bias (ensemble only), same-day horizon=1 lookup, and the centered-bracket scenario. Full suite: 413 pass, 0 fail.

### What this doesn't fix

- The historical-prior blend still pulls toward empirical hit rates (~12–20% YES historically for these brackets), which is correct for normal weather but mutes signal when the day genuinely is hot/cold. Not changing it now — its job is exactly to dampen overconfidence and it's doing that.
- KMIA-style markets with very narrow brackets (1°F) at the climatological mean will still be hard. Widened σ helps but doesn't make the bot an expert; the right answer for the marginal cases is to skip, which is what the edge gate now enforces.

### New eval clock

After bot restart picks up the σ blend:
1. Spot-check `json_extract(reasoning, '$.empiricalSigmaWeight')` is populated and `sigmaUsed` ≈ midway between empirical and ensemble σ.
2. Watch trade volume — expect another sharp drop as marginal NO bets fail the edge gate.
3. Re-run the bracket-edge analysis above after 5 trading days. Earliest meaningful eval: 2026-05-14.
