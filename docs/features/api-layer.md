# Bot API Layer — Elysia REST + WebSocket

## Context

The bot currently runs as a single process that couples the engine loop with an Ink-based terminal UI. The TUI subscribes to the singleton `bus` (TypedEmitter in `app/engine/events.ts`) for real-time updates and queries the SQLite DB directly for historical data.

To support a web interface (separate process), the bot needs to expose its data over REST and WebSocket. This plan adds an Elysia-based API server that runs **inside the bot process**, sharing the `bus` and DB connection. The web UI will be built separately and consume this API.

There is already precedent: `app/viz/` has a `Bun.serve()` server with REST endpoints (`api.ts`) and a WebSocket bridge (`ws-bridge.ts`) that forwards bus events. This plan builds on that pattern with a proper Elysia setup and complete API coverage.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Bot Process                                │
│                                             │
│  ┌──────────┐    bus     ┌──────────────┐   │
│  │  Engine   │ ────────> │  Elysia API  │   │
│  │  (loop,   │           │  - REST      │──────> Web UI (separate process)
│  │  orch.)   │           │  - WebSocket │   │
│  └──────────┘            └──────────────┘   │
│       │                        │            │
│       └────── SQLite DB ───────┘            │
│                                             │
│  ┌──────────┐  (optional, --tui flag)       │
│  │  Ink TUI │                               │
│  └──────────┘                               │
└─────────────────────────────────────────────┘
```

### Key decisions
- **Elysia** runs in-process (not a separate service) — shares `bus` singleton and DB
- **TUI becomes opt-in** via `--tui` flag; default mode is headless with console logging
- **Existing viz server** (`app/viz/`) is left untouched for now; can be deprecated later
- **CORS** enabled so the web UI can run on a different port/origin

---

## Implementation Plan

### Step 1: Create `app/api/` package

New workspace package with Elysia.

**Files to create:**
- `app/api/package.json`
- `app/api/index.ts` — exports `startApiServer(port)`
- `app/api/src/routes/status.ts` — bot status, config
- `app/api/src/routes/markets.ts` — markets list, detail
- `app/api/src/routes/positions.ts` — open positions
- `app/api/src/routes/orders.ts` — order history
- `app/api/src/routes/signals.ts` — signal history
- `app/api/src/routes/performance.ts` — PnL, calibration, equity, win rates
- `app/api/src/routes/logs.ts` — recent log entries
- `app/api/src/ws.ts` — WebSocket bridge (bus → clients)

**`app/api/package.json`:**
```json
{
  "name": "@kcb/api",
  "private": true,
  "version": "0.0.1",
  "main": "index.ts",
  "dependencies": {
    "@kcb/config": "workspace:*",
    "@kcb/db": "workspace:*",
    "@kcb/engine": "workspace:*",
    "elysia": "^1.2"
  }
}
```

### Step 2: REST endpoints

All endpoints return JSON. Derived from what each TUI view currently displays.

#### Status & Config
| Method | Path | Description | Source |
|--------|------|-------------|--------|
| `GET` | `/api/status` | Bot running state, tick count, uptime, dry-run flag | `loop.getLoopState()` + bus `bot:status` cache |
| `GET` | `/api/config` | Non-sensitive bot config (tick interval, sniper horizon, thresholds) | `getConfig()` |

#### Markets
| Method | Path | Description | Source |
|--------|------|-------------|--------|
| `GET` | `/api/markets` | Active markets with prices, status. Query params: `?status=open&limit=50` | `markets` table |
| `GET` | `/api/markets/:ticker` | Single market detail including latest signal estimate | `markets` + `signals` tables |

#### Positions & Balance
| Method | Path | Description | Source |
|--------|------|-------------|--------|
| `GET` | `/api/positions` | All open positions with unrealized PnL | `positions` table |
| `GET` | `/api/balance` | Current cash + portfolio equity | `balanceHistory` table (latest row) |
| `GET` | `/api/balance/history` | Equity history for charting. Query params: `?limit=200`, `?dryRun=true\|false\|all`, `?span=7d\|30d\|all` (default: no time filter) | `balanceHistory` table |

#### Orders & Trades
| Method | Path | Description | Source |
|--------|------|-------------|--------|
| `GET` | `/api/orders` | Recent orders. Query params: `?limit=20&status=filled` | `orders` table |
| `GET` | `/api/trades` | Recent trades/fills | `trades` table |

#### Signals
| Method | Path | Description | Source |
|--------|------|-------------|--------|
| `GET` | `/api/signals` | Recent signals. Query params: `?limit=20&actionable=true` | `signals` table |
| `GET` | `/api/signals/:id` | Signal detail with full reasoning JSON | `signals` table |

#### Performance & Calibration
| Method | Path | Description | Source |
|--------|------|-------------|--------|
| `GET` | `/api/performance` | Aggregate stats: cash, portfolio, realized/unrealized PnL, win rate, Brier score, order count | Mirrors `performance-cache.ts` queries |
| `GET` | `/api/performance/daily-pnl` | Daily PnL breakdown. Query param: `?days=7` | `calibration` table grouped by day |
| `GET` | `/api/performance/win-rates` | Windowed win rates (24h, 48h, 7d) | `calibration` table |
| `GET` | `/api/performance/daily-win-rates` | Per-day win rate for the dashboard heatmap. Query param: `?days=84` (default). Returns `[{ date, total, wins, winRate }]` chronological ascending, including only days with ≥1 traded resolution. A win is `realizedPnl > 0` on a `traded = 1` row. | `calibration` table grouped by `date(resolvedAt)` |
| `GET` | `/api/performance/calibration` | Calibration bucket stats (predicted vs actual by probability bucket) | `calibration` table |
| `GET` | `/api/performance/resolutions` | Recent market resolutions with PnL. Query param: `?limit=10` | `calibration` table |

#### Logs
| Method | Path | Description | Source |
|--------|------|-------------|--------|
| `GET` | `/api/logs` | Recent log entries. Query params: `?level=info&module=orchestrator&limit=100` | In-memory ring buffer fed by bus `log` events |

### Step 3: WebSocket bridge

**Endpoint:** `ws://host/ws`

Mirrors the pattern in `app/viz/src/ws-bridge.ts`:

1. **On connect:** send a snapshot message with current state:
   ```json
   { "type": "snapshot", "data": { "status": {...}, "positions": [...], "balance": {...} } }
   ```

2. **Ongoing:** forward all bus events as they occur:
   ```json
   { "type": "signal:new", "data": { "ticker": "...", "edge": 0.12, ... } }
   ```

3. **Client subscription (optional, future):** clients can send `{ "subscribe": ["signal:new", "order:placed"] }` to filter. Default: all events.

**Events forwarded** (all 12 from `BotEvents`):
- `bot:status`, `bot:error`
- `signal:new`, `signal:scout`
- `forecast:fetched`
- `order:placed`, `order:update`
- `position:update`, `balance:update`
- `market:discovered`, `market:priceUpdate`, `market:resolved`
- `calibration:updated`
- `log`

### Step 4: Console log subscriber

When running headless (no TUI), subscribe to bus `log` events and print formatted output to stdout.

**File:** `app/api/src/console-logger.ts`

```ts
export function startConsoleLogger(): () => void {
  return bus.on("log", (entry) => {
    const ts = entry.timestamp.slice(11, 19); // HH:MM:SS
    const prefix = `[${ts}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.module}]`;
    console.log(`${prefix} ${entry.message}`);
  });
}
```

### Step 5: New headless entry point

**File:** `app/cli/src/headless.ts`

This replaces the default entry point behavior. The existing `index.tsx` is preserved for `--tui` mode.

```
app/cli/src/headless.ts:
  1. runMigrations()
  2. startLogWriter()
  3. startConsoleLogger()       ← new
  4. startApiServer(port)       ← new
  5. orchestrator.init() → orchestrator.start()
  6. Block until SIGINT/SIGTERM
```

### Step 6: Update entry point and scripts

**Modify `app/cli/src/index.tsx`:**
- If `--tui` flag passed → existing Ink TUI behavior
- Otherwise → delegate to headless entry point

**Update `package.json` scripts:**
```json
{
  "bot": "bun run app/cli/src/index.tsx",
  "bot:tui": "bun run app/cli/src/index.tsx --tui",
  "bot:api-only": "bun run app/cli/src/headless.ts"
}
```

**Environment variable:** `API_PORT` (default `3100`)

### Step 7: Tests

**File:** `app/api/src/routes/*.test.ts`

- Test each route group returns correct shape
- Test WebSocket connection receives snapshot on connect
- Test WebSocket receives bus events after emit
- Use real in-memory DB with `runMigrations()` + seed data (per project conventions — never mock `@kcb/db`)

---

## Files modified (summary)

| File | Change |
|------|--------|
| `app/api/` (new) | Entire new package — Elysia server, routes, WS bridge, console logger |
| `app/cli/src/index.tsx` | Add `--tui` flag gate; default to headless |
| `app/cli/src/headless.ts` (new) | Headless entry point: engine + API, no TUI |
| `app/cli/package.json` | Add `@kcb/api` dependency |
| `package.json` | Add `bot:tui` and `bot:api-only` scripts |

## Existing code to reuse

- **`app/viz/src/api.ts`** — query patterns for positions, balance, orders, performance. Don't import directly (pulls in Three.js dep), but reuse the query logic.
- **`app/viz/src/ws-bridge.ts`** — WebSocket bridge pattern (bus → broadcast to clients). Adapt for Elysia's WebSocket API.
- **`app/cli/src/views/performance-cache.ts`** — query functions for stats, win rates, calibration buckets, daily PnL. Reuse these queries in the performance routes.
- **`app/engine/events.ts`** — `bus` singleton and `BotEvents` types are the contract for the WebSocket layer.

## Verification

1. `bun install` — Elysia installs
2. `bun run app/cli/src/headless.ts` — bot starts, logs to console, API server listens
3. `curl http://localhost:3100/api/status` — returns bot status JSON
4. `curl http://localhost:3100/api/positions` — returns positions array
5. `curl http://localhost:3100/api/performance` — returns aggregate stats
6. `websocat ws://localhost:3100/ws` — receives snapshot then live events
7. `bun test app/api/` — all route + WS tests pass
8. `bun run app/cli/src/index.tsx --tui` — existing TUI still works
