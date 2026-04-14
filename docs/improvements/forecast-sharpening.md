# Forecast Sharpening: Closing the Gap with Top Bots

Our analysis (2026-04-13) revealed that the market's Brier score improves 14x between 39h and 7h before close (0.156 to 0.011), while ours stays flat at 0.161. Our correct-bracket identification rate is 24.4% vs the market's 93.7%. The root cause: our ensemble spread (avg 2.6F) is wider than the bracket width (2F), and we don't get sharper as events approach.

These five changes address that gap, ordered by impact. They compound — HRRR data makes sniper mode viable, which makes empirical sigma meaningful, etc.

---

## 1. Ingest HRRR (High-Resolution Rapid Refresh) Data

**Impact:** High — biggest single improvement
**Effort:** 1-2 days
**Status:** Done

HRRR is a free, hourly-updated, 3km resolution NOAA model specifically designed for 0-18h forecasts. It's the most important data source we're missing, and almost certainly what top bots rely on in the final hours before close.

**Why it matters:**
- Runs every hour (vs our 6-hour cache TTL on ensemble data)
- 3km grid (vs 25-50km from our current models)
- Sub-1F spread at 6h out for surface temps — tight enough to concentrate probability on one bracket

**Data access:**
- Available via Open-Meteo: `https://previous-runs-api.open-meteo.com/v1/forecast?model=hrrr_conus`
- Also available via NOAA NOMADS (GRIB2 files, more complex)
- Open-Meteo is simpler and consistent with our existing infrastructure

**Files:**
- `app/data/services/ensemble.ts` — add `fetchHrrr()` source, call alongside Open-Meteo ensemble
- `app/data/services/ensemble.ts` — weight HRRR members heavily when horizon < 18h

**Approach:**
- Fetch HRRR hourly temperature data for target station coordinates
- Extract the forecast valid for the target date's max/min temp window
- Add HRRR members to the ensemble pool with higher weight at short horizons
- Weighting scheme: `hrrrWeight = max(0, 1 - forecastHorizon / 18)` — full weight at 0h, zero at 18h+
- Practically: duplicate HRRR members N times in the pool to upweight (e.g., 3x at 6h out)
- Cache TTL: 1 hour (matches HRRR run frequency)

---

## 2. Sniper Mode: Defer Entry to <12h Before Close

**Impact:** High — trade when forecasts are sharpest
**Effort:** 1-2 days
**Status:** Done

Currently the bot enters positions 24-39h before close with wide uncertainty. Top bots enter in the final 6-12h when deterministic models have converged. We should split the bot's behavior into two modes.

**Why it matters:**
- At 39h out, our Brier (0.160) is tied with the market (0.156) — no edge from early entry
- At 7h out, the market improves to 0.011 while we stay at 0.161 — we're leaving all the edge on the table
- Early entry means we pay fair-value prices, then the market moves to reflect better information

**Files:**
- `app/engine/services/orchestrator.ts` — Phase 3 (Evaluation), add horizon-based entry gating
- `packages/config/src/index.ts` — new config: `bot.sniperHorizonHours` (default 12)

**Approach:**
- **Scout mode** (horizon > sniperHorizonHours): generate signals for monitoring/logging, but set `recommendation = "scout"` — do not execute
- **Sniper mode** (horizon <= sniperHorizonHours): re-fetch latest HRRR + ensemble data, generate signals normally, execute if edge > threshold
- The sniper window should trigger a forced cache invalidation for weather data, ensuring we're using the freshest forecasts
- Consider reducing tick interval to 60s during sniper window for faster reaction
- Exit logic remains unchanged (already triggers at 6h)

**Trade-off:**
- We lose the ability to enter early at favorable prices when the market is wrong days in advance
- We gain much higher accuracy on bracket selection
- Net positive: our data shows early-entry Brier is break-even, not an edge

---

## 3. Use Empirical Forecast Error as Sigma (Not Ensemble Spread)

**Impact:** High — concentrates probability correctly
**Effort:** 1 day
**Status:** Done

Our ensemble std (2.6F avg) overstates true uncertainty. The actual forecast error (ensemble mean vs observed) is typically 1.0-1.5F for day-1 high temps. Using empirical error as sigma would push our correct-bracket probability from ~17% to 60-80% even when the mean is spot on.

**Why it matters:**
- Even when our forecast mean is within 1F of the correct bracket, we only assign 16.8% YES — the market assigns 96.7%
- Ensemble spread represents model disagreement, not forecast error — these are different quantities
- With 2F brackets and 2.6F sigma, a normal CDF mechanically spreads mass across 3-5 brackets

**Evidence from our data:**
- 19 YES brackets where our mean was within 1F: we said 16.8%, market said 96.7%
- 20 YES brackets where our mean was within 2F: we said 12.9%, market said 98.1%
- The mean is good; the spread is what kills us

**Files:**
- `app/signals/services/estimator.ts` — replace `ensemble.std` with empirical sigma in CDF computation
- `app/engine/services/reconciliation.ts` — compute and store empirical error stats per station/horizon/category
- `packages/db/src/schema/calibration.ts` — add `forecast_error` column (ensemble_mean - actual_value)

**Approach:**
- After each market resolves, compute `forecastError = ensembleMean - actualValue` and store it
- Build per-(station, category, horizon) error distributions: mean error (already have as bias) and **std of error**
- In estimator, use `empiricalSigma = stdOfError` instead of `ensemble.std` for the CDF
- Fall back to ensemble std when empirical sample size < 10
- Expected empirical sigma: ~1.0-1.5F for day-1 temps → bracket probability jumps to 50-80% for correct bracket

---

## 4. Feed Same-Day Observations into Estimator

**Impact:** Medium-High — collapses uncertainty for same-day markets
**Effort:** 1 day
**Status:** Done

We already have the NWS observations endpoint (`app/data/services/nws.ts`) but don't use real-time observations to update estimates. For high-temp markets, morning observed temps are highly predictive of afternoon highs.

**Why it matters:**
- If 7am observed temp is 72F and rising, with forecast high of 85F, the uncertainty around 85F drops to <1F
- Morning temps have ~0.85 correlation with afternoon highs in most US cities
- This is likely the cheapest win: we have the API already

**Files:**
- `app/data/services/nws.ts` — add `getLatestObservation(stationId)` method
- `app/signals/services/estimator.ts` — if targetDate is today AND observations available, tighten sigma

**Approach:**
- Fetch latest NWS observation for the station when `forecastHorizon <= 1`
- For high_temp: if current observed temp is within a few degrees of forecast mean, reduce sigma by 50%
- For high_temp: if current observed temp diverges significantly from forecast mean, shift the mean toward a regression-based estimate (e.g., `adjustedMean = 0.7 * forecastMean + 0.3 * observationBasedEstimate`)
- Don't attempt for precip/snowfall — obs-based tightening is less reliable for precipitation
- Log the observation and adjustment in reasoning trace

---

## 5. Horizon-Weighted Model Blending

**Impact:** Medium — correct model for correct timescale
**Effort:** 1 day
**Status:** Done

Different models excel at different time horizons. HRRR dominates at 0-18h, GFS/ECMWF ensembles are best at 2-7 days. Currently we weight all models equally regardless of horizon.

**Files:**
- `app/data/services/ensemble.ts` — add horizon-aware weighting when combining members
- `app/signals/services/estimator.ts` — pass forecastHorizon to ensemble fetcher

**Approach:**
- Define model weights by horizon:
  ```
  < 6h:   HRRR 70%, GFS 15%, ECMWF 15%
  6-18h:  HRRR 40%, GFS 30%, ECMWF 30%
  18h-3d: GFS 35%, ECMWF 35%, ICON 15%, others 15%
  3d+:    Equal weights across all models
  ```
- Implement weighting by duplicating members proportionally in the pool
- Or: compute separate probabilities per model group and blend analytically
- Track model-level accuracy in calibration to validate/tune weights over time

---

## Projected ROI Impact

We simulated the improved model against our historical market data (127 events, 677 brackets, 46 trading days). The simulation uses a YES + NO hybrid strategy: buy YES on the model's top bracket pick, buy NO on remaining brackets (skipping the market's top-2 for safety). Budget: $100/day.

### Strategy: YES + NO Hybrid

For each event:
- Allocate 50% of per-event budget to a YES bet on the model's top bracket pick
- Allocate 50% to NO bets on remaining brackets (skip market's top-2)
- YES entry prices derived from actual signal data at each time window

YES bracket prices by entry window (from our signal history):

| Hours before close | Avg YES price on correct bracket |
|---|---|
| 24h | 35¢ |
| 12h | 60¢ |
| 10h | 73¢ |
| 8h | 87¢ |
| 7h | 92¢ |

### Simulation Results (5,000 Monte Carlo runs each)

| Model Accuracy | Entry Window | Avg P&L | ROI | vs Current |
|---|---|---|---|---|
| 24% (current) | 24h | -$309 | -17.0% | baseline* |
| 50% | 12h | +$116 | 3.5% | — |
| 65% | 12h | +$676 | 20.6% | 7.2x profit |
| **75% (target)** | **10h** | **+$643** | **19.5%** | **6.9x profit** |
| 85% | 10h | +$963 | 29.3% | 10.3x profit |
| 94% (match market) | 7h | +$615 | 18.8% | 6.6x profit |

*The 24% accuracy simulation shows -17% ROI because it aggressively bets YES on wrong brackets. Our actual bot avoids this by being conservative (3.7% ROI on $2,515 invested = +$93 actual P&L).

**Comparison to actual performance:**

| | Current Bot | Improved (75%, 10h) |
|---|---|---|
| P&L | +$93 | +$643 |
| ROI | 3.7% | 19.5% |
| Invested | $2,515 | $3,291 |
| Improvement | — | **6.9x profit, 5.3x ROI** |

### Why the ROI sweet spot is 65-85% at 10-12h

- **Too early (24h):** Prices are cheap (35¢) so profits per correct pick are high, but accuracy is too low to overcome the losses
- **Sweet spot (10-12h, 65-85%):** YES prices are 60-73¢ — cheap enough for 27-40¢ profit per correct pick, and accuracy is high enough to overcome the 25-35% miss rate at ~6¢ per wrong pick
- **Too late (7h):** YES prices are 87-92¢ — accuracy is near-perfect but profit per correct pick is only 8-13¢, barely covering the rare losses

### P&L Attribution (75% accuracy, 10h entry)

**YES bets (core edge):**
- ~358 contracts/day
- 14.2% win rate by contract count (correct picks are expensive → fewer contracts; wrong picks are cheap → many contracts)
- When correct: buy at ~58¢, collect $1 → 42¢ profit
- When wrong: buy at ~6¢ (low-prob bracket), lose 6¢
- Net strongly positive due to asymmetric payoff

**NO bets (steady income):**
- ~35 contracts/day
- 100% win rate (skipping market's top-2 brackets)
- ~1¢ profit per contract — small but consistent

---

## Expected Outcome

With all five changes implemented:

| Metric | Current | Expected | Top Bots |
|--------|---------|----------|----------|
| Brier score (7h out) | 0.161 | 0.03-0.05 | 0.011 |
| Correct bracket top-1 | 24.4% | 70-85% | 93.7% |
| Useful trading window | 24-39h out (break-even) | 6-12h out (strong edge) | 4-12h out |
| P&L (46-day period) | +$93 | +$643 to +$963 | — |
| ROI | 3.7% | 19.5-29.3% | — |

We won't fully match the top 1% on day one — they likely have proprietary MOS post-processing, years of verification data, and possibly paid ECMWF deterministic access. But we'd go from "basically guessing which bracket" to "usually right about which bracket," which is the difference between grinding thin NO edges and making confident, high-value YES bets on the correct bracket.
