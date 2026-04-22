# Configuration

All config keys and their defaults live in `packages/config/src/index.ts`. Values merge three sources at startup: hardcoded defaults → environment variables (Bun auto-loads `.env`) → `runtime_config` table overrides.

## Keys

| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| `kalshi.apiKey` | `KALSHI_API_KEY` | `""` | Kalshi API key |
| `kalshi.apiSecret` | `KALSHI_API_SECRET` | `""` | Kalshi private key (RSA) |
| `kalshi.baseUrl` | `KALSHI_BASE_URL` | `https://api.elections.kalshi.com/trade-api/v2` | API base URL |
| `bot.dryRun` | `DRY_RUN` | `true` | Don't place real orders |
| `bot.tickIntervalSec` | `TICK_INTERVAL_SEC` | `60` | Loop interval |
| `bot.edgeThreshold` | `EDGE_THRESHOLD` | `0.08` | Min edge to trade |
| `bot.minConfidence` | `MIN_CONFIDENCE` | `0.5` | Min confidence |
| `bot.maxKellyFraction` | `MAX_KELLY_FRACTION` | `0.05` | Kelly cap |
| `bot.maxOpenPositions` | `MAX_OPEN_POSITIONS` | `10` | Position limit |
| `bot.maxContractsPerOrder` | `MAX_CONTRACTS_PER_ORDER` | `25` | Order size limit |
| `bot.enabledStations` | `ENABLED_STATIONS` | `KNYC,KORD,KLAX,KDFW,KIAH` | Stations to track |
| `bot.sniperHorizonHours` | `SNIPER_HORIZON_HOURS` | `12` | Below this horizon, signals are executable; above, scout-only |
| `bot.stopLossPct` | `STOP_LOSS_PCT` | `0.25` | Stop-loss trigger |
| `bot.exitEdgeThreshold` | `EXIT_EDGE_THRESHOLD` | (same as entry) | Edge required to exit on reversal |
| `bot.exitCooldownTicks` | `EXIT_COOLDOWN_TICKS` | `3` | Ticks between buy/exit/rebuy |
| `calibration.biasWindowDays` | `BIAS_WINDOW_DAYS` | `30` | Bias rolling window |
| `calibration.calibrationWindowDays` | `CALIBRATION_WINDOW_DAYS` | `30` | Calibration window |
| `calibration.maxCalibrationError` | `MAX_CALIBRATION_ERROR` | `0.05` | Max error before threshold adjustment |
| `db.path` | `DB_PATH` | `./data/kalshi-bot.db` | SQLite file path |
| `log.level` | `LOG_LEVEL` | `info` | Log verbosity |
| `api.port` | `API_PORT` | `3100` | REST + WebSocket port (see [api-layer.md](api-layer.md)) |

## REPL-mutable keys

Settable via `config set <key> <val>` at runtime (persisted to `runtime_config`):

`dry_run`, `edge_threshold`, `min_confidence`, `max_kelly`, `max_positions`, `max_contracts`, `tick_interval`, `bias_window_days`, `max_calibration_error`, `log_level`, `sniper_horizon_hours`, `stop_loss_pct`, `exit_edge_threshold`, `exit_cooldown_ticks`.

## Typed env var declarations

`env.d.ts` augments `Bun.env` with string types for the known env vars above, providing autocomplete and compile-time catches for typos.

## Anti-churn and exit cooldowns

Repeated buy → exit → rebuy loops (churn) are prevented by `exitCooldownTicks` and position-side guards in the execution service. See [`docs/features/reconciliation.md`](reconciliation.md) and the churn-prevention auto-memory for the full behavior.
