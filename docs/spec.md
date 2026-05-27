# SPEC.md — Kalshi Climate Bot

A trading agent for Kalshi's climate prediction markets. This document is the top-level map of the project — use it to navigate to the topic you need. Deep dives live in [`docs/features/`](features/), [`docs/improvements/`](improvements/), and [`docs/research/`](research/).

**Stack:** Bun, TypeScript, Ink (React), Drizzle ORM, SQLite, Elysia (web API), Vite + React 19 + TanStack Router + shadcn/ui (web UI).

---

## Overview

The bot discovers Kalshi climate markets, fetches weather ensemble forecasts, estimates bracket probabilities with station-specific bias corrections, and executes trades when edge exceeds adaptive thresholds. It continuously improves by recording predicted vs actual outcomes and adjusting its models (see [`features/self-improvement.md`](features/self-improvement.md)).

Single process, two UIs:
- **Ink TUI** shares memory with the engine and subscribes to a typed `EventEmitter` bus.
- **Web UI** (separate Vite SPA) consumes an in-process Elysia REST + WebSocket layer over `http://localhost:3100`.

SQLite (via Drizzle ORM) is the sole persistence layer. No WebSocket-to-browser contention — the API bridge forwards bus events.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  UIs                                                                 │
│  ┌──────────────────────┐        ┌──────────────────────────────┐    │
│  │  Ink TUI (@kcb/cli)  │        │  Vite SPA (app/web)          │    │
│  │  - Dashboard, Mkts,  │        │  - Single dense page         │    │
│  │    Logs, Activity,   │        │  - REST + WS over :3100      │    │
│  │    Performance, REPL │        │                              │    │
│  └──────────┬───────────┘        └──────────────┬───────────────┘    │
│             │ bus.on(...)                        │ HTTP / WS          │
├─────────────┼────────────────────────────────────┼───────────────────┤
│         TypedEmitter (bus)   ◄───────────►  Elysia API (@kcb/api)   │
├─────────────┼────────────────────────────────────┼───────────────────┤
│  Engine (@kcb/engine) — Headless bot logic                           │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  Orchestrator (tick loop)                                  │      │
│  │  Phase 1: Discovery    → @kcb/kalshi-client                │      │
│  │  Phase 2: Estimation   → @kcb/data + @kcb/signals          │      │
│  │  Phase 3: Evaluation   → @kcb/signals (sniper/scout gate)  │      │
│  │  Phase 3.5: Exit check → @kcb/execution                     │      │
│  │  Phase 4: Execution    → @kcb/execution                    │      │
│  │  Phase 5: Reconcile    → sync + calibration + bias          │      │
│  └────────────────────────────────────────────────────────────┘      │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite (@kcb/db — Drizzle ORM)                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Key design decisions

- **Shared-memory engine + TUI, in-process web API.** No separate services, no duplicated DB connection pools.
- **Commands are just functions.** The REPL parses input, matches a handler, and calls it. Commands query SQLite directly. See [`features/repl-commands.md`](features/repl-commands.md).
- **SQLite is the integration point.** Engine writes, UIs read. For real-time events, the bus handles it.
- **All monetary values in cents.** Probabilities are 0-1 floats.
- **All timestamps are ISO 8601 strings.** SQLite has no native datetime; ISO strings sort lexicographically.

---

## Workspace Structure

Bun workspaces monorepo. Packages reference each other via `"workspace:*"`.

```
kalshi-climate-bot/
├── app/
│   ├── cli/            # @kcb/cli — Ink TUI (views, commands, hooks)
│   ├── engine/         # @kcb/engine — tick loop, orchestrator, reconciliation, bus
│   ├── data/           # @kcb/data — NWS, Open-Meteo, HRRR, Tomorrow.io
│   ├── signals/        # @kcb/signals — ProbabilityEstimator, adaptive thresholds
│   ├── execution/      # @kcb/execution — Kelly sizing, order placement
│   ├── api/            # @kcb/api — Elysia REST + WebSocket server
│   ├── viz/            # @kcb/viz — (legacy) 3D globe mission-control UI
│   └── web/            # Vite SPA consuming @kcb/api
├── packages/
│   ├── db/             # @kcb/db — Drizzle schema + migrations + client
│   ├── kalshi-client/  # @kcb/kalshi-client — REST + WS wrapper with RSA-PSS auth
│   └── config/         # @kcb/config — typed config merging env + runtime_config
├── shared/             # Common types and helpers
├── docs/               # ← you are here
├── data/               # SQLite DB files (gitignored)
└── logs/               # Log files (gitignored)
```

Dependency direction: `cli / web → engine → signals / data / execution → db / config / kalshi-client`. Never import upward.

---

## Feature Docs

Drill into any subsystem here. Each doc is self-contained.

### Core reference

| Topic | Doc |
|-------|-----|
| Database schema (11 tables, conventions, PnL attribution) | [`features/database-schema.md`](features/database-schema.md) |
| Event bus (14 events, consumers, multi-bot note) | [`features/event-bus.md`](features/event-bus.md) |
| External APIs (Kalshi, NWS, Open-Meteo, HRRR, Tomorrow.io) | [`features/external-apis.md`](features/external-apis.md) |
| Configuration (env vars, defaults, REPL-mutable keys) | [`features/configuration.md`](features/configuration.md) |
| Reconciliation pipeline (per-tick sync steps + PnL rules) | [`features/reconciliation.md`](features/reconciliation.md) |
| Self-improvement loop (bias, empirical sigma, adaptive thresholds, confidence, sniper) | [`features/self-improvement.md`](features/self-improvement.md) |

### User surfaces

| Surface | Doc |
|---------|-----|
| REPL commands (bot, markets, positions, config, calibration, explain, backtest) | [`features/repl-commands.md`](features/repl-commands.md) |
| Elysia REST + WebSocket API layer | [`features/api-layer.md`](features/api-layer.md) |
| Vite SPA dashboard (single dense page, Tailwind + shadcn + Recharts) | [`features/web-ui.md`](features/web-ui.md) |

---

## Improvements

Ranked backlog and completed upgrade plans live in [`docs/improvements/`](improvements/). Read these first when working on accuracy, performance, or UI polish.

| Doc | What's inside |
|-----|---------------|
| [`improvements/forecast-sharpening.md`](improvements/forecast-sharpening.md) | Five changes to close the gap with top bots — **all done**: HRRR ingestion, sniper mode, empirical sigma, same-day observations, horizon-weighted model blending. Includes Monte Carlo ROI simulations. |
| [`improvements/ui-forecast-sharpening.md`](improvements/ui-forecast-sharpening.md) | 12 UI updates surfacing the forecast-sharpening work (sniper badge, hours-to-close, sigma source, observation adjustments, HRRR status, accuracy tracking, ink-chart + ink-table migrations) — **all done**. |
| [`improvements/improvements.md`](improvements/improvements.md) | Ranked feature backlog: multi-model blending (done), distribution fitting (done), historical hit-rate prior, stale-order cancellation, per-category bias, position exit logic. |
| [`improvements/post-sharpening-regression.md`](improvements/post-sharpening-regression.md) | 2026-04-22 diagnostic: post-sharpening "regression" is mostly sample noise; real issue is systemic NO overconfidence (pred<10% bets hit YES 34% of the time) and a dead self-improvement loop (station_bias empty, historicalHitRate computed but never blended). Adds gated `historical_prior_weight` fix. |
| [`improvements/bun-improvements.md`](improvements/bun-improvements.md) | Bun API migration checklist (UUIDv7, strict SQLite, `bun build --compile`, `Bun.nanoseconds`, `using`, typed `Bun.env`) — **all done**. |
| [`improvements/conviction-sizing.md`](improvements/conviction-sizing.md) | 2026-04-23: shift from Kelly-as-sizer to flat $5 bets behind a strict edge+confidence gate; activate historical-prior blend. Includes the post-funding knob list. |
| [`improvements/confidence-tier-sizing.md`](improvements/confidence-tier-sizing.md) | 2026-05-23: scale flat bets to $10 on signals with `confidence ≥ 0.95` — data shows that bucket is 56% win / +$8.4k while 0.90–0.95 is 32% / –$5.6k, so only the top band tiers up. |
| [`improvements/calibration-deep-dive-2026-05.md`](improvements/calibration-deep-dive-2026-05.md) | 2026-05-26: two compounding estimator bugs explained the post-restart NO bleed — historicalHitRate ignored bracket arguments (pulled toward wrong baseline) and CDF/counting blend was inverted (crushed the correct CDF estimate). Both fixed. |
| [`improvements/execution-unblock-2026-05-26.md`](improvements/execution-unblock-2026-05-26.md) | 2026-05-26: audit found 99% of actionable signals (incl. 100% of tails) being silently dropped. Bypassed `minContractPrice` for high-conf signals, disabled profit reserve in dry_run, and propagated specific skip reasons to `signals.skip_reason` for future debuggability. |
| [`improvements/sigma-cap-prior-bump-2026-05-27.md`](improvements/sigma-cap-prior-bump-2026-05-27.md) | 2026-05-27: overnight validation showed estimator still ~57pp off on tight near-mean brackets despite yesterday's fixes. Capped `empiricalSigmaWeight` at 0.7 to keep ensemble spread in the blend, and raised `historical_prior_weight` to 0.5 now that the bracket-filtered prior is trustworthy. |

---

## Research

Strategy and market research in [`docs/research/`](research/). These are analyses and plans, not implementation guides.

| Doc | Thesis / finding |
|-----|------------------|
| [`research/market-expansion-research.md`](research/market-expansion-research.md) | Which Kalshi categories are best fit for the bot architecture. Conclusion: economics/macro releases (CPI, NFP, GDP) are the best expansion opportunity — same discovery → estimate → evaluate → execute pipeline, higher liquidity, objective settlement. |
| [`research/multi-bot-plan.md`](research/multi-bot-plan.md) | Architecture for running multiple strategies (climate + oil + future) in one process. `Strategy` interface, `BotManager`, per-bot capital isolation via `bot_allocations`, `botId` field on all events, TUI bot selector, viz/API filtering. |
| [`research/oilbot-plan.md`](research/oilbot-plan.md) | WTI intervention-thesis bot. Regime detection (floor/ceiling/corridor) using EIA SPR data, CFTC COT, futures curve anomalies, news sentiment via Claude API. Phased rollout plan. |
| [`research/no-bet-strategy-analysis.md`](research/no-bet-strategy-analysis.md) | Back-of-the-envelope: betting blind NO returns +201% over 46 days (82% structural NO rate). Skipping the market's top-1 YES pick reaches 99.5% win rate but thin 1.2% ROI. **Conclusion: the real edge is contrarian YES bets on the correct bracket when the market is wrong (6.3% of events)** — which is what the forecast-sharpening work enables. |

---

## Current Implementation Status

### Fully implemented

| Area | Notes |
|------|-------|
| Bun workspace monorepo | `bun bot` (headless + API), `bun bot:tui` (with TUI), `bun --hot` dev |
| Drizzle schema + migrations | See [database-schema.md](features/database-schema.md) |
| Kalshi client (REST + WebSocket) | RSA-PSS auth, cursor pagination, gap detection |
| Engine (orchestrator, loop, reconciliation) | 5-phase tick with sniper/scout gate |
| Market discovery | High/low temp, precip, snowfall — all categories end-to-end |
| Weather data | Open-Meteo (primary ~120 members) + HRRR + Tomorrow.io + NWS synthetic fallback |
| Probability estimator | Multi-model ensemble, distribution fitting, empirical sigma, same-day obs, horizon-weighted blending |
| Adaptive thresholds + station bias | Per-bucket edge, rolling bias per (station, horizon) |
| Execution (Kelly + orders + exit) | Stop-loss, edge-reversal exits, churn guards, exposure caps |
| Ink TUI | 6 views, Ctrl+R REPL, ink-chart + custom Table component |
| REST + WebSocket API | Elysia in-process, 12 REST endpoints, full bus forwarding |
| Web SPA | React 19, TanStack Router, shadcn/ui, dark-mode dense dashboard |
| Log writer | JSONL append + rotation at 10MB |

### Remaining work

| Task | Location | Notes |
|------|----------|-------|
| Rate-limit backoff | `packages/kalshi-client/src/client.ts` | Exponential backoff on 429 |
| Historical hit-rate prior | `app/signals/services/estimator.ts` | See [improvements.md](improvements/improvements.md) §3 |
| Stale-order cancellation | `app/engine/services/reconciliation.ts` | See [improvements.md](improvements/improvements.md) §4 |
| Per-category bias | `calibration.ts` schema + `recomputeStationBias` | See [improvements.md](improvements/improvements.md) §5 |
| Multi-bot refactor | See [multi-bot-plan.md](research/multi-bot-plan.md) | Prerequisite for oilbot |

---

## Important Implementation Notes

1. **Always use `createLogger("module-name")` instead of `console.log`.** The TUI captures stdout; raw console output corrupts the display.
2. **All DB operations are synchronous-feeling.** Bun's SQLite driver is sync under the hood; Drizzle wraps in async. Single file, no pooling.
3. **UUIDs:** `Bun.randomUUIDv7()` via the `uuid()` shared helper (time-sortable — better SQLite B-tree locality).
4. **Timestamps:** `new Date().toISOString()` via the `now()` shared helper.
5. **The bus is fire-and-forget.** Don't await handlers. A thrown handler must not crash the emitter.
6. **Kalshi auth is RSA-PSS**, not HMAC. Each request is signed per-call in `auth.ts` — no token refresh. 401 errors → check API key + private key in `.env`.
7. **NWS requires a User-Agent header.** Already set in `NwsService`.
8. **Open-Meteo returns Celsius.** Convert with `cToF()` before storing or comparing to Kalshi brackets (°F).
9. **Market prices on Kalshi are cents** (0-99 for limit, 0-100 for last). Estimator works in 0-1 probability space: `marketPrice = lastYesPrice / 100`.
10. **`signals.reasoning` is a JSON string** of the `ReasoningTrace` interface from `estimator.ts`. `JSON.stringify` on write, `JSON.parse` on read (used by `explain`).
11. **Drizzle migrations:** `bun run db:generate` to create SQL from schema, `bun run db:migrate` to apply.
12. **Dependency direction:** `cli / web → engine → signals / data / execution → db / config / kalshi-client`. Never import upward.
13. **Testing:** use real in-memory DB with `runMigrations()` + seed data. Never `mock.module()` on `@kcb/db`, `@kcb/engine`, or `@kcb/kalshi-client` — `mock.module` leaks across test files in Bun. Only `@kcb/config` is safe to mock. Use constructor DI with `stubKalshi` instead.
14. **Tests before commits, push after green.** See `CLAUDE.md`.
