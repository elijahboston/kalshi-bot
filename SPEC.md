# SPEC.md — Kalshi Climate Bot

## Overview

A terminal-based trading agent for Kalshi's climate prediction markets. Single-process architecture: the Ink (React for terminals) UI and the headless bot engine run in the same process, communicating via a typed `EventEmitter`. SQLite (via Drizzle ORM) is the sole persistence layer. No HTTP server, no WebSocket layer.

The bot discovers Kalshi climate markets, fetches weather ensemble forecasts, estimates bracket probabilities with station-specific bias corrections, and executes trades when edge exceeds adaptive thresholds. It continuously improves by recording predicted vs actual outcomes and adjusting its models.

**Stack:** Bun, TypeScript, Ink (React), Drizzle ORM, SQLite, Node EventEmitter.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI (@kcb/cli) — Ink / React terminal UI                      │
│  ┌─────────────┐ ┌──────┐ ┌─────────┐ ┌──────┐ ┌────────────┐ │
│  │  Dashboard   │ │ REPL │ │ Markets │ │ Logs │ │ Calibration│ │
│  └──────┬──────┘ └──┬───┘ └────┬────┘ └──┬───┘ └─────┬──────┘ │
│         │           │          │          │            │        │
│         └───────────┴──────────┴──────────┴────────────┘        │
│                              ▲ bus.on(...)                       │
├──────────────────────────────┼──────────────────────────────────┤
│                       TypedEmitter (bus)                         │
│                              │ bus.emit(...)                     │
├──────────────────────────────┼──────────────────────────────────┤
│  Engine (@kcb/engine) — Headless bot logic                      │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  Orchestrator (tick loop)                             │       │
│  │  Phase 1: Discovery    → @kcb/kalshi-client           │       │
│  │  Phase 2: Estimation   → @kcb/data + @kcb/signals     │       │
│  │  Phase 3: Evaluation   → @kcb/signals                 │       │
│  │  Phase 4: Execution    → @kcb/execution               │       │
│  │  Phase 5: Reconcile    → calibration + positions       │       │
│  └──────────────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────────────┤
│  SQLite (@kcb/db — Drizzle ORM)                                 │
│  markets │ orders │ trades │ positions │ signals │ calibration   │
│  station_bias │ adaptive_thresholds │ weather_forecasts          │
│  balance_history │ runtime_config                                │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **No HTTP server.** Engine and UI share memory. The event bus replaces WebSocket entirely.
- **Commands are just functions.** The REPL parses input, matches a handler, and calls it. Commands can query SQLite directly. No request/response ceremony.
- **SQLite is the integration point.** Engine writes, CLI reads. For real-time events, the bus handles it. For historical queries (calibration, backtest, explain), it's a direct DB read.
- **Ink over raw terminal.** React component model for free — `useState` for view state, `useEffect` for event subscriptions, `useInput` for keyboard handling.
- **All monetary values in cents.** Market prices 0-100, balances in cents, PnL in cents. Avoids floating-point dollar math.
- **All timestamps are ISO 8601 strings.** SQLite doesn't have a native datetime type; ISO strings sort lexicographically.

---

## Workspace Structure

Bun workspaces monorepo. Workspace packages reference each other via `"workspace:*"`.

```
kalshi-climate-bot/
├── package.json              # Root: workspaces, scripts
├── tsconfig.json             # Path aliases (@kcb/*)
├── .env.example              # Environment template
├── app/
│   ├── cli/                  # @kcb/cli — Terminal UI (Ink)
│   │   ├── src/
│   │   │   ├── index.tsx     # Entry point: migrate DB, init engine, render Ink
│   │   │   ├── app.tsx       # Top-level layout, view mode switching (1-4, Tab, Esc)
│   │   │   ├── views/
│   │   │   │   ├── dashboard.tsx    # Live: positions, signals, orders, errors
│   │   │   │   ├── repl.tsx         # Interactive command input with history
│   │   │   │   ├── markets.tsx      # Table: ticker, price, estimate, edge, confidence
│   │   │   │   └── logs.tsx         # Filtered log stream from bus
│   │   │   ├── components/
│   │   │   │   └── status-bar.tsx   # Bottom bar: running/stopped, balance, equity, ticks
│   │   │   ├── commands/
│   │   │   │   ├── index.ts         # Command registry, parser, dispatcher, help
│   │   │   │   ├── bot.ts           # start, stop, status, restart
│   │   │   │   ├── markets.ts       # markets (list), inspect <ticker>
│   │   │   │   ├── positions.ts     # positions, pnl, orders [status]
│   │   │   │   ├── config.ts        # config list/get/set (persists to runtime_config table)
│   │   │   │   └── calibration.ts   # calibration summary/detail/bias/retrain
│   │   │   └── hooks/
│   │   │       └── use-bot-events.ts  # useBotEvent, useBotEvents, useLogs hooks
│   │   └── package.json
│   ├── engine/               # @kcb/engine — Bot loop + event bus
│   │   ├── events.ts         # TypedEmitter, BotEvents type map, createLogger
│   │   ├── services/
│   │   │   ├── loop.ts       # Start/stop interval loop, registerTick, LoopState
│   │   │   └── orchestrator.ts  # 5-phase tick pipeline (STUB — needs implementation)
│   │   ├── index.ts
│   │   └── package.json
│   ├── data/                 # @kcb/data — Weather data ingestion
│   │   ├── services/
│   │   │   └── nws.ts        # NWS API: forecasts, grid data, observations (implemented)
│   │   ├── index.ts
│   │   └── package.json
│   ├── signals/              # @kcb/signals — Probability estimation
│   │   ├── services/
│   │   │   ├── estimator.ts          # ProbabilityEstimator: ensemble → bracket prob (implemented)
│   │   │   └── adaptive-threshold.ts  # getEffectiveThreshold: per-bucket edge (implemented)
│   │   ├── index.ts
│   │   └── package.json
│   └── execution/            # @kcb/execution — Order sizing and placement
│       ├── services/
│       │   └── execution.ts  # ExecutionService: Kelly sizing, order placement (implemented)
│       ├── index.ts
│       └── package.json
├── packages/
│   ├── db/                   # @kcb/db — SQLite + Drizzle ORM
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── client.ts     # getDb singleton, WAL mode, pragmas
│   │       ├── migrate.ts    # runMigrations
│   │       ├── index.ts      # Barrel: re-exports schema + drizzle operators
│   │       └── schema/
│   │           ├── index.ts
│   │           ├── markets.ts      # markets table
│   │           ├── trading.ts      # orders, trades, positions tables
│   │           ├── signals.ts      # signals table
│   │           ├── calibration.ts  # calibration, station_bias, adaptive_thresholds tables
│   │           └── weather.ts      # weather_forecasts, balance_history, runtime_config tables
│   ├── kalshi-client/        # @kcb/kalshi-client — REST API wrapper
│   │   └── src/
│   │       ├── client.ts     # KalshiClient: auth, markets, orders, portfolio (implemented)
│   │       ├── types.ts      # Kalshi API response types
│   │       └── index.ts
│   └── config/               # @kcb/config — Typed configuration
│       └── src/
│           └── index.ts      # BotConfig type, loadConfig, getConfig, updateConfig
├── shared/
│   ├── types/index.ts        # MarketCategory, series helpers, cToF/fToC, uuid, now
│   └── index.ts
├── data/                     # SQLite DB files (gitignored)
└── logs/                     # Log files (gitignored)
```

---

## Current State: What's Implemented vs Stubbed

### ✅ Fully Implemented

| Component | File | Status |
|-----------|------|--------|
| Bun workspace monorepo | `package.json`, `tsconfig.json` | Complete |
| Drizzle schema (11 tables) | `packages/db/src/schema/*` | Complete |
| DB client (WAL mode, singleton) | `packages/db/src/client.ts` | Complete |
| Migration runner | `packages/db/src/migrate.ts` | Complete |
| Typed config (env + defaults) | `packages/config/src/index.ts` | Complete |
| Kalshi API client (auth, CRUD) | `packages/kalshi-client/src/*` | Complete |
| Typed event bus | `app/engine/events.ts` | Complete |
| Main loop (start/stop/interval) | `app/engine/services/loop.ts` | Complete |
| NWS weather service | `app/data/services/nws.ts` | Complete |
| Probability estimator | `app/signals/services/estimator.ts` | Complete |
| Adaptive thresholds | `app/signals/services/adaptive-threshold.ts` | Complete |
| Execution service (Kelly + orders) | `app/execution/services/execution.ts` | Complete |
| Ink app shell + mode switching | `app/cli/src/app.tsx` | Complete |
| Dashboard view | `app/cli/src/views/dashboard.tsx` | Complete |
| REPL view + input history | `app/cli/src/views/repl.tsx` | Complete |
| Markets view | `app/cli/src/views/markets.tsx` | Complete |
| Logs view | `app/cli/src/views/logs.tsx` | Complete |
| Status bar | `app/cli/src/components/status-bar.tsx` | Complete |
| Command registry + parser | `app/cli/src/commands/index.ts` | Complete |
| Bot commands (start/stop/status) | `app/cli/src/commands/bot.ts` | Complete |
| Markets commands (list/inspect) | `app/cli/src/commands/markets.ts` | Complete |
| Positions commands (pos/pnl/orders) | `app/cli/src/commands/positions.ts` | Complete |
| Config commands (list/get/set) | `app/cli/src/commands/config.ts` | Complete |
| Calibration commands (summary/detail/bias) | `app/cli/src/commands/calibration.ts` | Complete |
| React hooks for event subscriptions | `app/cli/src/hooks/use-bot-events.ts` | Complete |

### 🔲 Stubbed / Needs Implementation

| Component | Location | Description |
|-----------|----------|-------------|
| **Orchestrator tick pipeline** | `app/engine/services/orchestrator.ts` | The 5-phase tick body is all TODO comments. This is the **highest priority** item. |
| **Market discovery service** | `app/engine/services/discovery.ts` (create) | Fetch climate markets from Kalshi, parse tickers to extract station/bracket/date, upsert to DB |
| **Ensemble data fetching** | `app/data/services/ensemble.ts` (create) | Fetch GFS/GEFS ensemble data from Open-Meteo or similar. The NWS service only gets point forecasts — we need ensemble members for probability estimation |
| **Observation recording** | `app/data/services/observations.ts` (create) | After a market's target date passes, fetch actual observed temperature/precip from NWS and record in `weather_forecasts.actualValue` |
| **Reconciliation service** | `app/engine/services/reconciliation.ts` (create) | Sync positions with Kalshi, detect settled markets, compute realized PnL, write calibration records, update station bias |
| **Station bias recomputation** | Part of reconciliation | After each market resolution: recompute `station_bias` table using rolling window of `weather_forecasts` (predicted vs actual) |
| **Calibration retrain** | `app/cli/src/commands/calibration.ts` | The `retrain` subcommand is stubbed. Should recompute all station biases and adaptive thresholds from full history |
| **`explain` command** | `app/cli/src/commands/explain.ts` (create) | Given a ticker, show the signal reasoning: ensemble stats, bias correction, bracket probability, Kelly fraction, why it traded or skipped |
| **`backtest` command** | `app/cli/src/commands/backtest.ts` (create) | Run the estimator against archived `weather_forecasts` + actual outcomes to simulate P&L over a historical window |
| **Balance tracking** | Part of reconciliation | Periodically snapshot balance and equity to `balance_history` table. Fetch balance from Kalshi API (or track locally in dry run) |
| **Position cache maintenance** | Part of reconciliation | Update `positions` table from filled trades. Remove positions for settled markets. Compute unrealized PnL from current market prices |
| **Order status polling** | Part of reconciliation | Poll Kalshi for order fill status, update `orders.filledQuantity` and `orders.status`, create `trades` records for fills |
| **Log file writer** | `app/engine/services/log-writer.ts` (create) | Subscribe to `bus.on("log", ...)` and append to `logs/bot.log` with rotation |
| **Runtime config loading from DB** | `packages/config/src/index.ts` | On startup, load any overrides from `runtime_config` table and apply to in-memory config. Currently `config set` persists to DB but the values aren't loaded back on restart |

---

## Implementation Tasks (Priority Order)

### Phase 1: Wire the Orchestrator (Critical Path)

The orchestrator at `app/engine/services/orchestrator.ts` has the 5-phase tick pipeline stubbed with TODO comments. Each phase needs a concrete implementation.

#### Task 1.1: Market Discovery Service

Create `app/engine/services/discovery.ts`:

1. Call `KalshiClient.getAllMarkets()` filtered to climate series
2. Parse each market ticker to extract: `seriesTicker`, `stationId`, `targetDate`, `bracketLow`, `bracketHigh`, `category`
3. Upsert to `markets` table
4. Emit `bus.emit("market:discovered", ...)` for new markets
5. Update `lastYesPrice`, `lastNoPrice`, `status` for existing markets

**Ticker parsing rules** (Kalshi climate market convention):
- Ticker format: `KXHIGHNY-25FEB19-B37` → series=`KXHIGHNY`, target=`2025-02-19`, bracket floor=37
- Series prefixes: `KXHIGH` (daily high temp), `KXLOW` (daily low temp), `KXRAIN` (precip), `KXSNOW` (snowfall)
- Station suffix: `NY`→KNYC, `ORD`→KORD, `LAX`→KLAX, `DFW`→KDFW, `IAH`→KIAH, `DEN`→KDEN, `PHL`→KPHL, `ATL`→KATL, `SFO`→KSFO, `MIA`→KMIA
- Bracket encoding: `B37` = floor of 37°F. The bracket width varies by market but is typically 1-2°F. Look at the market `title` field or adjacent markets in the event to determine `bracketHigh`.
- Use the shared helpers in `shared/types/index.ts`: `seriesCategory()`, `extractStationFromSeries()`

**Filtering:** Only discover markets where:
- Series ticker starts with one of `CLIMATE_SERIES_PREFIXES`
- Station is in `config.bot.enabledStations`
- If `config.bot.enabledSeries` is non-empty, only those series
- Market status is "open"
- Target date is within the next 7 days

#### Task 1.2: Weather Data Fetching

Create `app/data/services/ensemble.ts`:

The `ProbabilityEstimator` requires an array of ensemble member forecast values. We need a service that:

1. For each market, determines the station + target date + forecast type (high_temp, etc.)
2. Fetches ensemble forecast data (GFS/GEFS ensemble has ~30 members)
3. Caches the raw data in `weather_forecasts` table
4. Returns the ensemble values array to the estimator

**Data source options (implement at least one):**

**Option A: Open-Meteo (free, recommended first):**
- Endpoint: `https://ensemble-api.open-meteo.com/v1/ensemble`
- Params: `latitude`, `longitude`, `daily=temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum`, `models=gfs_seamless`
- Returns up to 31 ensemble members
- No API key required, generous rate limits
- **Note:** Returns temperatures in Celsius — convert to Fahrenheit using `cToF()` from shared utils
- **Note:** The specific ensemble members for each variable are returned as `temperature_2m_max_member01`, `temperature_2m_max_member02`, etc.

**Option B: NWS Grid Data (free, already partially implemented):**
- The `NwsService.getGridData()` method returns gridded forecasts
- This gives point forecasts, not ensembles
- Can be used as a fallback when ensemble data isn't available
- To simulate an ensemble, use the point forecast ± historical std dev to generate a normal distribution

**Caching strategy:**
- Cache each fetch in `weather_forecasts` with `source`, `forecastType`, `forecastHorizon`, `ensembleValues` (JSON array)
- Before fetching, check if we have a recent cache hit (same station + targetDate + source, fetched within last 6 hours)
- After market resolution, update `weather_forecasts.actualValue` with the observed value

#### Task 1.3: Signal Generation (Evaluate Phase)

Wire the existing `ProbabilityEstimator` and `getEffectiveThreshold` into the orchestrator:

1. For each open market with fresh weather data:
   - Call `estimator.estimate(market, ensembleValues)` → get `EstimateResult`
   - Call `getEffectiveThreshold(estimatedProb, seriesTicker)` → get threshold
   - Compute edge: `estimatedProb - marketYesPrice/100` (for YES side), or `(1 - estimatedProb) - marketNoPrice/100` (for NO side)
   - Determine recommendation: if `|edge| > threshold && confidence > config.bot.minConfidence` → buy the side with positive edge; else skip
   - Compute Kelly fraction via `computeKelly()`
2. Insert signal into `signals` table with full reasoning JSON
3. Emit `bus.emit("signal:new", ...)`

#### Task 1.4: Execution (already implemented, just wire in)

The `ExecutionService.executeSignal()` is fully implemented. In the orchestrator:

1. Get current balance (from Kalshi API in live mode, or from last known balance in dry run)
2. For each signal with recommendation != "skip": call `executionService.executeSignal(signal, balance)`
3. Update `signals.acted`, `signals.orderId` or `signals.skipReason`

#### Task 1.5: Reconciliation Service

Create `app/engine/services/reconciliation.ts`:

This runs at the end of every tick and handles:

**A. Order Status Sync** (live mode only):
1. Query `orders` table for status = "open"
2. For each, poll `kalshiClient.getOrders({ ticker })` for current status
3. Update `orders.filledQuantity`, `orders.status`
4. For newly filled orders, insert into `trades` table

**B. Position Maintenance:**
1. Recompute `positions` table from `trades` (group by ticker, compute avg entry, quantity)
2. For each position, get latest market price from `markets` table
3. Update `positions.marketValue` and `positions.unrealizedPnl`
4. Emit `bus.emit("position:update", ...)` for each position
5. Remove positions for settled markets (quantity = 0 after settlement)

**C. Market Resolution Detection:**
1. Query `markets` where `status = "open"` and check Kalshi for updates
2. When a market settles:
   - Update `markets.status` = "settled", `markets.result`
   - Compute realized PnL for any position in this market
   - Create a `calibration` record: predicted prob (from signals), actual outcome, realized PnL
   - Emit `bus.emit("market:resolved", ...)`

**D. Station Bias Update:**
1. After a market resolves, look up the corresponding `weather_forecasts` records
2. Fetch actual observed value from NWS observations if not already recorded
3. Compare predicted ensemble mean to actual observation
4. Recompute the rolling `station_bias` for this station + horizon:
   - Query all `weather_forecasts` for this station within `config.calibration.biasWindowDays`
   - Compute `meanBias = mean(predicted - actual)`, `stdBias = std(predicted - actual)`
   - Upsert `station_bias` table

**E. Balance Snapshot:**
1. Get current balance from Kalshi (live) or compute from last balance + dry run PnL
2. Compute total equity = balance + sum of position market values
3. Insert into `balance_history`
4. Emit `bus.emit("balance:update", ...)`

### Phase 2: Missing Commands

#### Task 2.1: `explain` Command

Create `app/cli/src/commands/explain.ts`:

```
> explain KXHIGHNY-25FEB19-B37
```

1. Look up the most recent `signal` for this ticker
2. Parse the `reasoning` JSON blob (it's a `ReasoningTrace` object stored by the estimator)
3. Format a human-readable explanation:
   - Market details (title, bracket, current price)
   - Our estimate and confidence
   - Edge calculation
   - Ensemble breakdown: N members total, M in bracket
   - Bias correction applied (station, horizon, mean bias, sample size)
   - Historical verification rate for this bracket (from calibration table)
   - Action taken (buy/skip) with reasoning
   - If traded: Kelly fraction, contracts, order status

Register this in the command registry at `app/cli/src/commands/index.ts`.

#### Task 2.2: `backtest` Command

Create `app/cli/src/commands/backtest.ts`:

```
> backtest KXHIGHNY --days 30
```

1. Query `weather_forecasts` for this series + station, last N days, where `actualValue` is not null
2. For each day's forecasts, re-run the `ProbabilityEstimator` using the archived ensemble data
3. Compare estimated probability to actual outcome
4. Simulate trades using the execution logic (Kelly sizing at historical market prices from `signals` or `markets` table)
5. Report: total markets evaluated, signals generated, win rate, simulated P&L, Brier score, Sharpe ratio

Register this in the command registry.

#### Task 2.3: `calibration retrain` Subcommand

In `app/cli/src/commands/calibration.ts`, implement the `retrainCalibration()` function:

1. Recompute all `station_bias` entries from full `weather_forecasts` history
2. Recompute all `adaptive_thresholds` entries from full `calibration` history
3. Report what changed

### Phase 3: Robustness

#### Task 3.1: Runtime Config Persistence

In `packages/config/src/index.ts`, add logic to `loadConfig()` that:

1. After loading from env, query `runtime_config` table for any overrides
2. Apply overrides on top of env-based config
3. This ensures `config set` values survive restarts

#### Task 3.2: Log File Writer

Create `app/engine/services/log-writer.ts`:

1. Subscribe to `bus.on("log", ...)`
2. Append JSON lines to `logs/bot.log`
3. Implement basic rotation: when file exceeds 10MB, rename to `bot.log.1` and start fresh

#### Task 3.3: Graceful Shutdown

In `app/cli/src/index.tsx`, ensure:

1. `orchestrator.stop()` is called on Ctrl+C
2. Any pending DB writes complete
3. Open Kalshi orders are NOT auto-canceled (user should decide)

#### Task 3.4: Error Recovery

In the orchestrator tick:

1. If any phase throws, catch the error, log it, emit `bot:error`, and continue to the next tick
2. If Kalshi API returns 429 (rate limit), back off exponentially
3. If NWS API fails, use cached data and log a warning
4. If ensemble API fails, fall back to NWS point forecast with synthetic distribution

---

## Database Schema Reference

All tables are defined in `packages/db/src/schema/`. Drizzle generates migrations from these.

### `markets`
Primary record of Kalshi markets we track. Keyed by `ticker` (e.g., `KXHIGHNY-25FEB19-B37`).

| Column | Type | Description |
|--------|------|-------------|
| ticker | TEXT PK | Kalshi market ticker |
| event_ticker | TEXT | Event grouping (e.g., KXHIGHNY-25FEB19) |
| series_ticker | TEXT | Series (e.g., KXHIGHNY) |
| title | TEXT | Human-readable title |
| category | TEXT | high_temp, low_temp, precip, snowfall |
| station_id | TEXT | NWS station (KNYC, KORD, etc.) |
| target_date | TEXT | Weather event date (YYYY-MM-DD) |
| bracket_low | REAL | Lower bound of bracket (°F or inches) |
| bracket_high | REAL | Upper bound of bracket |
| status | TEXT | open, closed, settled |
| close_time | TEXT | Market close time (ISO 8601) |
| result | TEXT | yes, no, or null |
| last_yes_price | INTEGER | Last YES price in cents (0-100) |
| last_no_price | INTEGER | Last NO price in cents (0-100) |
| discovered_at | TEXT | When first discovered |
| updated_at | TEXT | Last update time |

### `orders`
Orders placed on Kalshi (or simulated in dry run).

| Column | Type | Description |
|--------|------|-------------|
| order_id | TEXT PK | Kalshi order ID or dry-run ID |
| ticker | TEXT | Market ticker |
| action | TEXT | buy or sell |
| side | TEXT | yes or no |
| limit_price | INTEGER | Limit price in cents |
| quantity | INTEGER | Contracts requested |
| filled_quantity | INTEGER | Contracts filled |
| status | TEXT | open, filled, partial, canceled, expired |
| signal_id | TEXT | Signal that triggered this order |
| dry_run | INTEGER (bool) | Was this a simulated order? |
| kelly_fraction | REAL | Kelly fraction used for sizing |
| created_at | TEXT | Order creation time |
| updated_at | TEXT | Last status update |

### `trades`
Individual fills from orders.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| order_id | TEXT | Parent order |
| ticker | TEXT | Market ticker |
| side | TEXT | yes or no |
| price | INTEGER | Fill price in cents |
| quantity | INTEGER | Contracts filled |
| action | TEXT | buy or sell |
| filled_at | TEXT | Fill time |

### `positions`
Cached open positions (computed from trades, updated each tick).

| Column | Type | Description |
|--------|------|-------------|
| ticker | TEXT PK | Market ticker |
| side | TEXT | yes or no |
| quantity | INTEGER | Contracts held |
| avg_entry_price | REAL | Average entry in cents |
| cost_basis | REAL | Total cost in cents |
| market_value | REAL | Current value (qty × price) |
| unrealized_pnl | REAL | Market value - cost basis |
| opened_at | TEXT | When position was opened |
| updated_at | TEXT | Last update |

### `signals`
Trading signals generated by the estimator each tick.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| ticker | TEXT | Market ticker |
| series_ticker | TEXT | For grouping/filtering |
| estimated_prob | REAL | Our probability (0-1) |
| confidence | REAL | Estimate confidence (0-1) |
| market_price | REAL | YES price at signal time (0-1) |
| edge | REAL | estimated_prob - market_price |
| edge_threshold | REAL | Threshold used |
| recommendation | TEXT | buy_yes, buy_no, skip |
| side | TEXT | yes or no (which has edge) |
| kelly_fraction | REAL | Kelly-optimal bet fraction |
| ensemble_size | INTEGER | Members used |
| reasoning | TEXT | JSON ReasoningTrace blob |
| acted | INTEGER (bool) | Was this traded? |
| order_id | TEXT | Order placed, if any |
| skip_reason | TEXT | Why skipped, if applicable |
| created_at | TEXT | Signal generation time |

### `calibration`
One record per resolved market where we had a signal. The core self-improvement data.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| ticker | TEXT | Market ticker |
| series_ticker | TEXT | For grouping |
| category | TEXT | Market category |
| station_id | TEXT | NWS station |
| predicted_prob | REAL | Our prediction (0-1) |
| actual_outcome | INTEGER | 1=YES settled, 0=NO settled |
| market_price | REAL | Market price at signal time |
| edge | REAL | Our edge at signal time |
| realized_pnl | REAL | Realized PnL in cents (null if not traded) |
| traded | INTEGER (bool) | Did we trade? |
| forecast_horizon | INTEGER | Days out at signal time |
| resolved_at | TEXT | Resolution time |

### `station_bias`
Rolling bias correction per NWS station per forecast horizon. Recomputed after each resolution.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Composite: stationId-horizon |
| station_id | TEXT | NWS station (KNYC, etc.) |
| forecast_horizon_days | INTEGER | 1-7 days out |
| mean_bias | REAL | Mean error in °F (positive = model warm) |
| std_bias | REAL | Std dev of bias |
| sample_size | INTEGER | Data points in window |
| window_days | INTEGER | Rolling window size |
| updated_at | TEXT | Last recomputation |

### `adaptive_thresholds`
Per-bucket, per-series edge thresholds that adjust based on calibration accuracy.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Composite: series-bucket |
| series_ticker | TEXT | Series or "__global__" |
| bucket_label | TEXT | e.g., "0.0-0.1", "0.3-0.5" |
| edge_threshold | REAL | Effective threshold for this bucket |
| calibration_error | REAL | Predicted - actual rate |
| sample_size | INTEGER | Records in bucket |
| updated_at | TEXT | Last recomputation |

### `weather_forecasts`
Cached forecast data for backtesting and bias calculation.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| station_id | TEXT | NWS station |
| target_date | TEXT | YYYY-MM-DD |
| source | TEXT | nws, gfs_ensemble, ecmwf, openweather |
| forecast_type | TEXT | high_temp, low_temp, precip, snowfall |
| forecast_horizon | INTEGER | Days out when fetched |
| point_forecast | REAL | Point value (°F or inches) |
| ensemble_values | TEXT | JSON array of member values |
| ensemble_size | INTEGER | Number of members |
| ensemble_mean | REAL | Mean of ensemble |
| ensemble_std | REAL | Std dev of ensemble |
| actual_value | REAL | Observed value (filled post-resolution) |
| fetched_at | TEXT | Fetch time |

### `balance_history`
Periodic snapshots for equity curve tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| balance | INTEGER | Cash in cents |
| total_equity | INTEGER | Cash + positions in cents |
| open_positions | INTEGER | Count |
| realized_pnl | INTEGER | Cumulative in cents |
| recorded_at | TEXT | Snapshot time |

### `runtime_config`
Key-value store for config overrides that persist across restarts.

| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PK | Config key (matches `config set` names) |
| value | TEXT | Serialized value |
| updated_at | TEXT | Last update |

---

## Event Bus Reference

Defined in `app/engine/events.ts`. The singleton `bus` is imported as `import { bus } from "@kcb/engine"`.

| Event | Payload | Emitter |
|-------|---------|---------|
| `bot:status` | `{ running, dryRun, lastTick, tickCount, uptime }` | loop.ts (each tick) |
| `bot:error` | `{ module, message, error? }` | Any module on error |
| `signal:new` | `{ id, ticker, side, edge, confidence, recommendation, estimatedProb, marketPrice }` | Orchestrator Phase 3 |
| `order:placed` | `{ orderId, ticker, action, side, price, quantity, dryRun }` | execution.ts |
| `order:update` | `{ orderId, status, filledQuantity, ticker }` | Reconciliation |
| `position:update` | `{ ticker, side, quantity, unrealizedPnl, avgEntryPrice }` | Reconciliation |
| `balance:update` | `{ balance, totalEquity }` | Reconciliation |
| `market:discovered` | `{ ticker, eventTicker, title, category }` | Discovery |
| `market:resolved` | `{ ticker, result, predictedProb?, realizedPnl? }` | Reconciliation |
| `calibration:updated` | `{ ticker, predictedProb, actualOutcome, calibrationError, brierScore }` | Reconciliation |
| `log` | `{ level, module, message, data?, timestamp }` | createLogger (all modules) |

All engine modules should use `createLogger("module-name")` instead of `console.log`. This emits structured log events to the bus.

---

## External API Reference

### Kalshi API (v2)

**Base URL:** `https://api.elections.kalshi.com/trade-api/v2`

**Auth:** POST `/login` with email (API key) + password (API secret) → receives bearer token. Token lasts ~24h.

**Key endpoints used:**
- `GET /markets?series_ticker=KXHIGHNY&status=open` — list markets
- `GET /markets/{ticker}` — single market detail
- `GET /events/{event_ticker}` — event with all its markets
- `POST /portfolio/orders` — place order
- `DELETE /portfolio/orders/{order_id}` — cancel order
- `GET /portfolio/orders` — list orders
- `GET /portfolio/balance` — cash balance
- `GET /portfolio/positions` — open positions

**Rate limits:** Refer to Kalshi API docs. Implement exponential backoff on 429.

**Important:** The Kalshi API uses `yes_price` and `no_price` in cents (0-99). Market prices are integers, not decimals. A market priced at 22¢ YES means `yes_bid` or `last_price` = 22.

### NWS API (free)

**Base URL:** `https://api.weather.gov`

**Required header:** `User-Agent: KalshiClimateBot/1.0 (contact@example.com)` — NWS requires identification.

**Key endpoints:**
- `GET /points/{lat},{lon}` — resolve coordinates to forecast office + grid
- `GET /gridpoints/{office}/{gridX},{gridY}/forecast` — 7-day forecast periods
- `GET /gridpoints/{office}/{gridX},{gridY}` — raw gridded data (hourly values, more detail)
- `GET /stations/{stationId}/observations?limit=24` — recent observations

**Station coordinates** are hardcoded in `app/data/services/nws.ts` for the 10 stations we track.

**Important:** NWS returns temperatures in Celsius in the raw grid data but Fahrenheit in the forecast periods. Always check the `temperatureUnit` or `unitCode` field.

### Open-Meteo Ensemble API (free, recommended)

**Base URL:** `https://ensemble-api.open-meteo.com/v1/ensemble`

**Example request:**
```
GET /v1/ensemble?latitude=40.78&longitude=-73.97&daily=temperature_2m_max&models=gfs_seamless&forecast_days=7
```

**Key params:**
- `latitude`, `longitude` — station coordinates
- `daily` — variables: `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `snowfall_sum`
- `models` — `gfs_seamless` (31 members), `icon_seamless`, `ecmwf_ifs025`
- `forecast_days` — 1-16

**Response structure:** Returns `daily.temperature_2m_max_member01` through `temperature_2m_max_member30` plus the control run.

**Important:** All temperatures in Celsius. Convert to Fahrenheit with `cToF()`.

**Rate limits:** Very generous for free tier. No API key needed.

---

## Configuration Reference

All config keys and their defaults, from `packages/config/src/index.ts`:

| Key | Env Var | Default | Description |
|-----|---------|---------|-------------|
| `kalshi.apiKey` | `KALSHI_API_KEY` | `""` | Kalshi API key |
| `kalshi.apiSecret` | `KALSHI_API_SECRET` | `""` | Kalshi API secret |
| `kalshi.baseUrl` | `KALSHI_BASE_URL` | `https://api.elections.kalshi.com/trade-api/v2` | API base URL |
| `bot.dryRun` | `DRY_RUN` | `true` | Don't place real orders |
| `bot.tickIntervalSec` | `TICK_INTERVAL_SEC` | `60` | Loop interval |
| `bot.edgeThreshold` | `EDGE_THRESHOLD` | `0.08` | Min edge to trade |
| `bot.minConfidence` | `MIN_CONFIDENCE` | `0.5` | Min confidence |
| `bot.maxKellyFraction` | `MAX_KELLY_FRACTION` | `0.05` | Kelly cap |
| `bot.maxOpenPositions` | `MAX_OPEN_POSITIONS` | `10` | Position limit |
| `bot.maxContractsPerOrder` | `MAX_CONTRACTS_PER_ORDER` | `25` | Order size limit |
| `bot.enabledStations` | `ENABLED_STATIONS` | `KNYC,KORD,KLAX,KDFW,KIAH` | Stations to track |
| `calibration.biasWindowDays` | `BIAS_WINDOW_DAYS` | `30` | Bias rolling window |
| `calibration.calibrationWindowDays` | `CALIBRATION_WINDOW_DAYS` | `30` | Calibration window |
| `calibration.maxCalibrationError` | `MAX_CALIBRATION_ERROR` | `0.05` | Max error before threshold adjustment |
| `db.path` | `DB_PATH` | `./data/kalshi-bot.db` | SQLite file path |
| `log.level` | `LOG_LEVEL` | `info` | Log verbosity |

**REPL-mutable keys** (via `config set`): `dry_run`, `edge_threshold`, `min_confidence`, `max_kelly`, `max_positions`, `max_contracts`, `tick_interval`, `bias_window_days`, `max_calibration_error`, `log_level`.

---

## REPL Command Reference

Commands are defined in `app/cli/src/commands/`. Each file exports an array of `CommandDef` objects. The registry in `commands/index.ts` flattens them into a lookup map by name and aliases.

```typescript
interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: (args: string[]) => Promise<string>;
}
```

To add a new command: create the `CommandDef[]` array, import it in `commands/index.ts`, add it to `commandGroups`.

### Existing Commands

| Command | Aliases | Args | Description |
|---------|---------|------|-------------|
| `start` | — | — | Start bot loop |
| `stop` | — | — | Stop bot loop |
| `status` | — | — | Show bot state, uptime, tick count |
| `restart` | — | — | Stop + start |
| `markets` | `ls`, `list` | `[status]` | List tracked markets, optional status filter |
| `inspect` | — | `<ticker>` | Full market details from DB |
| `positions` | `pos` | — | Open positions with P&L |
| `pnl` | — | — | Realized P&L summary |
| `orders` | — | `[status]` | Recent orders, optional status filter |
| `config` | `cfg` | `list\|get <key>\|set <key> <val>` | View/modify runtime config |
| `calibration` | `cal` | `summary\|detail [series]\|bias [station]\|retrain` | Calibration reports |
| `help` | — | — | List all commands |
| `exit` / `quit` | — | — | Return to dashboard |

### Commands to Implement

| Command | Args | Description |
|---------|------|-------------|
| `explain` | `<ticker>` | Show signal reasoning for a market |
| `backtest` | `<series> --days <N>` | Run estimator against historical data |

---

## Self-Improvement Loop

This is the core differentiator. The bot gets better over time via three automated feedback mechanisms:

### 1. Station Bias Tracking

Each NWS station has systematic forecast errors that vary by forecast horizon. For example, GFS might run 0.8°F warm for KNYC at a 3-day horizon.

After each market resolution:
- Compare the archived ensemble mean to the actual observation
- Recompute the rolling mean and std of the error over the last N days
- Store in `station_bias` table
- The estimator subtracts this bias from ensemble values before computing bracket probability

**This is the single biggest lever for accuracy improvement.**

### 2. Adaptive Edge Thresholds

Instead of a single global `edgeThreshold`, maintain per-bucket thresholds:

| Bucket | If well-calibrated | If miscalibrated |
|--------|-------------------|------------------|
| 0.0-0.1 | base × 0.9 | base × (1 + calibError) |
| 0.1-0.2 | base × 0.9 | base × (1 + calibError) |
| ... | ... | ... |

If we're systematically overestimating probabilities in the 0-10% range (our predicted 5% events are hitting 15%), we require more edge before trading those. If we're well-calibrated in the 50-70% range, we can accept slightly thinner edge.

### 3. Confidence Model

The estimator's confidence score factors in:
- **Spread factor (40%):** Tighter ensemble spread = higher confidence
- **Bias data quality (40%):** More historical bias data = higher confidence
- **Ensemble size (20%):** More ensemble members = higher confidence

As the bot runs longer, bias data quality improves, which increases confidence scores, which leads to more (and better) trades.

---

## Important Notes for Implementation

1. **Always use `createLogger("module-name")` instead of `console.log`.** The TUI captures stdout, so raw console output will corrupt the display.

2. **All DB operations should be synchronous-feeling.** Bun's SQLite driver is synchronous under the hood, but Drizzle wraps it in async. Don't worry about connection pooling — it's a single file.

3. **Generate UUIDs with `crypto.randomUUID()` (built into Bun).** The shared util `uuid()` wraps this.

4. **Timestamps are always `new Date().toISOString()`.** The shared util `now()` wraps this.

5. **The event bus is fire-and-forget.** Don't await event handlers. If a handler throws, it shouldn't crash the emitter.

6. **Kalshi API auth tokens expire.** The `KalshiClient` handles refresh automatically via `ensureAuth()`, but if you see 401 errors, the token refresh logic may need attention.

7. **NWS API requires a User-Agent header.** Requests without it get 403. This is already set in `NwsService`.

8. **Open-Meteo returns Celsius.** Always convert to Fahrenheit before storing or comparing to Kalshi market brackets (which are in °F).

9. **Market prices on Kalshi are in cents (0-99 for limit orders, 0-100 for last price).** The estimator works in 0-1 probability space. Convert: `marketPrice = lastYesPrice / 100`.

10. **The `reasoning` field in `signals` should be a JSON string** of the `ReasoningTrace` interface from `app/signals/services/estimator.ts`. Use `JSON.stringify()` when writing, `JSON.parse()` when reading for the `explain` command.

11. **Drizzle migrations must be generated before first run.** The `bun run db:generate` script creates SQL migration files from the schema. `bun run db:migrate` applies them.

12. **Don't import from `@kcb/cli` in engine packages.** The dependency direction is: `cli → engine → signals/data/execution → db/config/kalshi-client`. Never import upward.
