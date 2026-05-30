# Multi-horizon station_bias backfill (2026-05-29)

## Why

`station_bias` has only 6 rows — one per station at `forecast_horizon_days = 1`. The bot trades same-day markets in sniper mode (within 12h of close), so only horizon=1 forecasts ever get cached, and `recomputeStationBias` produces only horizon=1 bias entries.

The estimator's bias-correction lookup (`getBiasCorrection` in [`estimator.ts`](../../app/signals/services/estimator.ts)) keys by `(stationId, category, horizon)`. For multi-day markets in scout mode — and any future strategy that takes positions earlier than the 12h window — the lookup misses, and forecasts run with **zero bias correction**. We won't notice until the strategy mix changes, by which point we'll have weeks of uncorrected data.

This change sets up the pipes now so the bias data is there when we need it.

## Why this isn't a `recomputeStationBias` bug

[`recomputeStationBias`](../../app/engine/services/reconciliation.ts) already groups by `(category, horizon)` and writes one row per group. The reason horizons 2/3 are empty is purely upstream: there's no data to group. The fix lives in **what gets stored** in `weather_forecasts`, not in the bias recomputer.

## Change 1 — `warmMultiHorizonForecasts` periodic warmer

[`app/engine/services/reconciliation.ts`](../../app/engine/services/reconciliation.ts) — new method on `ReconciliationService`:

```ts
async warmMultiHorizonForecasts(): Promise<number> {
  const maxDays = config.bot.multiHorizonBiasMaxDays ?? 0;
  if (maxDays < 2) return 0;

  // Rate-limit to once per hour to keep external API quota in check
  if (Date.now() - this.lastMultiHorizonWarmAt < HOUR_MS) return 0;
  this.lastMultiHorizonWarmAt = Date.now();

  for (const stationId of config.bot.enabledStations) {
    for (let h = 2; h <= maxDays; h++) {
      const target = new Date(Date.now() + h * 86400_000).toISOString().slice(0, 10);
      await this.ensembleService.getEnsembleValues(stationId, target, "high_temp", h * 24);
    }
  }
}
```

`getEnsembleValues` already caches with a 6h TTL, so the per-hour warm cycle is cheap — usually a no-op cache hit. The fetch ultimately writes a row to `weather_forecasts` with `forecast_horizon = h`.

## Change 2 — `backfillHistoricalForecastActuals` periodic backfill

Once a warmed forecast row's target_date is in the past, NWS knows the actual high temp for that day. This method scans for past-target-date rows with `actual_value IS NULL` and fills them via the existing `fetchNwsActualValue` helper. Capped at 50 rows per cycle and rate-limited to once per hour.

When any row gets filled, the affected station's bias is immediately recomputed so multi-horizon `station_bias` entries appear without waiting for the next market resolution at that station.

## Change 3 — Reconciliation loop wiring

[`reconcile()`](../../app/engine/services/reconciliation.ts) calls both methods at the tail of every tick, right after `persistAdaptiveThresholds`. The rate-limit gates inside the methods make per-tick invocation safe.

## Change 4 — Config knob `multiHorizonBiasMaxDays`

[`packages/config/src/index.ts`](../../packages/config/src/index.ts):

```ts
// BotConfig.bot interface
multiHorizonBiasMaxDays: number;

// loadConfig defaults
multiHorizonBiasMaxDays: envNum("MULTI_HORIZON_BIAS_MAX_DAYS", 0),  // ship dark

// RUNTIME_CONFIG_MAP
multi_horizon_bias_max_days: (c, v) => { const n = Number(v); if (!Number.isNaN(n)) c.bot.multiHorizonBiasMaxDays = n; },
```

`0` disables both the warmer and the backfill. Set to N to enable horizons 2..N.

## Initial runtime value

```sql
INSERT INTO runtime_config(key, value, updated_at)
VALUES ('multi_horizon_bias_max_days', '3',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
```

`3` populates horizons 2 and 3. Per cycle that's 6 stations × 2 horizons = 12 Open-Meteo fetches/hour (well within free-tier quota). Step up to 5 or 7 later if we want longer-horizon coverage.

## Tests

[`app/engine/services/reconciliation.test.ts`](../../app/engine/services/reconciliation.test.ts) — 5 new tests:

- `warmMultiHorizonForecasts` returns 0 when knob disabled (=0)
- Returns 0 when knob=1 (need at least 2)
- Sets the rate-limit timestamp on successful run
- `backfillHistoricalForecastActuals` returns 0 when knob disabled
- `backfillHistoricalForecastActuals` is rate-limited (timestamp not advanced on back-to-back call)

A full integration test for "iterates correctly" was attempted but proved fragile under bun's full-suite module-state pollution (the test passes in isolation but fails when other suites load the config singleton first). The early-return gates and the timestamp behavior are the load-bearing checks; the iteration itself is straightforward and observable in production via the SQL queries below.

## Verification (target ~2026-06-05)

```sql
-- horizons 2 and 3 should appear here after first warm cycle
SELECT station_id, forecast_horizon, COUNT(*) FROM weather_forecasts
WHERE fetched_at > date('now', '-1 days')
GROUP BY 1, 2 ORDER BY 1, 2;

-- after a few days, actuals should backfill
SELECT forecast_horizon, COUNT(*) total,
       COUNT(actual_value) AS with_actual
FROM weather_forecasts GROUP BY forecast_horizon;

-- station_bias should accumulate horizon-2 and horizon-3 rows
SELECT station_id, forecast_horizon_days, sample_size,
       ROUND(mean_bias, 2) bias, ROUND(std_bias, 2) std
FROM station_bias ORDER BY station_id, forecast_horizon_days;
```

## What this still doesn't fix

- Doesn't help **current** PnL — sniper-mode trades are horizon=1 and already have bias data. This is infrastructure for future strategies that look further out.
- The warmer only covers `high_temp` for now. precip/snowfall/low_temp would need a similar loop or a generalization to iterate over categories. Easy to extend once we trade those markets multi-day.
- Open-Meteo's free tier rate-limits at 10k calls/day. With 6 stations × 6 horizons × 24 hours = 864/day, plus existing per-trade fetches, we have headroom. Worth monitoring if max-days is bumped much higher.
