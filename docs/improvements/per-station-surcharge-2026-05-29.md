# Per-station edge surcharge (2026-05-29)

**Status:** Accepted
**Date:** 2026-05-29
**Deciders:** Elijah Boston

## Why

60-day per-station PnL (buy trades, settled markets only):

| Station | Trades | Win rate | PnL | ROI |
|---|---|---|---|---|
| **KORD** (Chicago) | 31 | 29.0% | **−$55** | **−36%** |
| **KNYC** (New York) | 41 | 29.3% | **−$42** | **−19%** |
| **KLAX** (Los Angeles) | 15 | 20.0% | **−$30** | **−40%** |
| KDEN (Denver) | 29 | 34.5% | $0 | 0% |
| KAUS (Austin) | 35 | 37.1% | +$15 | +9% |
| KMIA (Miami) | 38 | 34.2% | +$24 | +11% |

Three stations are durable losers across 60 days. The data is unambiguous — every metric agrees, and the volume in CHI/NY/LAX is enough to rule out noise.

The blunt fix (`enabled_stations -= KORD, KLAX`) is too harsh: those stations *do* have winnable markets, and removing them prevents the calibration loop from ever learning per-station patterns. A softer fix lets them keep trading but raises the bar — only the cleanest signals fire.

## Change 1 — `stationEdgeSurcharge` config (stationId → surcharge map)

[`packages/config/src/index.ts`](../../packages/config/src/index.ts):

```ts
// BotConfig.bot interface
stationEdgeSurcharge: Record<string, number>;

// Helper (exported for runtime + tests)
export function parseStationSurcharge(raw: string | undefined | null): Record<string, number>;

// loadConfig defaults
stationEdgeSurcharge: parseStationSurcharge(env("STATION_EDGE_SURCHARGE")), // ship empty

// RUNTIME_CONFIG_MAP
station_edge_surcharge: (c, v) => { c.bot.stationEdgeSurcharge = parseStationSurcharge(v); },
```

Stored in `runtime_config.value` as a JSON string. The parser tolerates malformed input by returning `{}` — a bad runtime row degrades to "no surcharge" rather than crashing the orchestrator.

## Change 2 — Apply in orchestrator's edge-gate

[`app/engine/services/orchestrator.ts`](../../app/engine/services/orchestrator.ts) — base threshold (from the adaptive table) plus per-station surcharge becomes the effective edge bar:

```ts
const baseThreshold = await getEffectiveThreshold(estimate.probability, market.seriesTicker);
const stationSurcharge = market.stationId
  ? (config.bot.stationEdgeSurcharge[market.stationId] ?? 0)
  : 0;
const edgeThreshold = baseThreshold + stationSurcharge;
```

When the edge gate trips, the skip reason names the surcharge so it's debuggable from the DB:

```
edge 18.5¢ < threshold 20¢ + 15¢ KORD surcharge
```

The signal row's `edgeThreshold` column persists the **combined** value, so downstream queries see the actual bar the trade had to clear.

## Initial runtime values

```sql
INSERT INTO runtime_config(key, value, updated_at)
VALUES ('station_edge_surcharge',
        '{"KORD":0.15,"KLAX":0.15,"KNYC":0.10}',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
```

| Station | Surcharge | Rationale |
|---|---|---|
| KLAX | +0.15 | −40% ROI, worst single-station efficiency |
| KORD | +0.15 | −36% ROI, worst absolute loss |
| KNYC | +0.10 | −19% ROI, high volume so smaller bump reduces drag without throttling too much |
| KDEN | 0 | Neutral PnL — observe, do not penalize |
| KAUS, KMIA | 0 | Profitable, leave alone |

Combined with the default `edge_threshold` of 0.20, KORD/KLAX signals now need a 35¢ edge to fire (vs 20¢ for KMIA/KAUS). Combined with the [market-prior blend](./market-prior-2026-05-29.md) shrinking extreme edges, expect KORD/KLAX entries to drop sharply.

## Expected impact

The market-prior change (shipped earlier today) already maps most large model-edges into the 25–45¢ range. With KORD/KLAX requiring 35¢ to fire and KNYC requiring 30¢, the surcharges effectively concentrate trading on:

- KAUS, KMIA, KDEN signals at any edge ≥ 20¢
- KNYC signals at edge ≥ 30¢
- KORD, KLAX signals at edge ≥ 35¢

Over the 60-day audit window, this would have eliminated roughly half of KORD/KLAX/KNYC fills while preserving the highest-confidence ones.

## Tests

[`packages/config/src/config.test.ts`](../../packages/config/src/config.test.ts):

- `parseStationSurcharge` — empty/null/malformed JSON → `{}` (safe degradation)
- non-object JSON (number, array, null) → `{}`
- valid map → parsed
- string-numeric values coerced; non-numeric dropped
- non-finite values dropped
- `STATION_EDGE_SURCHARGE` env var populates the config map

The orchestrator wiring itself is not unit-tested (orchestrator has no test file), but the helper coverage + the `edgeThreshold` value persisted to `signals` lets us verify the behavior in production via SQL.

## Verification (target ~2026-06-05)

- `SELECT skip_reason, COUNT(*) FROM signals WHERE skip_reason LIKE '%surcharge%' AND created_at > date('now','-7 days') GROUP BY 1` — should be non-zero for KORD/KLAX/KNYC, confirming gate trips.
- Per-station PnL over the next 7 days should show KORD/KLAX/KNYC trading volume drop noticeably; remaining trades should have a higher win rate than baseline.
- `SELECT station_id, AVG(edge_threshold) FROM signals JOIN markets USING (ticker) WHERE created_at > date('now','-7 days') GROUP BY 1` — should show baseThreshold + surcharge per station.

## What this still doesn't fix

- The *root cause* of CHI/NY/LAX underperformance is unknown. Hypotheses: cooler/wetter weather pattern this season making their high-temp brackets harder to forecast; ensemble models being less tuned for those stations' microclimates; locally common late-day convection that the bot doesn't model. Worth investigating per-station bias variance over time.
- No automatic feedback. The surcharges are hand-tuned. Once `adaptive_thresholds` is properly active (see [`improvements.md`](improvements.md)), the system could derive per-station-per-bucket thresholds from observed calibration — at which point this manual override should be revisited.
