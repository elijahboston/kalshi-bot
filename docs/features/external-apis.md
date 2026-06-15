# External APIs

**Type:** Reference
**Last updated:** 2026-06-10

The bot integrates with three external data providers plus the Kalshi trading API. All clients live under `packages/kalshi-client/` (Kalshi) or `app/data/services/` (weather).

---

## Kalshi API (v2)

**Base URL:** `https://api.elections.kalshi.com/trade-api/v2`

**Auth:** RSA-PSS request signing (`packages/kalshi-client/src/auth.ts`). Each request is signed with the API key + private key pair — no login/token flow.

**Key endpoints used:**
- `GET /markets?series_ticker=KXHIGHNY&status=open` — list markets (paginated via `cursor`)
- `GET /markets/{ticker}` — single market detail
- `GET /events/{event_ticker}` — event with all its markets
- `POST /portfolio/orders` — place order
- `DELETE /portfolio/orders/{order_id}` — cancel order
- `GET /portfolio/orders` — list orders (paginated via `cursor`)
- `GET /portfolio/balance` — cash balance
- `GET /portfolio/positions` — open positions (includes `market_exposure`, `position`)
- `GET /portfolio/settlements` — settlement history (paginated via `cursor`)

**Pagination:** Cursor-based. `KalshiClient` provides `getAll*()` helpers that auto-paginate.

**Rate limits:** Refer to Kalshi API docs. Exponential backoff on 429.

### Field conventions

- Prices in cents (0-99 for limit orders, 0-100 for last price).
- Newer API versions expose `_dollars` / `_fp` string fields for monetary values — clients normalize these to cents internally.
- `yes_price` / `no_price` are integers. A market priced at 22¢ YES means `yes_bid` or `last_price` = 22.

### WebSocket feed (`packages/kalshi-client/src/feed.ts`)

Streams ticker updates and market lifecycle events. Auto-reconnects on drop and tracks sequence numbers to detect gaps (logs a warning on gap, including for unrecognized message types so the counter stays in sync).

---

## NWS API (free)

**Base URL:** `https://api.weather.gov`

**Required header:** `User-Agent: KalshiClimateBot/1.0 (contact@example.com)` — NWS returns 403 without it.

**Key endpoints:**
- `GET /points/{lat},{lon}` — resolve coordinates to forecast office + grid
- `GET /gridpoints/{office}/{gridX},{gridY}/forecast` — 7-day forecast periods
- `GET /gridpoints/{office}/{gridX},{gridY}` — raw gridded data (hourly, more detail)
- `GET /stations/{stationId}/observations?limit=24` — recent observations

Station coordinates are hardcoded in `app/data/services/nws.ts` for the tracked stations.

**Units:** NWS returns Celsius in raw grid data, Fahrenheit in forecast periods. Always check `temperatureUnit` / `unitCode`.

Same-day observations are used by the estimator for short-horizon sigma tightening — see [`docs/improvements/forecast-sharpening.md`](../improvements/forecast-sharpening.md) §4.

---

## Open-Meteo Ensemble API (free, primary data source)

**Base URL:** `https://ensemble-api.open-meteo.com/v1/ensemble`

**Example:**
```
GET /v1/ensemble?latitude=40.78&longitude=-73.97&daily=temperature_2m_max&models=gfs_seamless,ecmwf_ifs025,icon_seamless&forecast_days=7
```

**Params:**
- `latitude`, `longitude` — station coordinates
- `daily` — variables: `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `snowfall_sum`
- `models` — `gfs_seamless` (31), `icon_seamless` (~40), `ecmwf_ifs025` (~51), combined to ~120 members
- `forecast_days` — 1-16

Member values come back as `*_member01` ... `*_member30` plus the control run. The parser uses a relaxed regex to pick up model-suffixed member keys. Cache source tag: `"multi_ensemble"`.

**Units:** Celsius. Convert to Fahrenheit with `cToF()` before storing or comparing to Kalshi brackets.

---

## HRRR (short-horizon, high-res)

High-Resolution Rapid Refresh — 3km, hourly updates, 0-18h. Fetched via Open-Meteo previous-runs API:
```
https://previous-runs-api.open-meteo.com/v1/forecast?model=hrrr_conus
```
HRRR members are upweighted at short horizons: `hrrrWeight = max(0, 1 - forecastHorizon / 18)`. Cache TTL: 1 hour. See [`docs/improvements/forecast-sharpening.md`](../improvements/forecast-sharpening.md) §1.

---

## Tomorrow.io (augmentation / fallback)

Single-value forecasts that enter the ensemble pool alongside Open-Meteo + HRRR. Used for redundancy and as a fallback when primary sources error. Synthetic NWS values are the last-resort fallback.

---

## Rate limiting & resilience

- Exponential backoff on 429 responses.
- Cache TTLs in the `weather_forecasts` table (plus in-memory caches per service) prevent repeated fetches within a tick.
- On NWS / Open-Meteo failure, fall back to cached data and emit a warning `log` event.
