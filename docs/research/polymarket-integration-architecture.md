# Polymarket Integration — Architecture Design

**Author:** Elijah Boston
**Status:** Draft
**Last updated:** 2026-06-19

*Follow-up to [`polymarket-integration-scoping.md`](polymarket-integration-scoping.md). The scoping doc answered "is it worth it and how much effort" (paper-only, ~2–3 weeks, confirmation-pathway only). This doc answers "how do we build it" — process model, data model, and repo strategy. Scope is unchanged: **paper-trade only**, read-only market data, simulated fills.*

## Summary of decisions

| Question | Decision |
|---|---|
| One bot observing both, or two bots on one DB? | **One process, one tick loop, exchange-parameterized.** Two processes contend on the single-writer SQLite and run duplicate reconciliation/balance loops. Isolate via per-exchange try/catch, not separate processes. |
| How do data structures distinguish the venues? | **Add an `exchange` column** (default `'kalshi'`) to `markets`, `orders`, `trades`, `positions`, `signals`, `calibration`, `balance_history`. Relax three `NOT NULL` Kalshi-specific columns. Per-exchange fee function. Keep cents as the universal price unit. |
| Separate project / long-lived branch? | **Same monorepo.** New `packages/polymarket-client` beside `packages/kalshi-client`; reuse db/config/execution/reconciliation/wins. Short-lived branch for the Phase-1 adapter refactor, then build on `main` behind `polymarket.enabled=false`. |

---

## 1. Process model — one bot, not two

### The current shape

The bot is a single process with one registered tick (`app/engine/services/orchestrator.ts`). Each tick runs five phases:

1. **Discovery** — `discoverMarkets(kalshi)` → REST fetch + DB upsert + WS subscribe
2. **Estimation** — weather ensemble → YES probability (no exchange calls)
3. **Evaluation** — edge/confirmation signals from estimate vs market price (no exchange calls)
4. **Execution** — `executionService.executeSignal()` → `kalshi.createOrder()` (or simulated fill in `dry_run`)
5. **Reconciliation** — order/position/settlement sync + `balance_history` snapshot

`KalshiClient` and `KalshiFeed` are instantiated once (`orchestrator.ts:117–118`) and injected into the services. There is **no abstraction layer** today — services call the concrete client directly.

### Why one process wins

- **SQLite is single-writer.** `bun:sqlite` serializes writes; two processes both writing `markets`, `orders`, `positions`, and especially `balance_history` would produce lock contention and interleaved balance accounting. The paper-balance computation (`reconciliation.ts:1811–1851`) reads the whole position/calibration set and writes a snapshot — running it twice concurrently corrupts the equity curve.
- **The 5-phase loop is already the seam.** Only phases 1, 4, 5 touch an exchange. Phases 2–3 are weather-specific and simply **don't run for Polymarket** — there's no estimator, so the only play is the market-following *confirmation pathway*, which keys off market price alone.
- **No duplicate plumbing.** One config refresh, one feed-reconnect policy, one reconciliation cadence.

### Proposed structure — an exchange registry

Generalize the orchestrator from "the Kalshi client" to "a list of exchanges," each bundling its adapter, feed, discovery function, and pipeline mode:

```ts
interface Exchange {
  id: "kalshi" | "polymarket";
  adapter: ExchangeReadAdapter;   // read-only market data (both venues)
  feed: ExchangeFeed;             // live price WS (both venues)
  discover(): Promise<Market[]>;  // venue-specific discovery
  hasEstimator: boolean;          // kalshi: true, polymarket: false
  strategyMode: "full" | "confirmation_only";
}
```

Tick loop becomes:

```ts
for (const ex of exchanges) {
  try {
    const markets = await ex.discover();                  // phase 1
    if (ex.hasEstimator) await estimate(markets);          // phase 2 — kalshi only
    const signals = await evaluate(markets, ex.strategyMode); // phase 3
    await execute(signals, ex);                            // phase 4 (forced dry for poly)
  } catch (err) {
    log.error(`exchange ${ex.id} tick failed`, err);       // isolation: poly failure
  }                                                        // never kills the kalshi path
}
await reconcile(exchanges);                                // phase 5, per-exchange
```

**Fault isolation without separate processes:** wrapping each exchange's phase block in try/catch gives the main benefit people reach for two-process designs to get — a Polymarket adapter crash must never take down the money-making Kalshi path — while keeping one DB writer.

### The `ExchangeReadAdapter` interface

Paper-only means the Polymarket adapter needs **no order/auth surface** — execution is simulated. The shared interface is the *read* subset of `KalshiClient`:

```ts
interface ExchangeReadAdapter {
  getAllMarkets(params?): Promise<Market[]>;   // Gamma REST (poly) / markets REST (kalshi)
  getMarket(id): Promise<Market>;
  getOrderBook(id): Promise<{ yesBid; yesAsk }>; // CLOB REST (poly) / book REST (kalshi)
  // settlement/resolution read for reconciliation
  getResolution(id): Promise<"yes" | "no" | null>;
}
```

`KalshiClient`'s existing read methods (`getAllMarkets`, `getMarket`, `getBalance`, `getPositions`, `getSettlements`) are made to conform; its write methods (`createOrder`, `cancelOrder`) stay on the concrete `KalshiClient` only and are reached solely by live-mode Kalshi execution. `PolymarketClient` implements only the read interface.

**Execution split:** the existing `dry_run` path (`execution.ts:612–646`) already simulates fills at the crossing price and writes `balance_history`. Polymarket markets are **always** `dryRun=true` (enforced by `config.polymarket.dryRun`, which cannot be set false in this scope), so they ride the existing simulated-fill code with no new execution engine. The one change execution needs is a **per-exchange fee function** (see §2).

**Reconciliation split:** Polymarket has no live orders/positions to sync. Its reconciliation is a strict subset — resolve settled markets via `adapter.getResolution()` (UMA oracle outcome surfaced through Gamma), write `markets.result`, realize paper P&L into the calibration/balance path. No `getOrders`/`cancelOrder`/`getPositions` calls.

---

## 2. Data model — distinguishing the venues

### Add an `exchange` discriminator

Add `exchange TEXT NOT NULL DEFAULT 'kalshi'` to: **`markets`, `orders`, `trades`, `positions`, `signals`, `calibration`, `balance_history`.** The default backfills every existing row to `'kalshi'` with no data migration.

- `markets`/`orders`/`positions` — partitions the two catalogs and ledgers.
- `signals`/`calibration` — lets us measure *Polymarket price efficiency* separately (this is literally what the Phase-3 experiment in the scoping doc tests: "is Polymarket calibrated enough that following ≥80¢ conviction profits?").
- `balance_history` — **each venue needs its own paper equity curve.** Today this table is keyed only by `dryRun`; balance reconciliation and the `wins` command must group by `(exchange, dryRun)`.

### Relax the Kalshi-only NOT NULL columns

`markets` has three `NOT NULL` columns a Polymarket binary can't fill (`markets.ts:11,13,17`):

- `eventTicker` — Polymarket has no event/series hierarchy
- `seriesTicker` — same
- `category` — no weather category

These must be made **nullable** (a column-rebuild migration in SQLite). The already-nullable columns (`stationId`, `targetDate`, `bracketLow`, `bracketHigh`) are simply left null for Polymarket. `marketType` gains a new value **`'binary'`** (single YES/NO, no bracket partition, event-coherence skipped). `weather_forecasts` and `station_bias` stay **Kalshi-only and untouched** — Polymarket never writes them.

### Identity / primary keys

`markets.ticker` and `positions.ticker` are the PKs. Polymarket identifiers are `condition_id` / per-outcome `token_id` (`0x…` hex), which **cannot collide** with Kalshi's `KX…`-prefixed format. So the pragmatic path is: **keep `ticker` as PK**, store the Polymarket `condition_id` (or `pm:<condition_id>`) there, and rely on natural-format disjointness for uniqueness; `exchange` is for filtering/reporting, not identity.

> Defense-in-depth alternative, only if we ever distrust disjointness: composite PK `(exchange, ticker)` on `markets`/`positions`. Larger migration (touches every FK reference); **not recommended for the paper phase.**

### Price and fee units

- **Price:** Polymarket prices are `0–1` floats. Multiply by 100 → store as **cents (0–100 integer)**, identical to Kalshi. All existing cents-based sizing, fill, and P&L math flows through unchanged.
- **Fees — this is the one place the math genuinely differs.** The `wins`/P&L path applies Kalshi's `takerFeeCents = ceil(7·qty·price·(100−price)/10000)` (`shared/types/index.ts`). Polymarket's fee model is different (effectively ~0 trading fee; cost is gas, irrelevant to paper). Applying the Kalshi fee to Polymarket fills would understate paper P&L. **Make the fee a per-exchange function** (`feeCents(exchange, price, qty)`) and use it everywhere the Kalshi formula is hardcoded — at minimum `wins.ts:126–128` and the execution fill path.

### Config

Add a read-only `polymarket` block beside `kalshi`:

```ts
polymarket: {
  enabled: boolean;        // default false — gates all discovery/eval/execution
  dryRun: true;            // forced; real-money is out of scope
  gammaBaseUrl: string;    // market metadata + resolution
  clobBaseUrl: string;     // order books / prices
}
```

### Migration plan (Drizzle, numbered SQL — next is `0007`)

1. `0007_add_exchange_column.sql` — add `exchange` (default `'kalshi'`) to the seven tables above; add indexes on `(exchange)` / `(exchange, dryRun)` where queried.
2. `0008_relax_kalshi_market_columns.sql` — rebuild `markets` making `event_ticker`, `series_ticker`, `category` nullable; allow `market_type='binary'`.

Both are additive/relaxing and safe to apply to the live DB.

---

## 3. Repo strategy — monorepo, feature-flagged on `main`

### Same monorepo, new package

This is a Bun workspace (`packages/*`, `app/*`). Polymarket fits as **`packages/polymarket-client`** mirroring `packages/kalshi-client`'s *read* surface and dropping `auth.ts`/`createOrder`. The whole value of paper integration is **reuse**:

- `packages/db` — same schema + the `exchange` discriminator
- `packages/config` — one config surface
- the `dry_run` execution engine + `balance_history` path
- the calibration/Brier loop in `reconciliation.ts`
- the `wins` command (grouped by `exchange`)

A **separate project would fork all of that** and diverge within weeks — and the very question Phase 3 answers (Polymarket calibration vs Kalshi) requires both venues' paper trades to live in **one DB, queried by one `wins` command.**

### Branching — short refactor branch, then flagged on main

The bot trades and commits **daily** (see git log); a long-lived feature branch would drift hard against `main`. Recommended sequence:

1. **Branch `feat/exchange-adapter` — Phase 1 only.** Extract `ExchangeReadAdapter`, make `KalshiClient` conform, thread the interface through orchestrator/execution/reconciliation/discovery. This is a **behavior-preserving refactor** — fully covered by existing tests (services already accept an injected client in their constructors, so mocking the interface is a small change). Merge fast.
2. **Everything after, on `main`, behind `polymarket.enabled=false`.** Discovery branch, schema migrations, confirmation-only evaluation, simulated execution — all gated by the flag (default off). Half-built Polymarket code can never touch the live Kalshi path, and each step ships as a green commit per the workflow rules.

A separate process/project becomes justifiable **only** if real-money Polymarket is later pursued — wallet, EIP-712 signing, Polygon/USDC, and the U.S.-person regulatory boundary are a genuinely different runtime. That is explicitly out of scope here and is the Phase-4 decision gate in the scoping doc.

---

## Open questions before implementation

1. **Confirmation-pathway transfer.** The Kalshi confirmation block lives in `entry-gates.ts` + the orchestrator. Is its logic clean enough to run venue-agnostically on a binary market (price-only, no bracket/event-coherence inputs), or does it need a `confirmation_only` variant? Worth a focused read before Phase 3.
2. **Polymarket resolution read.** Confirm Gamma exposes resolved outcomes in a form mappable to `'yes'/'no'` for reconciliation, and the latency between UMA resolution and Gamma reflecting it.
3. **WS shape.** Polymarket's CLOB WS price feed vs `KalshiFeed`'s ticker/lifecycle events — does it fit the `on({onTicker, onLifecycle, …})` callback shape, or does the feed interface need widening?

These are Phase-0/Phase-1 questions; none block the process/data/repo decisions above.
