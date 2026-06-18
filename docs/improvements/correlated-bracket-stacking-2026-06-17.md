# Correlated Bracket Stacking — Loss Analysis 2026-06-17

**Status:** Under review — proposed fix deferred to 2026-06-19 (#4 verdict + #11 sizing decision)
**Related follow-ups:** #11 (sizing re-decide), #4 (80% verdict)

## What happened

Two events where the bot simultaneously entered **two correlated positions on adjacent brackets of the same event**, and the temperature ran to the higher bracket, causing both legs to lose.

### KMIA Jun 15 — combined loss −$56.08

Both entered between 17:09Z–17:13Z (1:09–1:13pm ET) on `KXHIGHMIA-26JUN15`:

| Signal | Side | Entry | Contracts | Loss | Obs at entry |
|--------|------|-------|-----------|------|-------------|
| `confirm_yes` YES on "93-94°" | YES | 80¢ | 25 | −$20.00 | 93.2°F, `postPeakCollapse=false` |
| `confirm_no` NO on ">94°" | NO | 82¢ | 44 | −$36.08 | 93.2°F, `postPeakCollapse=false` |

**Actual:** Miami high exceeded 94°F → YES on "93-94°" settled NO, NO on ">94°" settled YES.

Model corrected ensemble mean: **94.37°F** — sitting at the bracket boundary. Both market prices (80¢ / 82¢-for-NO) independently cleared the confirm threshold. The per-event exposure cap (`max_event_exposure_pct_of_balance=0.15`) allowed both since each leg individually fit within the cap.

Confidence-scaled pct sizing produced 25 + 44 contracts. Under old flat-$5 sizing these would have been ~$6 + $10 = −$16 combined vs −$56.

### KDEN Jun 12 — combined loss −$43.59

Both entered on `KXHIGHD-26JUN12`:

| Signal | Side | Entry | Contracts | Loss |
|--------|------|-------|-----------|------|
| `confirm_yes` YES on "88-89°" | YES | 88¢ | 21 | −$18.48 |
| `confirm_no` NO on "90-91°" | NO | 81¢ | 31 | −$25.11 |

**Actual:** Denver hit 90-91°F → both lost. KDEN is now disabled, so this specific station won't recur.

## Root causes

1. **Adjacent bracket confirmation treated as independent:** When the market prices two adjacent brackets above the 80¢ confirm threshold simultaneously (YES on bracket N and NO on bracket N+1 each above 80¢), the confirm pathway enters both. But they're perfectly anti-correlated — if the temp lands in the higher bracket, **both lose**.

2. **Pre-peak entry with boundary-straddling model:** Both KMIA signals fired with `postPeakCollapse=false`. The corrected model mean (94.37°F) straddled the bracket boundary, giving the model genuine uncertainty between the two brackets. Entering before peak obs resolves that uncertainty means entering during maximum model confusion.

3. **Per-event cap permits simultaneous stacking:** The 0.15× balance cap was designed to limit exposure on a single event. It correctly blocked a *third* leg via the `already hold` gate, but the two-leg stack fit within it.

4. **Pct sizing amplified dollar damage:** With the pct-size feature active, correlated losses are proportionally larger — a correct design for single well-diversified bets, but it amplifies the downside when two positions are corelated.

## Prevention options

### Option A — Adjacent bracket mutual exclusivity (recommended)

Before entering a confirm signal on bracket N of event E on date D, check if any open or recently-placed position exists on bracket N±1 of the same event. Block if so.

Logic: "if we already bet the temperature is in range X, don't also bet it's NOT in the adjacent range above X."

- Surgical: doesn't affect non-adjacent brackets or unrelated events
- Catches both the KMIA and KDEN patterns
- Requires a bracket-adjacency concept (already implicit in the B-number / bracketLow / bracketHigh fields)

### Option B — argmax-only per event

On a given event+date, allow only the single highest-confidence bracket position. If the bot would enter two brackets, it takes only the more confident one.

- Simpler logic
- May miss legitimate multi-bracket entries on events where non-adjacent brackets are independently strong
- More conservative than needed (blocks non-adjacent stacking which may be fine)

### Option C — Require `postPeakCollapse` before bracket confirms

Add `postPeakCollapse=true` as a prerequisite for `confirm_yes`/`confirm_no` on temperature brackets. Ensures the daily temperature peak is already observed before committing.

- Would have blocked **both KMIA Jun 15 entries** (both had `postPeakCollapse=false`)
- Reduces volume on legitimate pre-peak confirms (where the model is already confident)
- Stronger than needed as a correlated-stacking fix specifically; better framed as a general "wait for peak" policy

### Option D — Lower per-event exposure cap

Reduce `max_event_exposure_pct_of_balance` from 0.15 to something like 0.10. This limits the combined dollar exposure from any single event.

- Blunt instrument — also limits single-leg entries on high-confidence events
- Doesn't address the adjacency correlation, just limits damage
- Best as a complement to A or B, not a standalone fix

## Decision

Deferred to **2026-06-19** alongside follow-up #4 (80% verdict) and #11 (pct-sizing re-decide). The primary questions:

1. Implement Option A (adjacent bracket guard) before or after the #4 verdict?
2. Adjust `max_event_exposure_pct_of_balance` (0.15 → lower) alongside?
3. Does the amplified volatility from pct-sizing change the #11 verdict?

Two documented events (KDEN Jun 12, KMIA Jun 15) with combined loss −$99.67 vs an estimated ~$26 under flat sizing.
