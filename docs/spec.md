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

**For a chronological summary of *what the bot actually does differently over time* — estimator, sizing, execution, calibration changes — see [`algorithm-changelog.md`](algorithm-changelog.md). Update it whenever you ship an algorithm change.**

**For deferred decisions with due dates — "check this after N days/trades" items like dark-launch enablements and tuning that needs a sample — see [`follow-ups.md`](follow-ups.md). Review it at the start of every working session; record outcomes in its Log as items close.**

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
| [`improvements/market-prior-2026-05-29.md`](improvements/market-prior-2026-05-29.md) | 2026-05-29: 14-day audit shows market Brier (0.134) beats model Brier (0.143) and the 50pp+ implied-edge bucket bleeds (19% win, −$64). Adds gated `market_prior_weight` to blend market price into estimator output as a final-stage prior. |
| [`improvements/tail-gate-2026-05-29.md`](improvements/tail-gate-2026-05-29.md) | 2026-05-29: tail markets ran 11% win / −$38 over 9 trades since the May unblock. Adds gated `tail_max_entry_price` to restrict tail entries to deep-cheap (≤10¢) contracts where per-trade downside is capped. |
| [`improvements/per-station-surcharge-2026-05-29.md`](improvements/per-station-surcharge-2026-05-29.md) | 2026-05-29: 60-day per-station PnL shows 3 durable losers (KORD −36% ROI, KLAX −40%, KNYC −19%) vs 3 winners. Adds JSON-map `station_edge_surcharge` runtime knob — stacks on adaptive threshold; initial values KLAX/KORD +0.15, KNYC +0.10. |
| [`improvements/adaptive-threshold-persistence-2026-05-29.md`](improvements/adaptive-threshold-persistence-2026-05-29.md) | 2026-05-29: `adaptive_thresholds` table was empty even though the gate-adjustment logic in `getEffectiveThreshold` has been running per-signal since launch. Adds `persistAdaptiveThresholds` writer called from reconciliation — observability only, runtime decision unchanged. |
| [`improvements/multi-horizon-bias-2026-05-29.md`](improvements/multi-horizon-bias-2026-05-29.md) | 2026-05-29: `station_bias` only had horizon=1 rows because sniper-mode trading only caches same-day forecasts. Adds gated `multi_horizon_bias_max_days` runtime knob — warms ensemble cache for `today+2..today+N` and NWS-backfills actuals so multi-horizon bias entries populate over time. |
| [`improvements/win-rate-80-plan-2026-06-05.md`](improvements/win-rate-80-plan-2026-06-05.md) | 2026-06-05: deep audit of 200 paper trades shows 33.5% win rate; root cause is anti-edge contra-market NO bets (109 of 200 trades, 19.4% win, −$93). Plan to hit 80% win rate via concordance/side gates, confirmation-mode pathway, adaptive market_prior, sigma floor, and hit-rate bracket-match fix. |
| [`improvements/win-rate-80-addendum-2026-06-05.md`](improvements/win-rate-80-addendum-2026-06-05.md) | 2026-06-05 second pass: **ground truth is corrupted** — NWS-obs-derived `actual_value` disagrees with Kalshi settlement on ~70% of days, and the per-station offset correlates almost perfectly with station PnL (KNYC −1.07°F off / −$69; KDEN ±0 / +$25). Bias + empirical sigma are trained on bad actuals. Also: event probability sums run 0.79–1.69 (incoherent), bid/ask discarded in favor of last-trade price, no sniper cache invalidation (docs promised it), obs logic reinforces the corrupted mean, HRRR fails silently. 12 new action items (N1–N12), sequenced against the first plan. |

---

## Research

Strategy and market research in [`docs/research/`](research/). These are analyses and plans, not implementation guides.

| Doc | Thesis / finding |
|-----|------------------|
| [`research/market-expansion-research.md`](research/market-expansion-research.md) | Which Kalshi categories are best fit for the bot architecture. Conclusion: economics/macro releases (CPI, NFP, GDP) are the best expansion opportunity — same discovery → estimate → evaluate → execute pipeline, higher liquidity, objective settlement. |
| [`research/multi-bot-plan.md`](research/multi-bot-plan.md) | Architecture for running multiple strategies (climate + oil + future) in one process. `Strategy` interface, `BotManager`, per-bot capital isolation via `bot_allocations`, `botId` field on all events, TUI bot selector, viz/API filtering. |
| [`research/oilbot-plan.md`](research/oilbot-plan.md) | WTI intervention-thesis bot. Regime detection (floor/ceiling/corridor) using EIA SPR data, CFTC COT, futures curve anomalies, news sentiment via Claude API. Phased rollout plan. |
| [`research/no-bet-strategy-analysis.md`](research/no-bet-strategy-analysis.md) | Back-of-the-envelope: betting blind NO returns +201% over 46 days (82% structural NO rate). Skipping the market's top-1 YES pick reaches 99.5% win rate but thin 1.2% ROI. **Conclusion: the real edge is contrarian YES bets on the correct bracket when the market is wrong (6.3% of events)** — which is what the forecast-sharpening work enables. |
| [`research/polymarket-integration-scoping.md`](research/polymarket-integration-scoping.md) | 2026-06-10 effort assessment for a **paper-only** Polymarket integration. Conclusion: ~2–3 weeks for a read-only data adapter + confirmation-pathway paper trading; the weather edge does NOT transfer (Polymarket has no recurring temp-bracket markets), so ~80% of the system is Kalshi/weather-specific. Binding constraint is strategy fit, not plumbing. Phased, decision-gated path starting with a no-code market survey. |

---

## Current Implementation Status

### Fully implemented

| Area | Notes |
|------|-------|
| Bun workspace monorepo | `bun bot` (headless + API), `bun bot:tui` (with TUI), `bun --hot` dev |
| Drizzle schema + migrations | See [database-schema.md](features/database-schema.md) |
| Kalshi client (REST + WebSocket) | RSA-PSS auth, cursor pagination, gap detection |
| Engine (orchestrator, loop, reconciliation) | 5-phase tick with sniper/scout gate |
| Market discovery | High/low temp, precip, snowfall — all categories end-to-end; **temperature brackets parsed from titles with rounded-integer settlement semantics** (Finding 11, 2026-06-05) |
| Weather data | Open-Meteo (~120 members) + HRRR (`gfs_hrrr`, fixed 2026-06-05) + Tomorrow.io + NWS; per-estimate `sourceMix` attribution, 2h same-day TTL, sniper-entry cache refresh |
| Probability estimator | **Event-coherent vector** (one distribution per event, sums to 1), sigma floor, obs running-max clamp + post-peak collapse, adaptive market prior (0.3→0.7 ramp), market-agreement confidence |
| Calibration ground truth | **Settlement-truth chain: CLI exact value → settlement interval → local-day obs max**, hourly health telemetry, auto station-health gate (hysteresis) |
| Entry gates | Contra-market blocks, concordance cap (25pp), coin-flip dead zone, station health, HRRR-in-sniper, obs staleness, tail price cap, event argmax |
| Confirmation pathway | Market ≥80¢ + model agreement → take the popular side flat; own exit policy (hold to settlement, conviction-floor bail-out) |
| Execution (orders + exits) | Book-aware crossing-price entries, spread guard, honest paper fills, net-held over-sell clamp, winner-hold + confirmation exit carve-outs |
| Ink TUI | 6 views, Ctrl+R REPL, ink-chart + custom Table component |
| REST + WebSocket API | Elysia in-process, 12 REST endpoints, full bus forwarding |
| Web SPA | React 19, TanStack Router, shadcn/ui, dark-mode dense dashboard |
| Log writer | JSONL append + rotation at 10MB |

### Remaining work

| Task | Location | Notes |
|------|----------|-------|
| **Measure the new regime** | — | All win-rate-80 build items shipped 2026-06-05/06; accumulate ~30 settled trades, then judge vs the 80% target (`wins` REPL command) |
| Ultra-sniper enablement | runtime_config | Shipped dark; set `ultra_sniper_horizon_hours=4` after a few clean live days |
| Entry-hour re-cut (N12) | analysis | After ~2 weeks of new-regime data, decide if an hour gate is still needed post-obs-anchor |
| Rate-limit backoff | `packages/kalshi-client/src/client.ts` | Exponential backoff on 429 |
| Hit-rate bracket matching (plan #5) | `app/signals/services/estimator.ts` | Deprioritized — geometry fix addressed the worst of it |
| Stale-order cancellation | `app/engine/services/reconciliation.ts` | See [improvements.md](improvements/improvements.md) §4 |
| Precip/snowfall expansion | discovery + estimator | Deliberately deferred until `high_temp` proves ≥80% (audit settlement semantics first — see Finding 11 memory) |
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
