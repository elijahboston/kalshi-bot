# Web UI — Single-Page Dashboard

## Context

The bot now exposes its state through a REST + WebSocket API (`docs/features/api-layer.md`). This spec describes the web UI that consumes that API. The goal is to **replace the multi-tab TUI with a single dense page** that shows everything at once — similar to a trading terminal, where the operator can see positions, signals, pipeline status, markets, performance, and logs without navigating.

The UI is a separate process that runs alongside the bot and talks to it over HTTP/WS at `http://localhost:3100`.

---

## What the TUI currently shows (and must be preserved)

| TUI Surface | Data |
|-------------|------|
| **Status Bar** | Running/stopped indicator, dry-run flag, sniper/scout mode, cash, portfolio, tick count, countdown to next tick |
| **Dashboard** | Sniper countdown (next markets entering window), open positions, recent signals (with scout tag), recent orders, last error |
| **Markets** | Active markets table: ticker, close-in, status, price, our probability, market probability, edge, confidence, sigma source |
| **Activity** | Pipeline phase indicator (Discovery → Estimation → Evaluation → Execution → Reconciliation), per-tick summary, live event feed |
| **Logs** | Scrollable log stream with level/module filtering |
| **Performance** | Stats row (cash, portfolio, unrealized/realized PnL, win rate, Brier score, order count, position count), windowed win rates (24h/48h/7d), equity curve, calibration buckets, daily P&L, recent resolutions, forecast accuracy, order history |

The web UI combines all of this into a **single page** — no tabs, no navigation, everything visible simultaneously with scroll.

---

## Layout

Target: desktop-first (1440px+), dense information display. Collapses to 2-column on ~1024px and single-column on mobile.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ STATUS BAR: [● RUNNING] [DRY-RUN] [SNIPER 12h] Cash: $75.94 Port: $75.94     │
│                        Ticks: 2176 | Next: 3m24s | 2026-04-16 18:32 EDT       │
├────────────────────────────────────────────────────────────────────────────────┤
│ KPI ROW (6 cards)                                                             │
│ [Cash] [Portfolio] [Unrealized] [Realized] [Win Rate] [Brier]                 │
│ Pills: [24h: 100% (1/1)] [48h: 100%] [7d: 100%]                               │
├────────────────────────────────────────────────────────────────────────────────┤
│ MAIN GRID — 12 col, ~3 row heights                                            │
│                                                                                │
│ ┌─────────── col 1-8 ──────────────┐ ┌─────── col 9-12 ────────┐              │
│ │ Equity Curve (line chart)         │ │ Pipeline Status          │              │
│ │                                   │ │ [Discovery]→[Estim]→...  │              │
│ │                                   │ │                           │              │
│ ├───────────────────────────────────┤ ├───────────────────────────┤              │
│ │ Daily P&L (bar chart)             │ │ Sniper Countdown          │              │
│ │                                   │ │ • KXHIGHNY-...  in 2h    │              │
│ │                                   │ │ • KXLOWCHI-...  in 4h    │              │
│ ├───────────────────────────────────┤ │                           │              │
│ │ Active Markets (table)            │ ├───────────────────────────┤              │
│ │ ticker | close | price | our P |  │ │ Live Event Feed           │              │
│ │ mkt P | edge | conf | σ          │ │ 18:32:01 Signal KXHIGH...  │              │
│ │                                   │ │ 18:31:45 Order BUY YES... │              │
│ │                                   │ │ 18:31:30 Discovered...    │              │
│ ├───────────────────────────────────┤ │                           │              │
│ │ Open Positions (table)            │ │                           │              │
│ │ ticker | side | qty | avg | P&L  │ │                           │              │
│ ├───────────────────────────────────┤ ├───────────────────────────┤              │
│ │ Recent Signals (table)            │ │ Logs                      │              │
│ │ ticker | side | edge | conf |     │ │ [filter: level / module]  │              │
│ │ recommendation | time             │ │ 18:32:01 INFO [orch]...   │              │
│ │                                   │ │ 18:31:58 DEBUG [feed]...  │              │
│ ├───────────────────────────────────┤ │                           │              │
│ │ Recent Resolutions (table)        │ │                           │              │
│ │ ticker | pred | actual | edge |   │ │                           │              │
│ │ pnl                                │ │                           │              │
│ ├───────────────────────────────────┤ │                           │              │
│ │ Calibration Buckets (chart)       │ │                           │              │
│ │ bucket | predicted | actual rate  │ │                           │              │
│ ├───────────────────────────────────┤ │                           │              │
│ │ Order History (table)             │ │                           │              │
│ │ time | ticker | side | qty |      │ │                           │              │
│ │ price | status | kelly | dry      │ │                           │              │
│ └───────────────────────────────────┘ └───────────────────────────┘              │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Design principles

- **Dense, information-first** — no hero sections, no marketing copy. Every pixel serves data.
- **Dark mode by default** — trader aesthetic. Use Tailwind's `slate`/`zinc` neutrals.
- **Color semantics** — `green` for positive PnL / running / actionable; `red` for negative PnL / errors / stopped; `yellow` for dry-run / scout / warnings; `cyan` for neutral labels; `gray` for muted metadata.
- **Monospace fonts for numbers** — tabular alignment (`font-mono`) in tables and KPI cards.
- **Real-time visual feedback** — highlight rows briefly (~1s flash) when WebSocket events update them.
- **No page reloads** — all updates flow through WebSocket.

---

## Component → API mapping

All endpoints are on `http://localhost:3100`. WebSocket is `ws://localhost:3100/ws`.

| Component | Initial fetch (REST) | Live updates (WS event) |
|-----------|----------------------|-------------------------|
| **Status Bar** | `GET /api/status`, `GET /api/balance`, `GET /api/config` | `bot:status`, `balance:update` |
| **KPI Row** | `GET /api/performance`, `GET /api/performance/win-rates` | `balance:update`, `market:resolved` |
| **Equity Curve** | `GET /api/balance/history?limit=200&span=30d` (default; user toggle 7D/30D/All re-fetches with new `span`) | `balance:update` (refetch with current `span`) |
| **Weekly Win-Rate Heatmap** | `GET /api/performance/daily-win-rates?days=84` | `market:resolved` (refetch) |
| **Daily P&L** | `GET /api/performance/daily-pnl?days=14` | `market:resolved` (refetch) |
| **Active Markets** | `GET /api/markets?status=open&limit=50` | `market:discovered`, `market:priceUpdate`, `signal:new` (merge edge/conf/estimate into row) |
| **Open Positions** | `GET /api/positions` | `position:update` |
| **Recent Signals** | `GET /api/signals?limit=20` | `signal:new`, `signal:scout` |
| **Recent Resolutions** | `GET /api/performance/resolutions?limit=10` | `market:resolved` |
| **Calibration Buckets** | `GET /api/performance/calibration` | `calibration:updated` |
| **Order History** | `GET /api/orders?limit=50` | `order:placed`, `order:update` |
| **Pipeline Status** | — (derived from event stream) | `log` (infer phase from `module` field: `discovery`, `estimation`, `evaluation`, `execution`, `reconciliation`) |
| **Sniper Countdown** | `GET /api/markets?status=open` + `GET /api/config` (for `sniperHorizonHours`) | `market:discovered`, `bot:status` (refetch) |
| **Live Event Feed** | — | all events (keep last 50) |
| **Logs** | `GET /api/logs?limit=100` | `log` (append, keep last 500 client-side) |

### WebSocket message format

```jsonc
// On connect
{ "type": "snapshot", "data": { "status": {...}, "positions": [...], "balance": {...} } }

// Live events — one of 14 types, see docs/features/api-layer.md
{ "type": "signal:new", "data": { "id": "...", "ticker": "...", "edge": 0.12, ... } }
{ "type": "balance:update", "data": { "cash": 7594, "portfolio": 7594 } }
{ "type": "log", "data": { "level": "info", "module": "...", "message": "...", "timestamp": "..." } }
```

Money values are **cents** (integers). Divide by 100 for display. Probabilities are 0–1 floats.

---

## Tech stack

- **Vite** — build tool and dev server (NOT Next.js). Client-side only; the app is a pure SPA.
- **TanStack Router** — file-based or code-based router. Even though the UI is a single page today, set up the router scaffolding so future views (per-market drill-in, historical backtest viewer) slot in cleanly.
- **Tailwind CSS 4** — utility styling
- **shadcn/ui** — component library. Use `Card`, `Table`, `Badge`, `Input`, `Select`, `Button`, `ScrollArea`, `Separator`, `Tooltip`. Install via `npx shadcn@latest init` and add components as needed.
- **Recharts** — line chart (equity), bar chart (daily P&L), horizontal bar chart (calibration)
- **lucide-react** — icons
- Native `WebSocket` API — no library needed

Create a single `ApiClient` hook (`useApi`) that manages:
- initial REST fetches
- WebSocket connection + reconnect with backoff
- typed event routing to setState updates

---

## v0 Prompt

Paste the following prompt into v0 to generate the frontend boilerplate:

---

> Build a single-page trading bot dashboard as a **Vite React SPA** (NOT Next.js). Use **TanStack Router** for routing scaffolding (even though there's one page today, set up `createRouter` with a root route and an `/` index route so future views can be added easily). Styling is **Tailwind CSS**, components are **shadcn/ui** (install via `npx shadcn@latest init`, pull in `Card`, `Table`, `Badge`, `Input`, `Select`, `Button`, `ScrollArea`, `Separator`, `Tooltip`). Charts are **Recharts**. Icons are **lucide-react**. It consumes a REST + WebSocket API at `http://localhost:3100` (REST) and `ws://localhost:3100/ws` (WebSocket). Dark mode by default, dense information display, monospace numbers, trader aesthetic. Everything on one scrollable page.
>
> **Layout** (desktop-first, 1440px+):
>
> 1. **Sticky top status bar** with: running indicator dot (green/red), dry-run badge (yellow when true), sniper/scout mode badge, cash, portfolio, tick count, countdown to next tick, current time.
>
> 2. **KPI row** — 6 cards in a grid: Cash, Portfolio, Unrealized PnL, Realized PnL, Win Rate, Brier Score. Below the cards, 3 pills showing windowed win rates (24h / 48h / 7d) with `wins/total` underneath.
>
> 3. **Main 12-column grid**:
>    - **Left (cols 1–8)** stacked cards:
>      - Equity curve (Recharts line chart, last 200 points)
>      - Daily P&L (Recharts bar chart, last 14 days, green/red bars by sign)
>      - Active Markets table: ticker, close-in, status, price, our probability, market probability, edge, confidence, sigma source. Color edge column green (>8¢) / yellow (>0) / red. Highlight rows briefly when they update.
>      - Open Positions table: ticker, side (YES/NO badge), quantity, avg entry, unrealized PnL (colored).
>      - Recent Signals table: ticker, side, edge, confidence, recommendation (badge: BUY_YES / BUY_NO / SCOUT / SKIP), timestamp.
>      - Recent Resolutions table: ticker, predicted %, actual (YES/NO badge), edge, realized PnL (colored).
>      - Calibration Buckets: horizontal bar chart — for each bucket (0.0–0.1, 0.1–0.2, …, 0.7–1.0) show predicted vs actual rate side by side.
>      - Order History table: time, ticker, side, qty, price (¢), status (filled/open/canceled badge), kelly fraction, dry-run flag.
>    - **Right (cols 9–12)** stacked cards:
>      - Pipeline Status: horizontal flow showing 5 phases — Discovery → Estimation → Evaluation → Execution → Reconciliation. Highlight the active phase in green based on the most recent `log` event's `module` field.
>      - Sniper Countdown: list of markets sorted by time-to-sniper-window-entry, showing ticker and "in 2h" / "NOW" label.
>      - Live Event Feed: vertically scrolling list of the last 50 events, each with timestamp, type badge, and short summary. Event types: `signal:new` (green), `signal:scout` (yellow), `order:placed` (green/yellow), `order:update`, `market:discovered` (cyan), `market:resolved` (green/red by PnL), `balance:update`, `bot:error` (red).
>      - Logs: last 100 log entries. A `<Select>` above for level filter (all/debug/info/warn/error) and an `<Input>` for module filter. Each entry: timestamp, level badge, module in brackets, message.
>
> **Data layer**:
>
> Create a `useApi` hook (`lib/use-api.ts`) that:
> - On mount, fires parallel REST fetches to populate initial state
> - Opens a WebSocket; on message, routes by `type` to update state
> - Reconnects with exponential backoff (1s → 30s cap) on disconnect
> - Exposes typed state: `{ status, balance, positions, signals, orders, markets, resolutions, performance, winRates, dailyPnl, calibration, logs, events, equityHistory, config }`
>
> REST endpoints to fetch on mount:
> - `GET /api/status` → bot state
> - `GET /api/config` → bot config (for sniper horizon)
> - `GET /api/balance` → current cash/portfolio
> - `GET /api/balance/history?limit=200&span=30d` → equity points `[{ totalEquity, balance, recordedAt }]`. `span` accepts `7d`, `30d`, or `all`; omitted = all. Default view = 30D, with in-UI toggle for 7D/30D/All. Selection is not persisted across reloads.
> - `GET /api/positions` → `[{ ticker, side, quantity, avgEntryPrice, unrealizedPnl, ... }]`
> - `GET /api/orders?limit=50` → `[{ orderId, ticker, action, side, limitPrice, quantity, filledQuantity, status, kellyFraction, dryRun, createdAt }]`
> - `GET /api/signals?limit=20` → `[{ id, ticker, side, edge, confidence, recommendation, estimatedProb, marketPrice, createdAt }]`
> - `GET /api/markets?status=open&limit=50` → `[{ ticker, title, category, lastYesPrice, lastNoPrice, closeTime, targetDate, status, ... }]`
> - `GET /api/performance` → `{ cash, portfolio, unrealizedPnl, realizedPnl, winRate, brierScore, orderCount, positionCount }`
> - `GET /api/performance/win-rates` → `[{ label, wins, total, rate }]` for 24h/48h/7d
> - `GET /api/performance/daily-pnl?days=14` → `[{ date, pnl }]`
> - `GET /api/performance/calibration` → `[{ bucket, total, actualRate, avgPredicted }]` for 6 buckets
> - `GET /api/performance/resolutions?limit=10` → `[{ ticker, predictedProb, actualOutcome, edge, realizedPnl, resolvedAt }]`
> - `GET /api/logs?limit=100` → `[{ level, module, message, timestamp, data }]`
>
> WebSocket events (all `{ type, data }`):
> - `snapshot` (first message on connect) — merge into state
> - `bot:status`, `balance:update`, `position:update`, `order:placed`, `order:update`, `signal:new`, `signal:scout`, `market:discovered`, `market:priceUpdate`, `market:resolved`, `calibration:updated`, `log`, `forecast:fetched`, `bot:error`
>
> **Formatting helpers**:
> - `fmtMoney(cents)` → `$75.94`
> - `fmtPct(0-1)` → `65.0%`
> - `fmtEdge(0-1)` → `+12.3¢` or `-5.0¢`
> - `fmtRelTime(iso)` → `2m ago`, `in 4h`, `3d`
> - Money values from the API are in **cents** (integers). Probabilities are 0–1 floats.
>
> **Styling**:
> - Dark mode default (`className="dark"` on `<html>`)
> - Use `slate` as the neutral palette, `emerald` for gains, `rose` for losses, `amber` for warnings/dry-run, `sky` for info
> - `font-mono` for all numeric displays
> - Cards use `bg-slate-900/50 border-slate-800`
> - Use shadcn's `<Card>`, `<Table>`, `<Badge>`, `<ScrollArea>`, `<Input>`, `<Select>`
> - Briefly flash row background when it updates (CSS keyframe, ~800ms, barely perceptible)
>
> **File structure** (Vite project):
> - `index.html` — Vite entry, mounts `#root`, sets `<html class="dark">`
> - `src/main.tsx` — Vite entry, creates TanStack router, renders `<RouterProvider>`
> - `src/router.tsx` — `createRouter` with a root route and an `/` index route rendering `<Dashboard />`
> - `src/routes/__root.tsx` — root layout (global styles, dark mode wrapper, `<Outlet />`)
> - `src/routes/index.tsx` — the single dashboard page, composes all sections
> - `src/components/status-bar.tsx`
> - `src/components/kpi-row.tsx`
> - `src/components/equity-chart.tsx`
> - `src/components/daily-pnl-chart.tsx`
> - `src/components/markets-table.tsx`
> - `src/components/positions-table.tsx`
> - `src/components/signals-table.tsx`
> - `src/components/resolutions-table.tsx`
> - `src/components/calibration-chart.tsx`
> - `src/components/order-history-table.tsx`
> - `src/components/pipeline-status.tsx`
> - `src/components/sniper-countdown.tsx`
> - `src/components/event-feed.tsx`
> - `src/components/logs-panel.tsx`
> - `src/components/ui/*` — shadcn-installed primitives
> - `src/lib/use-api.ts` — REST + WebSocket hook
> - `src/lib/format.ts` — formatting helpers
> - `src/lib/types.ts` — shared TypeScript types matching the API response shapes
> - `src/lib/utils.ts` — shadcn's `cn()` helper
> - `tailwind.config.ts`, `postcss.config.js`, `vite.config.ts`, `tsconfig.json`, `components.json` (shadcn config)
>
> **Setup notes**:
> - Scaffold with `npm create vite@latest -- --template react-ts`
> - Add TanStack Router: `npm i @tanstack/react-router` + `@tanstack/router-plugin` (or Vite plugin) for code-based routing
> - Add Tailwind v4 with the Vite plugin
> - `npx shadcn@latest init` (pick the New York style, slate base color)
> - Install shadcn components: `npx shadcn@latest add card table badge input select button scroll-area separator tooltip`
> - `npm i recharts lucide-react`
>
> Generate a complete, runnable Vite SPA. Use mock data in each component as a visible fallback when `useApi` is loading so the layout renders immediately.

---

## Verification

After v0 generates the project:

1. `bun install` (in the web UI directory)
2. Start the bot: `bun bot` (headless + API on :3100)
3. Start the web UI: `bun run dev` (Vite on :5173 by default)
4. Open the browser — every panel populates from REST, then live-updates via WebSocket
5. Trigger a dry-run tick in the bot — confirm `signal:new` events flash in the Live Event Feed and Recent Signals table
6. Toggle dry-run off/on in the bot config — confirm status bar badge updates

## Future work (out of scope for first cut)

- Authentication (currently assumes localhost-only)
- REST mutations (place order, update config) — the API is read-only today
- Historical deep-dive views (drill into a single market/signal)
- Mobile-responsive refinements beyond a simple single-column collapse

## Changelog

- **2026-06-06** — Recent Resolutions now also shown on the Dashboard tab. The table was extracted into a shared component `app/web/components/dashboard/recent-resolutions.tsx` (used by both the Dashboard route and the Calibration view). Dashboard shows the latest 8 rows with a W/L + net P&L summary in the header and a "View all" link to Calibration; Calibration shows all loaded rows. Pure helper `resolutionSummary()` is unit-tested in `recent-resolutions.test.ts`.
