# Reconciliation Pipeline

**Type:** Architecture
**Last updated:** 2026-06-10

The reconciliation service (`app/engine/services/reconciliation.ts`) runs every tick as Phase 5 of the orchestrator loop. It keeps local state in sync with Kalshi and drives the self-improvement feedback loop.

## Steps (each tick, in order)

1. **syncOrders** — Poll Kalshi for open order status, create trade records for fills (live mode only).
2. **syncHistoricalOrders** — Import all orders from Kalshi into local DB (catches web-UI orders that weren't placed by the bot).
3. **ensureTradeRecords** — Create trade records for filled orders missing them.
4. **updatePositions** — Recompute positions from local trades.
5. **syncPositionsFromKalshi** — Overwrite/add positions from Kalshi API (runs even in dry-run if API key is set).
6. **syncSettlements** — Import settlement history from Kalshi into the `calibration` table (realized PnL, outcomes).
7. **checkResolutions** — Detect newly settled markets, create calibration records, recompute station bias.
8. **snapshotBalance** — Record balance + equity to `balance_history`.

## Startup

On `initOrchestrator`, steps 2, 5, 6 run once immediately so the TUI / web UI shows portfolio data before the first tick.

## Stale markets

Expired markets that never settle are auto-finalized from the local side so they don't appear as phantom positions. Detection: `close_time < now - grace` and `status != 'settled'`. See the stale-markets auto-memory entry for the full rule.

## PnL attribution

- Bot buy orders have `signal_id` set to the signal UUID.
- Bot exit sell orders have `signal_id` set to the original signal UUID or `"bot-exit"`.
- Manual orders imported from Kalshi have `signal_id = null` and are excluded from bot PnL.
- `traded` flag in `calibration` checks both `orders.signal_id IS NOT NULL` and the `trades` table as fallback.
- Formula: `PnL = settlement_payout + sell_proceeds - buy_cost`.

## Events emitted

- `order:update` per poll
- `position:update` when positions change
- `balance:update` after the snapshot
- `market:resolved` for newly-settled markets
- `calibration:updated` when a calibration record is written

See [event-bus.md](event-bus.md) for payload shapes.
