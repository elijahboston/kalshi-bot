# Research: Always Betting NO Strategy Analysis

Analysis date: 2026-04-13
Dataset: 958 resolved markets, 2,268 trades, 46 trading days (2026-02-20 to 2026-04-06)

---

## Background

Kalshi climate markets use bracket structures (e.g., "Will Chicago's high be 70-71F?"). For each event, there are typically 5-6 brackets. Exactly one resolves YES; all others resolve NO. This means ~83% of markets structurally resolve NO. This analysis asks: can we profit by simply betting NO on everything?

## Market Resolution Distribution

### By distinct markets traded:

| Resolution | Markets | % |
|---|---|---|
| YES | 100 | 31.8% |
| NO | 214 | 68.2% |
| **Total** | **314** | |

### By contract volume (buy side):

| Resolution | Contracts | % |
|---|---|---|
| YES | 4,493 | 47.1% |
| NO | 5,048 | 52.9% |
| **Total** | **9,541** | |

### Across all resolved markets in DB (including untraded):

| Resolution | Markets | % |
|---|---|---|
| YES | 122 | 18.0% |
| NO | 555 | 82.0% |

The 82/18 split matches the structural expectation of ~1 YES per 5-6 bracket event.

## Simulation: $100/Day Blind NO

Starting with $100, betting $100/day evenly across all markets as NO contracts. Prices estimated from actual trade data where available, fair-value estimates elsewhere.

**Result: $100 grew to $301.83 over 46 days (+201.8% return)**

| Metric | Value |
|---|---|
| Starting balance | $100.00 |
| Final balance | $301.83 |
| Total P/L | +$201.83 |
| Total wagered | $3,832 |
| Total payouts | $4,034 |
| Return on wagered | 5.3% |
| Win rate (markets) | 82.5% |
| Peak balance | $301.83 |
| Worst drawdown | $50.50 (day 1, only 2 markets) |

The strategy was profitable on 43 of 46 days. The 3 losing days had few markets (high variance per-bet).

## Does Weather Data Help a NO Strategy?

### Calibration: predicted YES probability vs actual outcomes (real market prices, excluding default 0.50)

| Strategy | Markets | Win % | Profit (1 contract each) | ROI |
|---|---|---|---|---|
| Blind NO on all | 677 | 82.0% | $5.15 | 0.9% |
| Filter: pred YES < 5% | 325 | 85.8% | $3.46 | 1.3% |
| Filter: pred YES < 10% | 469 | 82.9% | $2.94 | 0.8% |
| Filter: positive EV only | 287 | 57.8% | $1.70 | 1.0% |
| Filter: pred < 5% AND positive EV | 207 | 77.8% | $2.24 | 1.4% |

Weather data provides marginal ROI improvement (0.9% to 1.4%) but reduces absolute profit by shrinking the bet pool. The filtering mostly removes bets that were already near-certain winners.

### Can we identify which bracket resolves YES to skip it?

| Method | Top-1 Accuracy |
|---|---|
| **Market prices** (highest YES price) | **93.7%** |
| Our weather model (highest predicted prob) | 24.4% |
| Market top-2 contains YES | 100.0% |
| Our model top-2 contains YES | 47.5% |

**The market is 4x better than our model at identifying the YES bracket.** Market prices encode information from all participants, including those with better models and more timely data.

## Optimal NO Strategy: Skip the Market Favorite

The best NO-only approach uses market prices, not weather data, to eliminate the likely YES bracket:

| Strategy | Bets | Win % | Profit | ROI |
|---|---|---|---|---|
| A: Blind NO on everything | 677 | 82.0% | $5.15 | 0.9% |
| **B: Skip market's #1 YES pick** | **550** | **99.5%** | **$6.73** | **1.2%** |
| C: B + weather filter (<20%) | 494 | 99.4% | $5.38 | 1.1% |
| D: Skip market's top-2 YES picks | 423 | 100.0% | $4.81 | 1.2% |

**Strategy B is optimal:** skip the bracket with the highest YES price, bet NO on all the rest. This achieves 99.5% win rate and the highest absolute profit. Adding weather filtering (Strategy C) actually hurts by removing profitable bets.

Strategy D (skip top-2) achieves 100% win rate across our entire dataset but makes fewer bets and slightly less total profit.

## Why the Edge is Thin

NO contracts on non-favorite brackets cost 97-99 cents and pay $1. The per-contract edge is 1-3 cents. This is a spread-harvesting strategy:

| NO Price | Markets | Win % | ROI |
|---|---|---|---|
| 1-19 cents (longshot NO) | 117 | 2.6% | 34.5% |
| 95-99 cents (near certain NO) | 536 | 99.8% | 0.9% |

The vast majority of NO bets fall in the 95-99 cent range. High certainty, tiny margin. Scaling requires volume, not selectivity.

## Practical Considerations

### In favor of a NO-only bot:
- Near-guaranteed returns (99.5% win rate with market-price filtering)
- Simple implementation — no weather model needed, just read the order book
- Low variance day-to-day
- Could be fully automated with minimal infrastructure

### Against a NO-only bot:
- **Razor-thin margins** — 1-2% ROI per cycle, vulnerable to fees and spread
- **Liquidity constraints** — may not be able to fill all NO contracts at listed prices
- **Capital intensive** — need large bankroll for meaningful absolute returns
- **Opportunity cost** — the real alpha in these markets is contrarian YES bets where the market is wrong about which bracket hits
- **Risk of correlated loss** — if the market's top-1 pick is wrong (6.3% of events), you lose on all brackets for that event

## Comparison: NO-Only vs Improved YES+NO Hybrid

We simulated what our ROI would be if we improved the model's bracket identification accuracy (see `docs/improvements/forecast-sharpening.md` for the full improvement plan and simulation details). The hybrid strategy buys YES on the model's top bracket pick and NO on remaining safe brackets.

| Strategy | P&L (46 days) | ROI | Requires |
|---|---|---|---|
| NO-only (skip market #1) | +$6.73 per contract-set | 1.2% | Just market prices |
| Current bot (actual) | +$93 | 3.7% | Ensemble weather model |
| **Improved hybrid (75% acc, 10h)** | **+$643** | **19.5%** | HRRR + sniper mode + empirical sigma |
| Improved hybrid (85% acc, 10h) | +$963 | 29.3% | All 5 forecast sharpening improvements |

The NO-only strategy is a safe floor (~1% ROI, 99.5% win rate) but the ceiling is low. The improved hybrid model delivers 6.9-10x more profit by making confident YES bets on the correct bracket at 10-12h before close, when prices are still favorable (60-73¢) but model accuracy is high enough (75-85%) to overcome the miss rate.

## Key Insight

Weather data's value is NOT in picking confident NOs. The structural NO rate (83%) and market prices already handle that. Weather data's value is in the **6.3% of events where the market is wrong about which bracket resolves YES.** A model that knows a cold front is coming (and the market doesn't) can make a high-conviction YES bet at favorable odds. That's where the real edge lives, and it's what the current bot's architecture is designed to capture — it just needs sharper forecasts (see `docs/improvements/forecast-sharpening.md`).
