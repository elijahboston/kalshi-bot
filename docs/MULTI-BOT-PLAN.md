# Multi-Bot Architecture Plan

## Overview

Evolve the single-strategy climatebot into a multi-bot system that runs multiple independent trading strategies (climate, oil, and future additions) within a single process. Each bot has its own capital allocation, performance tracking, and tick cadence, while sharing infrastructure (Kalshi client, DB, execution engine, TUI, viz).

---

## Design Principles

1. **Single process** — all bots run in one process with independent tick timers. Simpler ops, shared rate limiting, no SQLite contention.
2. **Capital isolation** — each bot gets an allocated balance. Kelly sizing and exposure limits operate on the bot's allocation, not total Kalshi balance.
3. **Performance isolation** — per-bot PnL, win rate, Brier score, equity curves. Combined portfolio view available.
4. **Strategy as plugin** — a `Strategy` interface defines what each bot does (discover, estimate, evaluate). The orchestrator is generic.
5. **Additive migration** — existing climate data stays intact. All schema changes are additive (new columns with defaults, new tables).

---

## Strategy Interface

The core abstraction that separates generic orchestration from domain-specific logic.

```typescript
interface Strategy {
  /** Unique bot identifier — used in DB, events, and UI */
  id: string;                          // "climate", "oil", etc.
  label: string;                       // "Climate", "WTI Oil"

  /** Bot-specific config (tick interval, edge thresholds, etc.) */
  config: StrategyConfig;

  /** Phase 1: Discover markets for this strategy */
  discover(): Promise<DiscoveredMarket[]>;

  /** Phase 2: Estimate probabilities for discovered markets */
  estimate(markets: DiscoveredMarket[]): Promise<Estimate[]>;

  /** Phase 3: Evaluate estimates against market prices, generate signals */
  evaluate(estimates: Estimate[]): Promise<Signal[]>;

  /** Optional: strategy-specific exit logic beyond standard stop-loss */
  evaluateExits?(positions: Position[], estimates: Estimate[]): Promise<ExitSignal[]>;
}

interface StrategyConfig {
  tickIntervalSec: number;
  edgeThreshold: number;
  maxKellyFraction: number;
  maxOpenPositions: number;
  maxContractsPerOrder: number;
  maxExposurePerTicker: number;
  minContractPrice: number;
  stopLossPct: number;
  exitEdgeThreshold: number;
  exitCooldownTicks: number;
  dryRun: boolean;
}
```

### Climate Strategy

Wraps existing code:
- `discover()` → calls `discoverMarkets()` from `app/engine/services/discovery.ts`
- `estimate()` → calls `EnsembleService` + `ProbabilityEstimator`
- `evaluate()` → edge computation + adaptive thresholds
- `evaluateExits()` → edge reversal, stop-loss, time decay (current orchestrator logic)

### Oil Strategy

New code:
- `discover()` → fetches KXWTI/KXWTIMAX series from Kalshi
- `estimate()` → calls `OilDataService` + `OilEstimator` (GBM/Monte Carlo)
- `evaluate()` → edge computation (may use different threshold logic)
- `evaluateExits()` → oil-specific exit triggers (e.g., EIA report imminent)

---

## Database Changes

### New Column: `bot_id`

Add `bot_id TEXT NOT NULL DEFAULT 'climate'` to these tables:

| Table | Migration Notes |
|-------|----------------|
| `orders` | Default `'climate'` preserves existing data |
| `trades` | Default `'climate'` preserves existing data |
| `positions` | Change PK from `ticker` to composite `(ticker, bot_id)` |
| `signals` | Default `'climate'` preserves existing data |
| `calibration` | Default `'climate'` preserves existing data |
| `balance_history` | Default `'climate'` preserves existing data |

Tables that stay unchanged:
- `markets` — shared across bots (both bots may look at the same market)
- `weather_forecasts` — climate-specific, but no need for bot_id (it's a data cache)
- `runtime_config` — extend key naming: `climate.edgeThreshold`, `oil.edgeThreshold`
- `adaptive_thresholds` — add bot_id (thresholds are per-strategy)

### New Table: `bot_allocations`

```sql
CREATE TABLE bot_allocations (
  bot_id       TEXT PRIMARY KEY,        -- "climate", "oil"
  label        TEXT NOT NULL,           -- "Climate", "WTI Oil"
  allocated    INTEGER NOT NULL,        -- Allocated balance in cents
  realized_pnl INTEGER NOT NULL DEFAULT 0,  -- Cumulative realized PnL in cents
  enabled      INTEGER NOT NULL DEFAULT 1,  -- Master on/off switch
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

**Capital flow:**
- On startup, each bot reads its `allocated` balance from `bot_allocations`
- Kelly sizing uses `allocated + realized_pnl` as the bankroll
- When a position settles, realized PnL credits/debits the bot's `realized_pnl`
- The `allocated` field is manually adjusted by the user (via REPL command or config)
- Treasury view: `total_kalshi_balance - SUM(allocated)` = unallocated cash

### New Table: `oil_forecasts`

```sql
CREATE TABLE oil_forecasts (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,           -- "eia", "fred", "futures", "news"
  data_type   TEXT NOT NULL,           -- "inventory", "spot_price", "futures_curve", "sentiment"
  data_json   TEXT NOT NULL,           -- Flexible JSON blob
  fetched_at  TEXT NOT NULL,
  expires_at  TEXT                     -- Cache TTL
);
```

### Migration Strategy

Single migration file that:
1. Adds `bot_id` column with `DEFAULT 'climate'` (existing rows auto-tagged)
2. Recreates `positions` table with composite PK `(ticker, bot_id)`
3. Creates `bot_allocations` table
4. Creates `oil_forecasts` table
5. Inserts initial allocation row: `('climate', 'Climate', 20641, 0, 1, ...)`

---

## Event Bus Changes

Add `botId` to all event payloads. The bus remains a singleton — subscribers filter by bot.

```typescript
type BotEvents = {
  "signal:new": {
    botId: string;          // ← NEW
    id: string;
    ticker: string;
    side: "yes" | "no";
    edge: number;
    // ... rest unchanged
  };
  "order:placed": {
    botId: string;          // ← NEW
    orderId: string;
    // ... rest unchanged
  };
  "position:update": {
    botId: string;          // ← NEW
    ticker: string;
    // ... rest unchanged
  };
  "balance:update": {
    botId: string;          // ← NEW
    cash: number;
    portfolio: number;
  };
  "market:resolved": {
    botId: string;          // ← NEW
    ticker: string;
    result: "yes" | "no";
    // ... rest unchanged
  };
  // ... same pattern for all events
};
```

The `"log"` event adds a `botId` field so log views can filter by bot.

---

## Orchestrator Refactor

### Current (Single Strategy)

```
orchestrator.ts
  ├── Phase 1: discoverMarkets()           ← climate-specific
  ├── Phase 2: ensembleService.get()       ← climate-specific
  │            estimator.estimate()        ← climate-specific
  ├── Phase 3: evaluate signals            ← generic
  ├── Phase 3.5: exit evaluation           ← generic
  ├── Phase 4: executionService.execute()  ← generic
  └── Phase 5: reconciliation.reconcile()  ← generic
```

### New (Multi-Strategy)

```
bot-manager.ts                             ← NEW: manages all bots
  ├── BotInstance("climate", climateStrategy, climateConfig)
  │     ├── own setInterval(tick, 120_000)
  │     ├── tick():
  │     │   ├── strategy.discover()
  │     │   ├── strategy.estimate()
  │     │   ├── strategy.evaluate()
  │     │   ├── evaluateExits()            ← generic + strategy override
  │     │   ├── executionService.execute()  ← shared, passes botId
  │     │   └── reconciliation.reconcile() ← shared, filters by botId
  │     └── own capital allocation
  │
  └── BotInstance("oil", oilStrategy, oilConfig)
        ├── own setInterval(tick, 1_800_000)
        ├── tick(): same structure, different strategy impl
        └── own capital allocation
```

### BotInstance Class

```typescript
class BotInstance {
  constructor(
    public strategy: Strategy,
    private execution: ExecutionService,
    private reconciliation: ReconciliationService,
  ) {}

  async tick(): Promise<void> {
    const markets = await this.strategy.discover();
    const estimates = await this.strategy.estimate(markets);
    const signals = await this.strategy.evaluate(estimates);
    await this.evaluateExits(estimates);
    await this.executeSignals(signals);
    await this.reconciliation.reconcile(this.strategy.id);
  }

  start(): void { /* setInterval based on strategy.config.tickIntervalSec */ }
  stop(): void { /* clearInterval */ }
}
```

### BotManager

```typescript
class BotManager {
  private bots = new Map<string, BotInstance>();

  register(bot: BotInstance): void;
  startAll(): void;
  stopAll(): void;
  getBot(id: string): BotInstance | undefined;
  listBots(): BotInstance[];
}
```

---

## Config Changes

### Structure

```typescript
interface AppConfig {
  kalshi: { apiKey: string; apiSecret: string; baseUrl: string };
  db: { path: string };
  log: { level: string };
  ai?: { anthropicApiKey?: string };

  /** Per-bot strategy configs */
  bots: {
    climate: {
      enabled: boolean;
      tickIntervalSec: number;          // 120
      edgeThreshold: number;            // 0.08
      maxKellyFraction: number;         // 0.05
      maxOpenPositions: number;         // 10
      maxContractsPerOrder: number;     // 25
      maxExposurePerTicker: number;     // 800
      minContractPrice: number;         // 15
      stopLossPct: number;              // 0.25
      exitEdgeThreshold: number;
      exitCooldownTicks: number;        // 3
      enabledSeries: string[];          // ["KXHIGHNY", ...]
      enabledStations: string[];        // ["KNYC", ...]
      // Climate-specific
      weather: { openweatherApiKey?: string; tomorrowIoApiKey?: string };
      calibration: { biasWindowDays: number; calibrationWindowDays: number; maxCalibrationError: number };
    };
    oil: {
      enabled: boolean;
      tickIntervalSec: number;          // 1800
      edgeThreshold: number;            // 0.15
      maxKellyFraction: number;         // 0.02
      maxOpenPositions: number;         // 4
      maxContractsPerOrder: number;     // 10
      maxExposurePerTicker: number;     // 500
      minContractPrice: number;         // 10
      stopLossPct: number;              // 0.20
      exitEdgeThreshold: number;
      exitCooldownTicks: number;        // 2
      enabledSeries: string[];          // ["KXWTI", "KXWTIMAX"]
      // Oil-specific
      eiaApiKey?: string;
      fredApiKey?: string;
    };
  };
}
```

### Environment Variables

Per-bot env vars use a prefix convention:
```
CLIMATE_TICK_INTERVAL_SEC=120
CLIMATE_EDGE_THRESHOLD=0.08
CLIMATE_DRY_RUN=false

OIL_TICK_INTERVAL_SEC=1800
OIL_EDGE_THRESHOLD=0.15
OIL_DRY_RUN=true
OIL_EIA_API_KEY=xxx
OIL_FRED_API_KEY=xxx
```

Shared vars stay unprefixed: `KALSHI_API_KEY`, `DB_PATH`, `LOG_LEVEL`.

---

## TUI Changes

### Bot Selector (Top Bar)

```
[All] [Climate] [Oil]  │  [1] Dashboard [2] Markets [3] Logs [4] Activity [5] Performance  │  ^R REPL
──────────────────────────────────────────────────────────────────────────────────────────────
```

- `A` key → All bots (combined view)
- `C` key → Climate only
- `O` key → Oil only
- Active bot filter applies to all tabs

### Dashboard Changes

```
┌─ Climate ────────────────────┐  ┌─ Oil ──────────────────────────┐
│ Allocated: $150.00           │  │ Allocated: $56.00              │
│ Cash:      $132.93           │  │ Cash:      $56.00              │
│ Positions: 3 ($17.07)        │  │ Positions: 0                   │
│ PnL:       +$12.41           │  │ PnL:       $0.00               │
│ Win Rate:  62% (24h)         │  │ Win Rate:  — (no trades)       │
│ Status:    ● Running         │  │ Status:    ● Dry Run           │
│ Next Tick: 45s               │  │ Next Tick: 22m                 │
└──────────────────────────────┘  └────────────────────────────────┘

Treasury: $206.41 Kalshi │ $206.00 allocated │ $0.41 unallocated
```

### Performance Tab

When a specific bot is selected, shows that bot's metrics only. When "All" is selected, shows:
- Combined equity curve (stacked or overlaid)
- Per-bot PnL breakdown
- Per-bot win rates and Brier scores
- Combined portfolio value

### Markets Tab

- Filtered by bot: climate shows weather markets, oil shows WTI markets
- "All" shows both with a bot indicator column

### Logs Tab

- Filtered by bot (log events include `botId`)
- "All" shows interleaved logs with `[climate]` / `[oil]` prefix

### Status Bar

```
● Climate: running │ ● Oil: dry-run │ $206.41 │ 3 positions │ Tick: Climate 45s │ Oil 22m
```

---

## Viz (Mission Control) Changes

### API Endpoints

All endpoints gain an optional `?botId=` query parameter:
- `GET /api/positions?botId=climate` — positions for climate bot only
- `GET /api/balance?botId=oil` — oil bot allocation + PnL
- `GET /api/performance?botId=climate` — climate-specific performance
- `GET /api/balance` (no filter) — combined portfolio
- `GET /api/bots` — NEW: list all bots with status, allocation, PnL summary

### WebSocket Messages

All WS messages include `botId`. Frontend filters based on active view.

### Globe

- Climate trades: particles from weather station locations (existing)
- Oil trades: particles from a fixed point (e.g., Cushing, Oklahoma — WTI delivery point) or an oil derrick icon
- Different particle colors per bot: cyan/green for climate, amber/orange for oil

### HUD

- Bot selector buttons in overlay
- Per-bot stats panels or a combined summary

---

## REPL Commands

New commands for multi-bot management:

```
> bots                           # List all bots with status
> bot climate                    # Switch context to climate bot
> bot oil                        # Switch context to oil bot
> allocate climate 15000         # Set climate allocation to $150.00
> allocate oil 5600              # Set oil allocation to $56.00
> enable oil                     # Enable oil bot
> disable oil                    # Disable oil bot (stops tick loop)
> treasury                       # Show total balance vs allocations
```

---

## File Changes Summary

### New Files

```
app/engine/services/bot-manager.ts          # BotManager + BotInstance classes
app/engine/services/bot-manager.test.ts
app/engine/services/strategy.ts             # Strategy interface + types
app/engine/strategies/climate-strategy.ts   # Wraps existing climate logic
app/engine/strategies/climate-strategy.test.ts
app/oilbot/                                 # Oil strategy (see OILBOT-PLAN.md)
packages/db/src/schema/oil.ts               # Oil forecasts table
packages/db/src/schema/bots.ts              # Bot allocations table
packages/db/src/migrations/XXXX_multi_bot.sql  # Add bot_id columns + new tables
```

### Modified Files

| File | Change |
|------|--------|
| `app/engine/events.ts` | Add `botId` to all event payloads |
| `app/engine/services/orchestrator.ts` | Refactor to use BotManager + Strategy interface |
| `app/engine/services/reconciliation.ts` | Filter all queries by `botId` |
| `app/execution/services/execution.ts` | Accept `botId`, write it to orders/trades |
| `packages/config/src/index.ts` | Restructure to per-bot config sections |
| `packages/db/src/schema/trading.ts` | Add `botId` column to orders, trades, positions |
| `packages/db/src/schema/signals.ts` | Add `botId` column |
| `packages/db/src/schema/calibration.ts` | Add `botId` column |
| `packages/db/src/schema/weather.ts` | Add `botId` to balance_history |
| `packages/db/src/schema/index.ts` | Export new schemas |
| `app/cli/src/app.tsx` | Add bot selector to tab bar |
| `app/cli/src/views/dashboard.tsx` | Per-bot panels + treasury view |
| `app/cli/src/views/performance.tsx` | Per-bot filtering |
| `app/cli/src/views/markets.tsx` | Per-bot filtering |
| `app/cli/src/views/logs.tsx` | Per-bot filtering |
| `app/cli/src/components/status-bar.tsx` | Multi-bot status |
| `app/viz/src/api.ts` | Add `botId` query param filtering |
| `app/viz/src/ws-bridge.ts` | Include `botId` in all messages |
| `app/viz/src/frontend/hud/overlay.ts` | Bot selector + per-bot stats |

---

## Implementation Order

### Phase 1 — Database + Strategy Interface (foundation)
1. Define `Strategy` interface and `StrategyConfig` type
2. DB migration: add `bot_id` columns, create `bot_allocations` table
3. Create `BotManager` and `BotInstance` classes
4. Extract existing climate logic into `ClimateStrategy`
5. Verify: climatebot runs identically through the new BotManager

### Phase 2 — Capital Isolation
6. Implement per-bot allocation tracking
7. Update execution to use bot allocation (not Kalshi balance) for Kelly sizing
8. Update reconciliation to credit PnL to correct bot
9. Add `allocate` and `treasury` REPL commands

### Phase 3 — TUI Multi-Bot
10. Add bot selector to tab bar (A/C/O keys)
11. Update Dashboard with per-bot panels
12. Update Performance, Markets, Logs views with bot filtering
13. Update StatusBar for multi-bot display

### Phase 4 — Oil Bot
14. Implement oil strategy (see OILBOT-PLAN.md phases 1-4)
15. Register oil bot with BotManager
16. Paper trade oil alongside live climate

### Phase 5 — Viz Multi-Bot
17. Add `botId` filtering to API endpoints
18. Add bot selector to viz HUD
19. Oil trade particles (Cushing, OK location or separate panel)

---

## Migration Risk

The main risk is the DB migration. The `positions` table PK change (from `ticker` to `(ticker, bot_id)`) requires table recreation in SQLite. Mitigation:
- Run migration with bot stopped
- Back up `data/kalshi-bot.db` before migration
- Migration is a single atomic transaction
- All existing rows get `bot_id = 'climate'` via DEFAULT — no data loss
