# Oilbot — WTI Intervention-Thesis Trading Bot

**Author:** Elijah Boston
**Status:** Draft
**Last updated:** 2026-06-10

## Overview

A trading agent for Kalshi's WTI crude oil prediction markets, built on a specific macro thesis: **Iran supply risk creates a structural price floor, while Treasury intervention to suppress prices creates mean-reversion opportunities.** The bot detects when intervention is pushing prices below fair value and bets on reversion, and detects when intervention pauses and prices overshoot.

Runs alongside climatebot in the same monorepo, sharing Kalshi infrastructure, DB, execution, and reconciliation.

**Target markets:** KXWTI (daily/weekly WTI settlement), KXWTIMAX (yearly high)

---

## The Thesis

### Structural Forces

1. **Bullish floor (Iran/geopolitical):** Ongoing Iran tensions constrain supply. As long as this persists, WTI has a geopolitically-enforced floor. The market "wants" to be higher.

2. **Bearish ceiling (Treasury intervention):** The Treasury has signaled willingness to intervene — via SPR releases, jawboning, or encouraging allied production increases — to keep prices from spiking. This creates artificial downward pressure.

3. **The opportunity:** These two forces create a **volatility corridor**. When intervention pushes price toward the floor, it's likely to bounce. When intervention fades and price spikes toward the ceiling, it's likely to get knocked back down. A bot that identifies which force is currently dominant can trade the oscillation.

### Why Kalshi Binary Contracts Fit This

- **Capped downside:** Maximum loss per contract is the premium paid. No margin calls if the thesis is wrong.
- **Bracket structure:** KXWTI markets have strike prices at specific dollar levels. The bot can express views like "WTI won't stay below $65" (buy YES on the $65 bracket) or "WTI won't break $80" (buy NO on the $80 bracket) with defined risk.
- **Time decay works for us:** If the thesis is "price reverts to a corridor," being right about the range at settlement is enough — the path doesn't matter.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Oilbot Process (separate from climatebot)                      │
│                                                                  │
│  ┌───────────────────────────────────────────────────────┐       │
│  │  Oil Orchestrator (tick loop, 15-30 min interval)      │       │
│  │  Phase 1: Discovery    → KXWTI/KXWTIMAX series         │       │
│  │  Phase 2: Data Fetch   → spot, intervention signals     │       │
│  │  Phase 3: Regime ID    → floor/ceiling/intervention     │       │
│  │  Phase 4: Evaluation   → edge vs market price           │       │
│  │  Phase 5: Execution    → @kcb/execution (shared)        │       │
│  │  Phase 6: Reconcile    → @kcb/engine (shared)           │       │
│  └───────────────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────────────┤
│  Shared: @kcb/kalshi-client │ @kcb/db │ @kcb/config             │
│          @kcb/execution     │ @kcb/engine (reconciliation)      │
│  SQLite (WAL mode — concurrent access with climatebot)           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Reuse from Climatebot

### Packages (no modifications needed)

| Package | What it provides |
|---------|-----------------|
| `@kcb/kalshi-client` | REST + WS client, order placement, market fetching |
| `@kcb/db` | Drizzle ORM, migrations, generic tables (markets, orders, trades, positions, signals, calibration, balance_history) |
| `@kcb/execution` | Kelly sizing, exposure limits, cooldowns, order guards |
| `@kcb/engine` | ReconciliationService (order sync, settlements, balance snapshot), event bus, log writer |
| `@kcb/shared` | uuid(), now(), utility functions |

### Packages (minor extensions needed)

| Package | Change |
|---------|--------|
| `@kcb/config` | Add `oil` config section (API keys, tick interval, regime params) |
| `@kcb/db` | Add `oil_data` and `intervention_signals` table schemas |

---

## Core Logic: Regime Detection

The bot doesn't try to predict the exact price of oil. It identifies **which regime the market is in** and takes positions that profit from reversion to the corridor.

### Regime States

```
                    CEILING (Treasury intervention likely)
                    ────────────────────────────────────── ~$78-82
                         ↕  CORRIDOR (fair value zone)
                    ────────────────────────────────────── ~$64-68
                    FLOOR (geopolitical supply premium)
```

| Regime | Detection | Trading Action |
|--------|-----------|----------------|
| **Floor test** | Price approaching/below floor, intervention signals absent | Buy YES on floor bracket (bet price stays above) |
| **Intervention active** | SPR release announced, unusual futures selling, Treasury jawboning | Buy YES on floor bracket (price suppressed but floor holds) |
| **Corridor** | Price between floor and ceiling, no strong signals | No new positions, hold existing |
| **Ceiling test** | Price approaching ceiling, no intervention | Buy NO on ceiling bracket (bet intervention will cap it) |
| **Breakout** | Price breaks floor or ceiling with fundamental catalyst | Exit positions, pause trading, reassess corridor |

### Floor and Ceiling Calibration

The corridor is not static. It adapts based on:
- **Floor:** Derived from Iran situation severity. Escalation raises the floor. De-escalation lowers it. Updated from geopolitical event detection.
- **Ceiling:** Derived from Treasury's revealed preference. SPR actions and statements reveal the price level they consider unacceptable. Updated from intervention history.
- **Width:** Wider corridor = less confidence = smaller positions. Narrower = higher confidence = bigger positions.

Initial values (calibrated from 2025-2026 price action):
- Floor: $65 (Iran supply risk premium)
- Ceiling: $80 (Treasury intervention trigger)
- These are config params, not hardcoded.

---

## Intervention Signal Detection

This is the key differentiator. The bot watches for signals that Treasury/government is actively intervening.

### Signal Sources (ranked by reliability)

#### 1. SPR Releases (strongest signal)
- **Source:** DOE announcements via EIA API, White House press releases
- **Detection:** SPR inventory drawdowns in EIA weekly data; or announcement scraping
- **Lag:** Weekly (EIA data) or same-day (announcement)
- **Signal:** SPR release = intervention active, price suppression in progress → buy the floor

#### 2. CFTC Commitments of Traders (weekly)
- **Source:** CFTC COT reports via public data
- **Key data:** Commercial vs non-commercial positioning in WTI futures
- **Detection:** Unusual increase in commercial short positions not explained by hedging fundamentals
- **Signal:** Anomalous short buildup = possible coordinated selling → intervention may be occurring

#### 3. Futures Curve Shape Anomalies
- **Source:** CME delayed quotes or FRED futures series
- **Detection:** Front-month suddenly in deeper contango than back months without fundamental catalyst. Normal supply/demand moves affect the whole curve; intervention tends to hit the front month harder.
- **Signal:** Curve distortion = artificial selling pressure → mean reversion likely

#### 4. Spot-Futures Divergence
- **Source:** Compare WTI spot (DCOILWTICO) vs front-month futures
- **Detection:** Futures trading at unusual discount to spot (normally near parity)
- **Signal:** Futures-specific selling = intervention in futures market

#### 5. News/Statement Detection
- **Source:** RSS feeds (Reuters, Bloomberg energy), White House briefings
- **Detection:** Claude API for structured extraction:
  ```
  Is this statement about oil prices? Y/N
  Does it signal government intent to suppress prices? Y/N
  Confidence: high/medium/low
  ```
- **Signal:** Jawboning often precedes or accompanies action

#### 6. EIA Inventory Surprises (fundamental baseline)
- **Source:** EIA Weekly Petroleum Status Report
- **Key data:** Crude inventory builds/draws vs consensus
- **Signal:** Large surprise draw = bullish, confirming floor. Large surprise build = bearish (but if not matched by production increase, could be SPR-driven).

### Intervention Score

Each tick computes a composite intervention score:

```typescript
type InterventionState = {
  score: number;         // -1 (strong intervention) to +1 (no intervention, supply squeeze)
  confidence: number;    // 0-1, how many signals agree
  sprActive: boolean;    // SPR release in progress
  lastStatement: string | null;  // Most recent gov't statement
  curveDistortion: number;       // Z-score of front-month discount
  cotAnomaly: number;    // Z-score of commercial short positioning
};
```

---

## Probability Estimation

Unlike climatebot's statistical ensemble approach, oilbot's estimation is **regime-conditional:**

### Step 1: Determine the Regime
Use intervention signals + current price relative to corridor.

### Step 2: Estimate Settlement Probability Given Regime

**Floor test regime** (price near floor, intervention may be active):
```
P(settle above floor bracket) = high (0.75-0.90)
Reasoning: geopolitical floor is structural, intervention is temporary
```

**Ceiling test regime** (price near ceiling, no intervention yet):
```
P(settle below ceiling bracket) = moderate-high (0.65-0.80)
Reasoning: Treasury likely to act, but timing uncertain
```

**Corridor regime:**
```
Use standard GBM model with historical vol as baseline
No strong directional edge → skip or very small positions
```

### Step 3: Apply GBM for Calibration

Even in a thesis-driven approach, GBM provides the baseline probability to compare against. The thesis provides the **adjustment:**

```
P_adjusted = P_gbm + regime_adjustment

where regime_adjustment = f(intervention_score, distance_to_boundary, time_to_settlement)
```

This lets the bot quantify how much the thesis shifts the probability vs pure statistics, and the calibration system measures whether that shift is actually predictive over time.

### Step 4: Compare to Market Price

Edge = P_adjusted - Kalshi_market_price. Only trade when edge exceeds threshold.

---

## Data Sources

### Phase 1 — Core (free APIs, sufficient for launch)

| Source | Data | Update Freq | API Key |
|--------|------|-------------|---------|
| EIA API | Crude inventory, SPR levels, production | Weekly (Wed) | Free (eia.gov) |
| FRED | WTI spot (DCOILWTICO), futures curve, yield curve | Daily | Free (fred.stlouisfed.org) |
| CFTC | Commitments of Traders (WTI positioning) | Weekly (Fri) | None (public CSV) |

### Phase 2 — Enhanced

| Source | Data | Update Freq | Cost |
|--------|------|-------------|------|
| News RSS + Claude API | Gov't statements, OPEC news, geopolitical events | Per tick | Claude API costs only |
| CME DataMine | Real-time futures curve | Intraday | ~$100/mo |

---

## New Components

### File Structure

```
app/oilbot/
  package.json
  index.ts
  src/
    index.ts                            # Entry point
    services/
      oil-orchestrator.ts               # Tick pipeline
      oil-discovery.ts                  # KXWTI market discovery + ticker parsing
      regime-detector.ts                # Core: regime identification
      intervention-tracker.ts           # Intervention signal aggregation
      oil-estimator.ts                  # Regime-conditional probability estimation
      corridor-calibrator.ts            # Adaptive floor/ceiling from history
      sources/
        eia.ts                          # EIA inventory + SPR data
        fred.ts                         # Spot prices, futures curve
        cftc.ts                         # COT report parsing
        news.ts                         # RSS + Claude API sentiment
      oil-orchestrator.test.ts
      regime-detector.test.ts
      intervention-tracker.test.ts
      oil-estimator.test.ts
      corridor-calibrator.test.ts
      sources/
        eia.test.ts
        fred.test.ts
        cftc.test.ts
```

---

## Configuration

Add to `packages/config/src/index.ts`:

```typescript
oil: {
  enabled: boolean;              // Master switch
  tickIntervalSec: number;       // 900 (15 min) — faster than climatebot, oil moves faster
  enabledSeries: string[];       // ["KXWTI", "KXWTIMAX"]
  eiaApiKey: string;
  fredApiKey: string;

  // Corridor parameters (updated manually or by corridor-calibrator)
  floorPrice: number;            // 65.00 — geopolitical floor
  ceilingPrice: number;          // 80.00 — intervention ceiling
  corridorConfidence: number;    // 0.7 — how confident we are in the corridor

  // Regime thresholds
  interventionScoreThreshold: number;  // -0.3 — below this = intervention active
  floorTestDistance: number;     // 3.0 — within $3 of floor = floor test regime
  ceilingTestDistance: number;   // 3.0 — within $3 of ceiling = ceiling test regime

  // Risk
  edgeThreshold: number;         // 0.12
  maxKellyFraction: number;      // 0.03 (conservative)
  maxOpenPositions: number;      // 6
  maxExposurePerTicker: number;  // 500 (cents)
  maxTotalExposure: number;      // 3000 (cents) — across all oil positions
  dryRun: boolean;               // Start true
}
```

---

## DB Schema

### `oil_data` — Cached source data

```typescript
export const oilData = sqliteTable("oil_data", {
  id:            text("id").primaryKey(),
  source:        text("source").notNull(),        // "eia", "fred", "cftc", "news"
  dataType:      text("data_type").notNull(),      // "inventory", "spr_level", "spot_price", "futures_curve", "cot", "sentiment"
  dataJson:      text("data_json").notNull(),
  fetchedAt:     text("fetched_at").notNull(),
  expiresAt:     text("expires_at"),
});
```

### `intervention_signals` — Intervention event log

```typescript
export const interventionSignals = sqliteTable("intervention_signals", {
  id:            text("id").primaryKey(),
  detectedAt:    text("detected_at").notNull(),
  signalType:    text("signal_type").notNull(),    // "spr_release", "cot_anomaly", "curve_distortion", "statement", "spot_futures_divergence"
  severity:      real("severity").notNull(),        // -1 to +1
  confidence:    real("confidence").notNull(),       // 0 to 1
  description:   text("description").notNull(),
  dataJson:      text("data_json"),                 // Raw evidence
  expiresAt:     text("expires_at"),                // When this signal stops being relevant
});
```

Existing `markets`, `orders`, `positions`, `signals`, `calibration` tables work as-is. Oil markets use `stationId = NULL` and `category = 'wti_daily'` or `'wti_yearly_high'`.

---

## Tick Pipeline

```
1. DISCOVERY
   Fetch KXWTI/KXWTIMAX markets from Kalshi
   Parse tickers → extract settlement date, strike price

2. DATA FETCH
   Pull latest: spot price, EIA inventory, SPR level, futures curve, COT data
   Cache in oil_data table (skip fetch if cache fresh)

3. REGIME DETECTION
   Compute intervention score from all signals
   Determine current regime: floor_test | intervention | corridor | ceiling_test | breakout
   Log regime + score to intervention_signals table

4. EVALUATION (for each active market)
   Compute P_gbm (baseline statistical probability)
   Apply regime adjustment → P_adjusted
   Compare to Kalshi market price → edge
   If edge > threshold AND regime is actionable → generate signal

5. EXECUTION
   Kelly sizing (shared @kcb/execution)
   Exposure checks, cooldowns, order guards
   Place order via @kcb/kalshi-client

6. RECONCILIATION
   Shared ReconciliationService handles order sync, settlements, balance
```

---

## Risk Management

| Risk | Impact | Mitigation |
|------|--------|------------|
| Thesis is wrong (no corridor) | Sustained losses | Paper trade 2+ weeks, track regime predictions vs outcomes before going live. Kill switch if corridor breaks 3x consecutively. |
| Treasury stops intervening | Ceiling disappears, losses on NO positions | Monitor for regime change. If ceiling is tested and breaks without intervention, widen corridor and reduce position sizes. |
| Iran de-escalation | Floor drops, losses on YES positions | News detection for diplomatic breakthroughs. Auto-pause on major geopolitical shift headlines. |
| Both forces disappear | No vol, no edge | Bot naturally stops trading (corridor regime = no positions). Low cost of being wrong — just idle. |
| Correlated with climatebot | Portfolio concentration | Separate exposure limits. Oil allocation capped independently. |
| Overfitting corridor params | False confidence | Start with wide corridor, let calibration tighten it. Log every regime call for post-hoc review. |

### Hard Kill Switches

- **Drawdown limit:** If oil PnL drops below -$X, pause all new oil positions for 24h
- **Regime confusion:** If regime changes >4x in 24h, pause (signals are noisy, not actionable)
- **Breakout:** If price closes outside corridor by >$5, pause and alert for manual corridor reassessment

---

## Phased Rollout

### Phase 1 — Scaffolding + Data (2-3 days)
- [ ] Create `app/oilbot` workspace
- [ ] Oil ticker parser and market discovery
- [ ] `oil` config section
- [ ] DB schema + migration for `oil_data` and `intervention_signals`
- [ ] EIA client (inventory + SPR level fetching)
- [ ] FRED client (spot price + futures curve)
- [ ] Tests for all of the above

### Phase 2 — Regime Detection (3-4 days)
- [ ] Intervention tracker (aggregates signals into composite score)
- [ ] SPR release detection from EIA data
- [ ] Futures curve distortion detection
- [ ] CFTC COT report parser + anomaly detection
- [ ] Regime detector (maps intervention score + price → regime state)
- [ ] Corridor calibrator (initial manual params, with logging for future auto-calibration)
- [ ] Tests with historical data scenarios

### Phase 3 — Estimator + Orchestrator (2-3 days)
- [ ] Regime-conditional probability estimator
- [ ] GBM baseline + regime adjustment
- [ ] Wire up orchestrator tick pipeline
- [ ] Entry point script (`bun run oilbot`)
- [ ] Integration test: full tick with mocked data sources

### Phase 4 — Paper Trading (1-2 weeks observation)
- [ ] Run with `DRY_RUN=true`
- [ ] Log every regime call, every signal, every would-be trade
- [ ] Track: does the regime detector correctly identify intervention periods?
- [ ] Track: do regime-adjusted probabilities beat GBM baseline?
- [ ] Tune corridor params and edge threshold based on observations

### Phase 5 — Live + Enhancements
- [ ] Go live with small positions ($2-5 per contract)
- [ ] News sentiment via Claude API (Phase 2 data source)
- [ ] Auto-calibrating corridor from intervention history
- [ ] Oil panel in viz dashboard
- [ ] Combined portfolio risk view (climate + oil)

---

## Success Criteria

1. **Regime accuracy:** Regime detector correctly identifies >60% of intervention periods (validated against known SPR releases and price reversions)
2. **Calibration:** Regime-adjusted Brier score beats pure GBM Brier score by >0.05
3. **Profitability:** Positive PnL after 30 days of live trading
4. **Risk:** No single position loss > 20% of oil allocation
5. **Thesis validation:** If the corridor thesis doesn't hold after 50 resolved markets (floor/ceiling broken repeatedly with no reversion), shut it down — the thesis was wrong
