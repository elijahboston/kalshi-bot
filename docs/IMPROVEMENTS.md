# Suggested Improvements

Ordered by expected edge gain. Items 1-3 are signal quality improvements that compound together.

---

## 1. Multi-Model Ensemble Blending

**Impact:** High — biggest single win
**Status:** Complete

Currently the bot only fetches `gfs_seamless` (31 members) from Open-Meteo. The API also supports `icon_seamless` (~40 members) and `ecmwf_ifs025` (51 members) for free. Blending all three gives ~122 ensemble members instead of 31, improving probability resolution from 1/31 (3.2%) to ~1/122 (0.8%). This matters most for thin-edge trades where distinguishing 62% from 65% is the difference between trading and skipping.

**Files:**
- `app/data/services/ensemble.ts` — fetch from all three models, merge member arrays
- May need deduplication or weighting if models have different biases

**Approach:**
- Change `&models=gfs_seamless` to `&models=gfs_seamless,icon_seamless,ecmwf_ifs025`
- Open-Meteo returns members keyed like `temperature_2m_max_member01` per model — collect all
- Consider equal weighting initially, per-model bias correction later

---

## 2. Distribution Fitting Instead of Raw Counting

**Impact:** High
**Status:** Not started

The estimator (`estimator.ts:70-74`) counts how many ensemble members land in the bracket: `membersInBracket / correctedValues.length`. With 31 members this is extremely coarse — a bracket gets 0%, 3.2%, 6.4%, etc. Fitting a normal distribution (mean + std are already computed) and using the CDF integral over `[bracketLow, bracketHigh]` gives smooth, continuous probabilities.

This matters most for tail brackets (0-10%, 90-100%) where Kalshi mispricing is richest but raw member counts are 0 or 1.

**Files:**
- `app/signals/services/estimator.ts` — replace raw counting with `normalCDF(bracketHigh) - normalCDF(bracketLow)`

**Approach:**
- Implement `normalCDF` using the error function approximation (no dependencies needed)
- Use bias-corrected ensemble mean and std as distribution parameters
- Keep raw member count in reasoning for comparison/debugging
- Blend: use distribution-fitted probability as primary, but if ensemble size > 80 (after multi-model), give more weight to raw counting since the resolution is fine enough

---

## 3. Use Historical Hit Rate as Bayesian Prior

**Impact:** Medium-High
**Status:** Not started

`estimator.ts:103` fetches `historicalHitRate` and stores it in reasoning, but it's never blended into the probability estimate. This is free Bayesian prior information — empirical data on how often this type of market resolves YES at this station.

**Files:**
- `app/signals/services/estimator.ts` — blend historical hit rate into final probability

**Approach:**
- Weighted blend: `finalProb = w * ensembleProb + (1-w) * historicalHitRate`
- Weight `w` depends on ensemble quality (more members + tighter spread → more weight on ensemble)
- Only blend when `historicalHitRate` is non-null (requires >= 5 data points)
- Start conservative: 90% ensemble / 10% historical, tunable via config

---

## 4. Stale Order Cancellation

**Impact:** Medium
**Status:** Not started

No mechanism exists to cancel unfilled limit orders. If a market moves away from the limit price, orders sit open indefinitely, tying up capital and counting toward `maxOpenPositions`. This starves the bot of opportunities.

**Files:**
- `app/engine/services/reconciliation.ts` — new step in reconcile pipeline
- `packages/kalshi-client/src/client.ts` — ensure `cancelOrder` method exists

**Approach:**
- Add `cancelStaleOrders()` step to reconciliation, before `syncOrders()`
- Cancel criteria: order open > 10 minutes AND market price moved > 5 cents from limit
- Log cancellations as structured events
- Config key: `bot.staleCancelMinutes` (default 10)

---

## 5. Per-Category Bias Correction

**Impact:** Medium
**Status:** Not started

Station bias is stored per `(stationId, horizon)` but not per forecast category. GFS could run 1.2F warm for high temps at KNYC but 0.3F cold for lows. Lumping them together dilutes the correction.

**Files:**
- `app/engine/services/reconciliation.ts` `recomputeStationBias()` — group by category
- `app/signals/services/estimator.ts` `getBiasCorrection()` — query with category
- `packages/db/src/schema/calibration.ts` — composite key change: `stationId_horizon` → `stationId_horizon_category`
- DB migration needed

**Approach:**
- Change bias key to `${stationId}_${horizon}_${category}`
- Fall back to category-agnostic bias if per-category sample size < 5
- Recompute existing biases on migration

---

## 6. Position Exit Logic

**Impact:** Medium
**Status:** Not started

The bot only buys — it never sells before settlement. If new weather data arrives and the estimate flips (a YES position now looks like a loser), the bot holds to expiry and takes the full loss. Exiting early when edge reverses would cut losses.

**Files:**
- `app/engine/services/orchestrator.ts` — new step between Phase 3 (Evaluate) and Phase 4 (Execute)
- `app/execution/services/execution.ts` — add `exitPosition()` method

**Approach:**
- After generating estimates, check open positions against current estimates
- If our estimate now disagrees with our position (e.g., we hold YES but estimate < market price - threshold), sell
- Exit threshold should be configurable: `bot.exitEdgeThreshold` (default: same as entry threshold)
- Only exit via limit order at current market price (don't market-sell into wide spreads)
