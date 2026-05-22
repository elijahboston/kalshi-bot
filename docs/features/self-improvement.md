# Self-Improvement Loop

The core differentiator: the bot gets better over time via automated feedback mechanisms that run during reconciliation. See [reconciliation.md](reconciliation.md) for the pipeline that drives these updates.

---

## 1. Station Bias Tracking

Each NWS station has systematic forecast errors that vary by forecast horizon (and, as of the per-category upgrade, by market category). For example, GFS might run 0.8°F warm for KNYC at a 3-day horizon.

After each market resolution:
- Compare the archived ensemble mean to the actual observation
- Recompute the rolling mean and std of the error over the last N days
- Store in `station_bias` table
- The estimator subtracts this bias from ensemble values before computing bracket probability

This is the single biggest lever for accuracy improvement.

---

## 2. Empirical Sigma (replaces ensemble spread)

Ensemble spread represents model disagreement, not forecast error. When the ensemble mean is within 1°F of the correct bracket, raw ensemble std (~2.6°F) mechanically spreads probability across 3-5 brackets. Empirical sigma — the standard deviation of `ensembleMean - actualValue` from history — is typically 1.0-1.5°F for day-1 temps, which concentrates probability correctly.

The estimator uses empirical sigma in the CDF computation when sample size ≥ 10 per `(station, category, horizon)` bucket; otherwise it falls back to ensemble spread. See [`docs/improvements/forecast-sharpening.md`](../improvements/forecast-sharpening.md) §3.

---

## 3. Adaptive Edge Thresholds

Instead of a single global `edgeThreshold`, maintain per-bucket thresholds:

| Bucket | If well-calibrated | If miscalibrated |
|--------|-------------------|------------------|
| 0.0-0.1 | base × 0.9 | base × (1 + calibError) |
| 0.1-0.2 | base × 0.9 | base × (1 + calibError) |
| ... | ... | ... |

If we're systematically overestimating probabilities in the 0-10% range (our predicted 5% events are hitting 15%), we require more edge before trading those. If we're well-calibrated in the 50-70% range, we can accept slightly thinner edge.

Stored in `adaptive_thresholds` table per `(series, bucket)`.

---

## 4. Confidence Model

The estimator's confidence score factors in:
- **Spread factor (40%):** Tighter ensemble spread = higher confidence
- **Bias data quality (40%):** More historical bias data = higher confidence
- **Ensemble size (20%):** More ensemble members = higher confidence (denominator = 120 after multi-model blending)

As the bot runs longer, bias data quality improves, which increases confidence scores, which leads to more (and better) trades.

---

## 5. Sniper / Scout Mode

Short-horizon trading captures the window where deterministic models converge. Outside `bot.sniperHorizonHours`, signals are emitted as scout events (visible but not executed); inside, they execute normally. Weather caches are force-invalidated when a market enters the sniper window. See [`docs/improvements/forecast-sharpening.md`](../improvements/forecast-sharpening.md) §2.

---

## Related docs

- [`reconciliation.md`](reconciliation.md) — the pipeline that computes calibration + bias each tick
- [`../improvements/forecast-sharpening.md`](../improvements/forecast-sharpening.md) — the five accuracy-gap improvements (HRRR, sniper, empirical sigma, observations, horizon-weighted blending)
- [`../improvements/improvements.md`](../improvements/improvements.md) — ranked backlog (historical hit-rate prior, stale-order cancellation, per-category bias, position exit)
- [`../research/no-bet-strategy-analysis.md`](../research/no-bet-strategy-analysis.md) — why weather data's value lives in the 6.3% of events where the market is wrong about which bracket resolves YES
