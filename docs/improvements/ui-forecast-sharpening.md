# UI Updates for Forecast Sharpening

The forecast sharpening changes (HRRR ingestion, sniper mode, empirical sigma, same-day observations, horizon-weighted blending) added significant new data and behaviors that aren't yet surfaced in the TUI or GUI. These updates make the new capabilities visible and actionable.

---

## 1. Surface Sniper/Scout Mode in Status Bar and Activity View

**Why:** The bot now silently skips execution when markets are outside the sniper window. Without visibility, this looks like the bot is broken or ignoring opportunities.

**TUI — Status Bar** (`app/cli/src/components/status-bar.tsx`):
- Add a mode indicator next to the running status: `SNIPER` (cyan) when any market is in the sniper window, `SCOUT` (yellow) when all are outside
- Show the sniper config: `sniper: 12h`

**TUI — Activity View** (`app/cli/src/views/activity.tsx`):
- Count scout signals separately: `Signals: 3 actionable / 8 scout / 15 total`
- Color scout events yellow in the feed (currently only skip=gray and actionable=green exist)
- On `signal:new`, display the recommendation including `"scout"` as a distinct state

**TUI — Dashboard** (`app/cli/src/views/dashboard.tsx`):
- In the signals list, show scout signals with a `SCOUT` label and the hours-to-close: `SCOUT (18.3h)`
- Scout signals are useful to monitor — they show what the bot *would* trade if the window were open

**GUI — Overlay** (`app/viz/src/frontend/hud/overlay.ts`):
- Add sniper/scout mode badge to the status section
- Activity feed: show scout signals in a distinct amber color with `[SCOUT]` prefix

**Data changes:**
- `SignalData` type in `app/viz/src/frontend/lib/types.ts`: add `"scout"` to the recommendation union
- `BotStatusData`: add `sniperHorizonHours: number` and `marketsInSniperWindow: number`
- Bus `signal:new` event: already emits only actionable signals — add a `signal:scout` event for scout-mode signals so UIs can display them

---

## 2. Show Forecast Horizon in Hours (Not Just Days)

**Why:** Hours-to-close is now the critical dimension driving HRRR weight, sniper gating, and observation adjustments. The current `explain` command shows horizon in integer days, which is too coarse.

**TUI — Markets View** (`app/cli/src/views/markets.tsx`):
- Add a `Close In` column showing hours to close: `6.2h`, `18.5h`, `2.1d`
- Format: `<6h` in red (urgent), `6-12h` in yellow (sniper window), `>12h` in gray (scout)
- Computed from `market.closeTime` if available, else `market.targetDate + T23:59Z`

**TUI — Explain Command** (`app/cli/src/commands/explain.ts`):
- Change `Forecast horizon: 1 day(s)` to `Forecast horizon: 8.3h (sniper window)` or `Forecast horizon: 26.1h (scout mode)`

**GUI — Station Detail Panel** (`app/viz/src/frontend/hud/station-detail.ts`):
- Show hours-to-close next to each position/market

**Data changes:**
- Store `forecastHorizonHours` on the signal record or compute it in the UI from market close time

---

## 3. Show Sigma Source and Value in Explain Command

**Why:** The estimator now chooses between empirical sigma and ensemble spread. This is the single biggest driver of probability changes and users need to see which was used and why.

**TUI — Explain Command** (`app/cli/src/commands/explain.ts`):
- Add a new `SIGMA` section after `BIAS CORRECTION`:
  ```
  SIGMA
    Source:          empirical (stdBias from 25 samples)
    Sigma used:      1.2 deg F
    Ensemble spread: 2.6 deg F  (would give 16.8% bracket prob)
    Empirical sigma: 1.2 deg F  (gives 38.2% bracket prob)
  ```
- When source is `"ensemble"`, show why: `Source: ensemble spread (insufficient empirical data: n=5, need 10)`
- Read `sigmaSource`, `sigmaUsed` from `reasoning` (already stored in JSON)

**TUI — Dashboard** (`app/cli/src/views/dashboard.tsx`):
- In the signal row, append a sigma indicator: `E` for empirical, `S` for ensemble spread. Subtle but lets power users spot which regime they're in.

---

## 4. Show Observation Adjustments in Explain and Activity

**Why:** Same-day observation adjustments can significantly shift the mean and sigma. Users should see when this happens and what the adjustment was.

**TUI — Explain Command** (`app/cli/src/commands/explain.ts`):
- Add `OBSERVATION ADJUSTMENT` section when present:
  ```
  OBSERVATION ADJUSTMENT
    Observed temp:   72.1F at 2026-04-14T11:30:00Z
    Forecast mean:   81.3F
    Divergence:      9.2F (> 3F threshold, shifting mean)
    Sigma before:    1.2F → after: 0.84F
    Mean shift:      -2.8F (adjusted mean: 78.5F)
  ```
- When no observation is available, note: `No same-day observation available`

**TUI — Activity View** (`app/cli/src/views/activity.tsx`):
- Log observation fetches as info events: `Obs KNYC: 72.1F → sigma tightened 50%` or `Obs KNYC: 65.0F → mean shifted -2.8F`

**GUI — Station Detail Panel** (`app/viz/src/frontend/hud/station-detail.ts`):
- Show latest observation alongside the forecast: `Observed: 72.1F | Forecast: 81.3F`

**GUI — Station Pillars** (`app/viz/src/frontend/scene/stations.ts`):
- When an observation is active, add a secondary ring or marker on the pillar at the observed temperature height, giving a visual "where we are now vs forecast"

---

## 5. Show HRRR Status and Model Blending in Explain

**Why:** HRRR is the highest-impact data source and users need to see when it's being used, what it predicted, and how heavily it was weighted.

**TUI — Explain Command** (`app/cli/src/commands/explain.ts`):
- Add `DATA SOURCES` section:
  ```
  DATA SOURCES
    Open-Meteo ensemble:  120 members (GFS: 31, ECMWF: 31, ICON: 40, GEM: 11, ARPEGE: 7)
    HRRR (3km):           77.0F  (weight: 40%, horizon bucket: 6-18h)
    Tomorrow.io:          76.5F  (1 value)
    Total pool:           168 members (after blending)
  ```
- This data isn't currently stored — see data changes below

**TUI — Activity View** (`app/cli/src/views/activity.tsx`):
- Show HRRR fetch events in the feed: `HRRR KNYC: 77.0F (weight 40% at 10.2h)`

**Data changes needed:**
- The ensemble service should emit a `forecast:fetched` bus event with source breakdown: `{ stationId, sources: { openMeteo: 120, hrrr: 1, tomorrowIo: 1 }, hrrrValue, horizonBucket, hrrrWeight }`
- Store the source breakdown in the `reasoning` trace JSON (add `dataSources` field to `ReasoningTrace` in `estimator.ts`)
- Alternatively, the estimator can tag the ensemble size by source and pass it through

---

## 6. Add Bracket Probability Comparison to Markets View

**Why:** The core improvement is going from 24.4% correct bracket ID to 70-85%. Users should see bracket-level probability for each market, not just the aggregate estimate.

**TUI — Markets View** (`app/cli/src/views/markets.tsx`):
- Add `Our P` and `Mkt P` columns (our probability vs market YES price, both in %)
- Highlight rows where our P > 50% (strong conviction bracket) in bold/green
- This already shows `Estimated Prob` and `Edge`, but making the comparison explicit helps

**GUI — Station Detail Panel** (`app/viz/src/frontend/hud/station-detail.ts`):
- For each market at a station, show a mini bracket diagram:
  ```
  KXHIGHNY-26APR14
  ... [76-78] 8% | [78-80] 72%* | [80-82] 15% | [82+] 5%
  ```
  The `*` marks the market's top bracket. This requires fetching sibling market probabilities.

**Data changes:**
- New API endpoint `GET /api/brackets/{seriesTicker}` returning all brackets with their probabilities for a series
- Or: include sibling bracket data in the existing `/api/station/{id}` response

---

## 7. Add Sniper Countdown Timer to Dashboard

**Why:** When the bot is in scout mode, the user wants to know when it'll start executing. A countdown to the sniper window is the most actionable piece of information.

**TUI — Dashboard** (`app/cli/src/views/dashboard.tsx`):
- Add a "Next Sniper Window" section at the top:
  ```
  Next sniper window:
    KXHIGHNY  78-80  in 3.2h  (close in 15.2h, sniper at 12h)
    KXHIGHCHI 62-64  in 1.1h  (close in 13.1h, sniper at 12h)
    KXLOWLAX  48-50  NOW      (close in 8.4h) ← actively trading
  ```
- Sort by time to sniper entry (soonest first)
- `NOW` markets highlighted green, upcoming in yellow

**GUI — Overlay** (`app/viz/src/frontend/hud/overlay.ts`):
- Add a compact countdown row below portfolio: `Next sniper: KXHIGHNY in 3.2h`

---

## 8. Track and Display Forecast Accuracy Over Time

**Why:** The whole point of these improvements is going from 24% to 70%+ correct bracket identification. Users need to see this improving in real-time.

**TUI — Performance View** (`app/cli/src/views/performance.tsx`):
- Add a "Forecast Accuracy" section:
  ```
  FORECAST ACCURACY (last 30 days)
    Correct bracket (top-1):  68.2%  (30/44)    ← was 24.4%
    Brier score (7h):         0.042              ← was 0.161
    Avg sigma used:           1.3F (empirical)   ← was 2.6F (ensemble)
    HRRR coverage:            82% of sniper entries
  ```
- The data is available from calibration records + weather_forecasts table

**TUI — Performance View** — Add a "Sigma Comparison" chart:
  ```
  Sigma comparison (last 44 markets):
    Ensemble spread: ████████████████████ 2.6F
    Empirical sigma: █████████           1.3F
    Actual error:    ███████             1.1F  ← ground truth
  ```

**GUI — Performance Panel** (`app/viz/src/frontend/hud/performance.ts`):
- Add "Accuracy" metric to the stats grid
- Add bracket accuracy trend line to the equity chart (secondary axis or separate mini chart)

**Data changes:**
- New query in `app/cli/src/views/performance-query.ts`: compute top-1 bracket accuracy from calibration records where the signal was on the correct bracket
- `/api/performance` response: add `bracketAccuracy`, `avgSigmaUsed`, `hrrrCoverage` fields

---

## 9. Improve GUI Station Visualization for HRRR

**Why:** HRRR is only available for the next 48h. Stations with active HRRR data should look different from those relying on ensemble-only forecasts.

**GUI — Stations** (`app/viz/src/frontend/scene/stations.ts`):
- Add a secondary inner ring that lights up bright blue when HRRR data is active for that station
- The ring pulses slowly to indicate "high-confidence mode"
- When HRRR + observation are both active, use a brighter cyan pulse — this represents the highest-confidence state

**GUI — Weather Layer** (`app/viz/src/frontend/scene/weather-layer.ts`):
- Add a subtle grid overlay on the temperature field that's denser (3km-like) around stations with active HRRR data, vs coarser elsewhere
- This visually communicates "we have better resolution here"

---

## 10. Update WebSocket Types for New Data

All changes above require extending the data types that flow from backend to frontend.

**`app/viz/src/frontend/lib/types.ts`:**
```typescript
// SignalData: add scout
recommendation: "buy_yes" | "buy_no" | "scout" | "skip";

// SignalData: add new fields
forecastHorizonHours?: number;
sigmaSource?: "empirical" | "ensemble";
sigmaUsed?: number;
hrrrActive?: boolean;
observationTemp?: number;

// BotStatusData: add sniper info
sniperHorizonHours?: number;
marketsInSniperWindow?: number;
marketsInScoutMode?: number;

// PerformanceData: add accuracy metrics
bracketAccuracy?: number;
avgSigmaUsed?: number;
hrrrCoverage?: number;
```

**`app/viz/src/ws-bridge.ts`:**
- Forward `signal:scout` events (new event type to add in engine)

**Bus events (`app/engine/events.ts`):**
- Add `signal:scout` event mirroring `signal:new` but for scout-mode signals
- Add `forecast:fetched` event with source breakdown

---

## 11. Replace TUI Chart Infrastructure with ink-chart

**Why:** The current charts use two separate approaches — `simple-ascii-chart` for the portfolio line chart and hand-rolled Unicode block character rendering for bar charts. The `ink-chart` library (`https://github.com/pppp606/ink-chart`) unifies all chart types as proper Ink React components with better rendering, color support, and multi-series capability. This is a prerequisite for adding the new charts in #8 (forecast accuracy, sigma comparison).

**Install:**
```sh
bun add ink-chart
bun remove simple-ascii-chart
```

### What to replace

The entire chart rendering lives in two files:
- `app/cli/src/views/charts.ts` — all chart functions (string-based rendering)
- `app/cli/src/views/performance.tsx` — consumes charts, embeds them as `<Text>{string}</Text>`

The current charts are:

| Chart | Current impl | ink-chart replacement |
|-------|-------------|----------------------|
| Portfolio equity line | `simple-ascii-chart` library via `renderPortfolioChart()` | `<LineGraph>` component |
| Calibration buckets | Hand-rolled `█░` bars via `renderBucketChart()` | `<StackedBarChart>` component |
| Daily P&L | Hand-rolled `█░` bars via `renderDailyPnl()` | `<BarChart>` component |
| Sigma comparison (new, #8) | Not yet built | `<BarChart>` component |
| Bracket accuracy sparkline (new, #8) | Not yet built | `<Sparkline>` component |

### Migration details

**`app/cli/src/views/charts.ts`** — Rewrite to export React components instead of string-returning functions:

1. **`renderPortfolioChart()` → `<PortfolioChart>`**: Replace with `<LineGraph>` from ink-chart.
   - Current: calls `plot()` from `simple-ascii-chart`, returns a multi-line string
   - New: `<LineGraph>` component with `values` array, `width="auto"`, and green color
   - Keep the `downsample()` utility — it's still needed to reduce data points
   - Data transform: `PortfolioPoint[]` → `{ values: number[] }[]` (single series of portfolio/100 values)

2. **`renderBucketChart()` → `<CalibrationChart>`**: Replace with `<StackedBarChart>` from ink-chart.
   - Current: hand-built `█░` bars with calibration error indicators (`!`, `~`)
   - New: `<StackedBarChart>` where each bucket has two segments — "hit rate" (green) and "remainder" (gray)
   - Preserve the calibration error indicator logic (append `!`/`~` as suffix labels)
   - Each row: `label` = bucket range, segments = `[{ label: "hits", value: hitRate, color: "green" }, { label: "miss", value: 1-hitRate, color: "gray" }]`

3. **`renderDailyPnl()` → `<DailyPnlChart>`**: Replace with `<BarChart>` from ink-chart.
   - Current: hand-built `█░` bars with ± amounts
   - New: `<BarChart>` with entries `{ label: "Mon 04/14", value: pnl/100, color: pnl >= 0 ? "green" : "red" }`
   - Use the `formatValue` prop to show dollar amounts: `(v) => \`${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}\``
   - Keep `formatDayLabel()` utility for label generation

4. **New: `<SigmaComparisonChart>`** (for #8): Use `<BarChart>` with 3 rows:
   - `{ label: "Ensemble spread", value: avgEnsembleStd, color: "yellow" }`
   - `{ label: "Empirical sigma", value: avgEmpiricalSigma, color: "cyan" }`
   - `{ label: "Actual error", value: avgActualError, color: "green" }`

5. **New: `<AccuracySparkline>`** (for #8): Use `<Sparkline>` with recent bracket accuracy values.
   - Data: rolling window of correct-bracket rate over the last N resolved markets
   - Threshold prop to highlight when accuracy crosses target (e.g., 70%)

**`app/cli/src/views/performance.tsx`** — Update to use the new components:
- Replace `<Text>{renderPortfolioChart(...)}</Text>` with `<PortfolioChart points={...} />`
- Replace `<Text>{renderBucketChart(...)}</Text>` with `<CalibrationChart buckets={...} />`
- Replace `<Text>{renderDailyPnl(...)}</Text>` with `<DailyPnlChart days={...} />`
- Add new `<SigmaComparisonChart>` and `<AccuracySparkline>` in the forecast accuracy section (#8)

### What to keep

- `downsample()` function — still needed for reducing large datasets before plotting
- `formatDuration()` function — used by status bar, not chart-specific
- `formatDayLabel()` function — used for bar labels
- `BucketData`, `DailyPnlEntry`, `PortfolioPoint` interfaces — data contracts stay the same
- `renderHorizontalBar()` — currently unused, can be deleted

### Testing

- `app/cli/src/views/charts.test.ts` — rewrite tests to render components with Ink's `render()` test helper instead of asserting on string output. Test that components render without throwing and produce expected approximate content.

---

## 12. Replace TUI Table Rendering with ink-table

**Why:** Tables are rendered two different ways — Ink `<Box width={N}>` column layouts in views, and `padEnd()`/`padStart()` string formatting in REPL commands. Both are fragile, hard to maintain, and break when data exceeds column widths. The `ink-table` library (`https://github.com/maticzav/ink-table`) provides auto-sized columns, box-drawing borders, and custom cell renderers as a proper Ink React component.

**Install:** Already installed (`ink-table` is in dependencies).

### Tables to replace

There are **9 tables** across views and REPL commands:

#### Ink Box-based tables (views)

| Location | Table | Columns | Current approach |
|----------|-------|---------|-----------------|
| `app/cli/src/views/markets.tsx` | Market list | TICKER(28), DATE(10), STATUS(8), PRICE(8), EST(8), EDGE(8), CONF(8) | `<Box width={N}>` per column, `"─".repeat(80)` separator |
| `app/cli/src/views/performance.tsx` | Recent resolutions | TICKER(30), PREDICTED(10), ACTUAL(8), EDGE(8), PnL(10) | `<Box width={N}>` per column |
| `app/cli/src/views/performance.tsx` | Order history | TIME(10), TICKER(28), SIDE(6), QTY(5), PRICE(7), STATUS(9), KELLY(7), DRY(5) | `<Box width={N}>` per column |

#### String-based tables (REPL commands)

| Location | Command | Columns | Current approach |
|----------|---------|---------|-----------------|
| `app/cli/src/commands/markets.ts` | `markets` / `ls` | TYPE(6), TICKER(30), PRICE(6), STATUS(10), CLOSES(var) | `padEnd()`/`padStart()` |
| `app/cli/src/commands/positions.ts` | `positions` | TYPE(6), TICKER(30), SIDE(6), QTY(5), AVG(6), P&L(8) | `padEnd()`/`padStart()` |
| `app/cli/src/commands/positions.ts` | `orders` | ORDER(12), TICKER(25), SIDE(5), QTY(4), PRICE(6), STATUS(10) | `padEnd()`/`padStart()` |
| `app/cli/src/commands/calibration.ts` | `calibration detail` | TICKER(28), PRED(6), MKT(6), ACTUAL(7), EDGE(7), P&L(8) | `padEnd()`/`padStart()` |
| `app/cli/src/commands/calibration.ts` | `calibration bias` | STATION(8), HORIZON(8), BIAS(10), STD(8), N(6) | `padEnd()`/`padStart()` |
| `app/cli/src/commands/backtest.ts` | `backtest` | DATE(12), BRACKET(10), EST P(7), ACTUAL(7), BRIER(8), KELLY(7), P&L(8) | `padEnd()`/`padStart()` |

### Migration approach

**ink-table** takes a `data` prop (array of row objects with scalar values) and auto-sizes columns. Customization is via `header`, `cell`, and `skeleton` render props.

#### View tables (markets.tsx, performance.tsx)

These are already React components — replace the `<Box width={N}>` column pattern directly:

```tsx
import Table from "ink-table";

// Before: manual Box grid with hardcoded widths
<Box><Box width={28}><Text>{ticker}</Text></Box><Box width={8}><Text>{price}</Text></Box>...</Box>

// After: ink-table with data array
<Table
  data={markets.map(m => ({
    ticker: m.ticker,
    date: m.targetDate ?? "—",
    status: m.status,
    price: m.lastYesPrice != null ? `${m.lastYesPrice}c` : "—",
    est: signal ? `${(signal.estimatedProb * 100).toFixed(0)}¢` : "—",
    edge: signal ? `${(signal.edge * 100).toFixed(1)}¢` : "—",
    conf: signal ? `${(signal.confidence * 100).toFixed(0)}%` : "—",
  }))}
  columns={["ticker", "date", "status", "price", "est", "edge", "conf"]}
  cell={({ children }) => <Text>{children}</Text>}
/>
```

For **conditional cell coloring** (e.g., green/red PnL, status colors), use a custom `cell` renderer that inspects the value:

```tsx
cell={({ children }) => {
  const val = String(children);
  // Color P&L values
  if (val.startsWith("+$")) return <Text color="green">{children}</Text>;
  if (val.startsWith("-$")) return <Text color="red">{children}</Text>;
  // Color status
  if (val === "open" || val === "filled") return <Text color="green">{children}</Text>;
  return <Text>{children}</Text>;
}}
```

Delete the `"─".repeat(N)` separator rows — ink-table draws its own box-drawing borders.

#### REPL command tables (markets.ts, positions.ts, calibration.ts, backtest.ts)

These commands currently return plain strings. Two options:

**Option A (recommended):** Convert commands to return React elements instead of strings, and render them with `ink`'s `render()` in the REPL output. This gives full ink-table support.

The REPL view (`app/cli/src/views/repl.tsx`) currently renders command output as `<Text>{output}</Text>`. Change it to support JSX returns:
```tsx
// If command returns a React element, render it directly
// If command returns a string, wrap in <Text>
{typeof output === "string" ? <Text>{output}</Text> : output}
```

Then commands can return `<Table data={...} />` directly.

**Option B (simpler):** Keep commands as string-returning functions but build a `renderTable()` utility that formats data into aligned columns using ink-table's approach internally. Less ideal since it doesn't use the actual library.

**Recommendation:** Go with Option A. The REPL change is small and unlocks ink-table everywhere.

#### Specific per-table migration notes

1. **markets.tsx** — The market list table has signal data overlaid via `signalMap` state. Pre-merge market + signal data into the row objects before passing to `<Table>`.

2. **performance.tsx (resolutions)** — The `ACTUAL` column shows "YES"/"NO" with conditional coloring. Format in the data transform, color in the cell renderer.

3. **performance.tsx (orders)** — The `DRY` column shows "DRY" in yellow or "—" in gray. Use a cell renderer that checks for the "DRY" string.

4. **positions.ts** — The `TYPE` column maps category to short labels (HIGH, LOW, RAIN, SNOW). Do this mapping in the data transform before passing to Table.

5. **calibration.ts (bias)** — Small table (typically 5-10 rows). Straightforward migration.

6. **backtest.ts** — The largest table by column count (7). Some cells have conditional formatting (P&L sign colors). Use a cell renderer.

### What to delete

- All `"─".repeat(N)` and `"-".repeat(N)` separator lines
- All `padEnd()`/`padStart()` column formatting in REPL commands
- The manual `<Box width={N}>` header + data row patterns in views
- Any column width constants that were hardcoded

### What to keep

- Data fetching and transformation logic in each command/view
- Category label mapping (`high_temp` → `HIGH`, etc.)
- Color decision logic (move into cell renderers)
- `formatDayLabel()`, `formatDuration()` utilities

### Testing

- View tests: use Ink's `render()` test helper, assert table renders without errors
- REPL command tests: update to handle JSX returns if going with Option A
- Snapshot tests are a good fit here — ink-table output is deterministic for given data

---

## Implementation Order

These are ordered by user impact and dependency:

1. **Replace chart infrastructure** (#11) — do this first, unblocks new charts in later items
2. **Replace table infrastructure** (#12) — do alongside #11, both are foundational
3. **Sniper/scout visibility** (#1, #7) — most urgent, bot looks broken without it
4. **Explain command updates** (#3, #4, #5) — immediate debugging value
5. **Hours-to-close column** (#2) — quick win, informs all other features
6. **WebSocket type updates** (#10) — required for GUI changes
7. **Forecast accuracy tracking** (#8) — validates the improvements are working, uses new chart components
8. **Bracket probability comparison** (#6) — deepens market understanding
9. **GUI station HRRR visualization** (#9) — polish
