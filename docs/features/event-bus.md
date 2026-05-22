# Event Bus

Defined in `app/engine/events.ts`. The singleton `bus` is imported via `import { bus } from "@kcb/engine"`.

- The bus is fire-and-forget — do not await event handlers.
- A thrown handler must not crash the emitter.
- All engine modules should use `createLogger("module-name")` instead of `console.log` so output flows through the bus as structured log events.

## Events

| Event | Payload | Emitter |
|-------|---------|---------|
| `bot:status` | `{ running, dryRun, lastTick, tickCount, uptime, sniperHorizonHours, marketsInSniperWindow, marketsInScoutMode }` | `loop.ts` (each tick) |
| `bot:error` | `{ module, message, error? }` | Any module on error |
| `signal:new` | `{ id, ticker, side, edge, confidence, recommendation, estimatedProb, marketPrice, forecastHorizonHours?, sigmaSource?, sigmaUsed?, hrrrActive?, observationTemp? }` | Orchestrator Phase 3 — actionable signals |
| `signal:scout` | Same as `signal:new` | Orchestrator Phase 3 — scout-mode signals (outside sniper window) |
| `forecast:fetched` | `{ stationId, sources: { openMeteo, hrrr, tomorrowIo }, hrrrValue?, horizonBucket, hrrrWeight }` | Ensemble service |
| `order:placed` | `{ orderId, ticker, action, side, price, quantity, dryRun }` | `execution.ts` |
| `order:update` | `{ orderId, status, filledQuantity, ticker }` | Reconciliation |
| `position:update` | `{ ticker, side, quantity, unrealizedPnl, avgEntryPrice }` | Reconciliation |
| `balance:update` | `{ balance, totalEquity }` | Reconciliation |
| `market:discovered` | `{ ticker, eventTicker, title, category }` | Discovery |
| `market:priceUpdate` | `{ ticker, lastYesPrice, lastNoPrice }` | WebSocket feed |
| `market:resolved` | `{ ticker, result, predictedProb?, realizedPnl? }` | Reconciliation |
| `calibration:updated` | `{ ticker, predictedProb, actualOutcome, calibrationError, brierScore }` | Reconciliation |
| `log` | `{ level, module, message, data?, timestamp }` | `createLogger` (all modules) |

## Consumers

- **TUI** (`app/cli/`) — hooks in `app/cli/src/hooks/use-bot-events.ts` subscribe per view.
- **Log writer** (`app/engine/services/log-writer.ts`) — appends `log` events to `logs/bot.log`.
- **Web API** (`@kcb/api`) — forwards events over WebSocket. See [api-layer.md](api-layer.md).

## Multi-bot note

The multi-bot plan (see [`docs/research/multi-bot-plan.md`](../research/multi-bot-plan.md)) adds a `botId` field to every payload so per-strategy bots can share the bus while subscribers filter.
