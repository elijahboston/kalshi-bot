# Return Maximization — 2026-06-22

**Type:** Strategy roadmap  
**Status:** Active — decisions pending 06-26  
**Related:** `follow-ups.md` (#4/#7/#11), `algorithm-changelog.md`, `forecast-sharpening.md`

---

## Baseline

All figures from the pct-sizing regime (Jun 10–22), confirmation pathway only, settled trades.

| Metric | Value |
|---|---|
| Win rate | 85.3% overall (88.2% excl. Jun 21 bug trades) |
| Confirmed trades | 82 clean (excl. Jun 21 side-flip incident) |
| Avg entry price | 84.4¢ |
| Breakeven win rate | 84.4% (= avg entry price) |
| **Edge** | **3.8 pp above breakeven** |
| Avg win P&L | +$4.44 per trade |
| Avg loss P&L | −$24.84 per trade |
| Avg trade cost | $23.70 |
| Trades/day (recent) | ~7 confirmation entries |
| Paper balance | ~$462 |
| Regime P&L | +$45.83 (post Jun-21 bug) |

**Kelly fraction (theoretical):** `f* = (0.882 × 0.187 − 0.118) / 0.187 = 28%` per trade.  
Current sizing is ~7% per trade — roughly quarter-Kelly.

---

## The Compounding Constraint

The edge at 84.4¢ avg entry is narrow: **3.8 pp above breakeven**. That makes the compounding growth rate extremely sensitive to win rate:

| Win rate | Daily edge | Weekly | Monthly (compounded) |
|---|---|---|---|
| 88.2% (clean) | ~1.0% | ~7% | ~35% |
| 86.5% | ~0.5% | ~3.5% | ~16% |
| **85.3% (current)** | **~0.2%** | **~1.4%** | **~6%** |
| 84.4% (breakeven) | 0% | flat | flat |

The Jun 21 side-flip bug dragged win rate from 88.2% → 85.3%. With the fix shipped (2026-06-22), the forward expectation is back to ~88%. **Every percentage point of win rate is worth more than any other lever.**

---

## Levers, Ranked by Impact

### 1. Live capital — the 10–100× multiplier

The bot runs on $500 of paper money. All return figures scale linearly with capital until liquidity constraints (~$5k–$10k balance where position sizes start moving thin markets).

| Seed capital | Weekly (at 88% win rate, current sizing) | Monthly | Year 1 |
|---|---|---|---|
| $500 (current paper) | ~$50 | ~$210 | ~$5k–$7k |
| $1,000 | ~$100 | ~$420 | ~$10k–$14k |
| $2,500 | ~$250 | ~$1,050 | ~$25k–$35k |
| $5,000 | ~$500 | ~$2,100 | liquidity-capped |

**Gate:** Follow-up #4 cleared (86.1% ≥ 80% gate, pnl > 0). Live capital is Elijah's decision.  
**Risk:** Real money. Scaling to $1k+ requires confidence that the bug backlog is clear — the adjacent-bracket guard (06-18) and side-flip fix (06-22) were the two known issues. No known open bugs as of 06-22.

---

### 2. Sizing increase to half-Kelly — the 2× daily multiplier

Current per-trade sizing (~7%) is conservative quarter-Kelly. Raising to half-Kelly (~14%) approximately doubles daily returns without materially increasing ruin risk.

**Kelly math for portfolio of simultaneous bets:**  
With 7 correlated trades/day, full 28% Kelly per trade would deploy ~196% of bankroll — impossible. The correct multi-bet Kelly approximation targets 50% total exposure divided across simultaneous positions: 50% / 7 ≈ 7%. Half that total (50%) = 14% per trade.

Current config: `max_exposure_pct_of_balance=0.12`, `max_event_exposure_pct_of_balance=0.15`.

**Proposed change (06-26):**  
Raise `confidence_size_max_pct` (the ceiling on the pct-based sizing within a confidence bucket) to allow the top confidence bucket (≥95%) to deploy up to 14% per trade. Lower buckets remain capped at their current levels.

| Config | Current cap | Proposed cap | Rationale |
|---|---|---|---|
| 0.80–0.90 confidence | ~7% | 7% | Keep — win rate 85%, thin edge |
| 0.90–0.95 confidence | ~8% | 10% | Slight raise — 87.5% win rate |
| ≥0.95 confidence | ~10% | 14% | Raise — 95.8% win rate, safe to size up |

**Gate:** 1 more week of bracket guard data (06-18 → 06-26). No new bugs in that window. See follow-up #4.

**Risk:** The 21Z / KDEN-tainted flags. Ensure those trades are excluded from the ≥0.95 bucket or that the bucket is genuinely clean before raising.

---

### 3. Station rehabilitation — proportional volume increase

Active stations: KAUS + KMIA (2 stations). Disabled: KDEN, KORD, KLAX, KNYC.

| Station | Win rate | n | PnL | Status |
|---|---|---|---|---|
| KMIA | 90.9% | 22 | +$59.54 | ✅ Active — best station |
| KAUS | 85.7% | 49 | +$5.29 | ✅ Active — volume engine |
| KDEN | 81.8% | 11 | −$7.80 | 🔴 Disabled — below breakeven |
| KORD | — | — | — | 🔴 Disabled — probation |
| KLAX | — | — | — | 🔴 Disabled — probation |
| KNYC | ~11% would-win | — | — | 🔴 Disabled — far below breakeven |

Adding one healthy station at KMIA-level performance would add ~$3–5/day at current sizing. Three rehabilitated stations would add ~$9–15/day.

**Gate for KORD/KLAX:** Achieve 84.4%+ would-win rate on ≥10 confirmation signals in shadow mode (not yet met — follow-up #7, due 06-26).  
**KNYC:** 11% would-win — do not re-enable.  
**KDEN:** 74.2% — do not re-enable until would-win rate exceeds breakeven in shadow.

---

### 4. Entry quality: lower max entry ceiling

Current max entry: 88¢ (`confirmation_max_entry_price=0.88`).

**Performance by entry bucket (pct era, settled, 82 trades):**

| Entry range | n | Win rate | Total PnL | PnL/trade |
|---|---|---|---|---|
| 80–85¢ | 40 | 85.0% | +$42.82 | **+$1.07** |
| 85–88¢ | 42 | 88.1% | +$14.21 | **+$0.34** |

The 85–88¢ band has *higher* win rate but much lower PnL per trade. Why: at 87¢, a win returns only 13¢/contract; at 82¢, a win returns 18¢/contract. The market is pricing those 85–88¢ entries close to fair value — the edge is real but thin.

**Proposed:** Lower `confirmation_max_entry_price` to 0.85, cutting the thin-edge trades. This sacrifices ~half the trade volume but roughly doubles PnL per trade. Net effect depends on how many of the 85–88¢ trades are genuinely high-conviction vs. the model being overconfident.

**Counter-argument:** The 88.1% win rate in the 85–88¢ bucket is real edge. Cutting it reduces total PnL unless the freed capital compounds faster. Model before changing.

**Gate:** Need n≥50 in each bucket after the bug period clears. Current n=40/42 is borderline — defer to 06-26 for analysis.

---

### 5. Scout exit policy — stop giving back winners

The scout exit fires when market price reverses against the held position, locking in a loss before settlement. In theory: cuts losers early. In practice: sometimes exits correct positions at the wrong time.

**Jun 21 evidence (B94.5):**
- Scout exited correct NO @ 49¢ → NO settled at 100¢ → cost: −$21 vs holding
- Scout exited correct NO on B92.5 @ 56¢ → NO settled at 0¢ → saved: +$18 vs holding

Net scout impact: unknowable without full accounting, but at least one of the Jun 21 exits was clearly wrong.

**Three options:**
1. **Raise scout exit threshold** — only exit if the reversal exceeds X% (reduces premature exits)
2. **Hold to settlement for high-confidence entries** — if initial confidence ≥ 0.90, no exit
3. **Disable scout exit** — always hold to settlement (simplest; matches how PnL is measured)

Option 3 is the lowest-risk starting point. The bot's edge comes from entry selection, not exit timing. Every early exit that turns out wrong permanently destroys a winner. Holding to settlement removes the exit-timing risk entirely and makes P&L predictable.

**Action:** Analyze full scout exit P&L (wins saved vs. winners exited early). If net negative, disable.

---

### 6. Compound reinvestment discipline

The compounding effect is the primary return engine. At 1%/day compound growth:

| Period | $500 | $1,000 | $5,000 |
|---|---|---|---|
| 1 month | $648 | $1,295 | $6,476 |
| 3 months | $1,083 | $2,166 | $10,830 |
| 6 months | $2,345 | $4,690 | $23,450 |
| 1 year | $11,009 | $22,017 | $110,085 |

At 0.5%/day (more conservative estimate):

| Period | $500 | $1,000 |
|---|---|---|
| 1 month | $576 | $1,152 |
| 3 months | $762 | $1,524 |
| 1 year | $3,297 | $6,595 |

**Rules:**
- Never withdraw profits until the account exceeds 2× the initial deposit — let compounding work
- If win rate drops below 85% for 3 consecutive days, pause and diagnose before continuing
- At $5k+ balance, the pct-based sizing naturally scales position sizes; no manual intervention needed

---

## Combined Scenario: Current vs. Optimized

Assumptions: 88% win rate, 7 trades/day, $1,000 seed, full reinvestment.

| Scenario | Sizing | Stations | Monthly | Year 1 |
|---|---|---|---|---|
| **Current (paper)** | 7% | KAUS + KMIA | ~$420 | ~$10k |
| **+ Half-Kelly sizing** | 14% top bucket | KAUS + KMIA | ~$750 | ~$25k |
| **+ KORD or KLAX rehab** | 14% | 3 stations | ~$1,100 | ~$40k |
| **+ All healthy stations** | 14% | 4–5 stations | ~$1,800 | liquidity-capped |

The liquidity ceiling is ~$10k–$15k balance for the KAUS/KMIA market depth. Above that, position sizes start moving prices. Practical year-1 cap from $1k seed: **$15k–$25k**, depending on market depth and win rate stability.

---

## Risk Controls to Maintain

These guardrails must stay in place as sizing and capital increase:

| Control | Current value | Why it stays |
|---|---|---|
| Adjacent bracket guard | enabled | Prevents the −$100 stacking pattern |
| `max_event_exposure_pct_of_balance` | 0.15 | Correlated legs of same event must not stack |
| Daily loss circuit breaker | not yet implemented | **Should add:** if balance drops >15% in one day, pause |
| `dry_run` | true until live capital deposited | Hard gate |
| Station edge surcharges | KORD/KLAX +15% threshold | Bad-data stations need higher bar |

**Missing control — daily loss circuit breaker:** The Jun 21 bug cost ~$100 on a single ticker in a single day. No circuit breaker existed. Add a knob: `max_daily_loss_pct` (suggested: 15% of balance). If the bot exceeds this, it writes a `.sweep-paused` sentinel for the rest of the day.

---

## Recommended Sequence

| When | Action | Expected impact |
|---|---|---|
| **Now** | Analyze full scout exit P&L | Baseline for exit policy decision |
| **06-26** | Raise `confidence_size_max_pct` to 14% at ≥0.95 bucket | +50–80% daily returns on high-confidence trades |
| **06-26** | Re-check KORD/KLAX probation would-win rates | Unlock 1–2 more stations if ≥84.4% |
| **06-26** | Add `max_daily_loss_pct` circuit breaker | Prevent single-day blowups |
| **07-06** | Evaluate entry price ceiling (85¢ vs 88¢) | n≥50 per bucket, decide after |
| **After 06-26 sizing is validated** | Live capital deposit (Elijah's call) | 10–100× return multiplier |
| **At $2k+ balance** | Evaluate additional event types | Volume diversification |
