# Confirmation tightening — 2026-06-10

Full algorithm + data review of the new regime (since `REGIME_BOUNDARY_ISO`,
2026-06-05T20:00Z), looking for win-rate/accuracy improvements beyond the
2026-06-05/06 redirection. Canonical scoreboard at review time (filled buys ×
settled markets, the `wins` methodology, fee-free at the time):

- **39 settled trades, 92.3% win rate, +$12.20 — every one via the confirmation
  pathway.** Zero contrarian trades have fired post-regime.
- All 3 losses: KDEN confirmations at 87/90/93¢ (two of them the same event,
  KXHIGHDEN-26JUN06 — YES B92.5 @93 + NO B90.5 @87, one bracket-miss thesis
  that lost both legs).
- Gate attribution (`wins by_gate` method): blocked contrarian signals claiming
  10–28¢ model edge would have won only **0–30%** — the model is still
  anti-predictive vs the market; the entry gates are working as containment.
  Contra-market 11.8% would-win, obs-stale 0/5, tail 0/6: all saving money.
  Two exceptions: `already hold` 87.1% (benign — winners we already own) and
  **`recent-loss` 80% would-win (12/15) — that gate was costing money** (see
  change 3).

## Evidence → changes

### 1. `confirmation_max_entry_price` 0.93 → 0.88 (config, `ops set`)

Win rate and PnL by entry-price band (post-regime confirmations):

| band | n | wins | win% | pnl |
|------|---|------|------|-----|
| 90–93¢ | 14 | 12 | 85.7% | **−$4.00** |
| 85–89¢ | 13 | 12 | 92.3% | +$3.80 |
| 80–84¢ | 12 | 12 | 100.0% | +$12.40 |

At ≥90¢ the breakeven win rate ≈ the price itself (~92% at the 91.5¢ band
average, ~93% after taker fees) and the model-agreement filter (est ≥ 0.50)
adds essentially no selection there — EV ≈ 0 minus fees, and observed 85.7%
is below breakeven. At ≤88¢ the minimum payoff is 12¢ → breakeven 88%
(~89% fee-adjusted) vs the pathway's observed 92.3%. n=14 caveat acknowledged;
the calibration argument (the market is nearly perfectly calibrated at these
prices — see `project_market_calibration`) says the same thing independently.

### 2. Per-event exposure cap (`max_event_exposure_pct_of_balance`, new knob)

Every traded event got 2–4 confirmation entries (NO on adjacent brackets + YES
on the center bracket = one thesis expressed 2–4×). The per-ticker cap
(`max_exposure_pct_of_balance=0.12`) can't see the correlation, so one event
could put ~24–48% of balance behind a single forecast; a 1-bracket miss loses
multiple ~90¢ legs at once (exactly the 06-06 KDEN pair, −$9.00 of the −$9.35
total losses).

Implementation: `app/execution/services/execution.ts` — after the per-ticker
exposure check, sum `positions.cost_basis` joined to `markets.event_ticker`
for the signal's event; skip at the cap, size down to fit otherwise. Knob in
`packages/config/src/index.ts` (`max_event_exposure_pct_of_balance`), ships
dark (0 = disabled), enabled at **0.15** via `ops set`.

### 3. Recent-loss re-entry guard: confirmation exemption (code)

The guard required `edge ≥ 1.5 × edgeThreshold` (= 30¢) to re-enter after a
loss exit. Confirmation signals have model edge ≤ 0 **by construction**, so the
bar was unsatisfiable — one conviction-floor exit permanently locked the ticker
for the 2h loss window even when the market's conviction recovered. Post-regime
data: 12/15 recent-loss-blocked signals would have won. Confirmations now skip
the elevated-edge test (their re-entry bar is the confirmation gate itself
re-firing: conviction ≥ 0.80 and price ≤ cap); contrarians keep the 1.5× bar;
the time-based cooldown still applies to both.

### 4. Fee-true PnL (`takerFeeCents`, code)

Kalshi's taker fee — `ceil_to_cent(0.07 × C × P × (1−P))` ≈ 0.5–0.8¢/contract
at confirmation prices — was modeled nowhere (the `evaluateConfirmation`
docstring admitted "fees can erase it" but nothing enforced it). At a ~13¢
average gross win that's ~6% of profit, and it flips the ≥90¢ band decisively
negative.

- `@kcb/shared` → `takerFeeCents(priceCents, contracts)` (integer arithmetic,
  exact-cent safe).
- `computePerSidePnl` (reconciliation) deducts the fee per fill → flows into
  `calibration.realized_pnl` → the paper balance no longer overstates.
- `wins` scoreboard `pnlCents` deducts the entry fee → **the #4 80%-verdict
  (due 2026-06-19) is judged on fee-true numbers.**

## Explicitly NOT changed

- **Contrarian path stays dark.** Its gates (contra-market, disagreement cap,
  coin-flip zone) all show would-win rates far below breakeven on the blocked
  side. Revisit only with the #6 prior-weight re-cut (due 06-19).
- **No station re-enables** (#7 probation runs 06-19; station-health-blocked
  sample n=10 is inconclusive).
- **KDEN keeps trading** — changes 1+2 would have prevented or halved its
  losses; per-station mechanisms only if it still bleeds (follow-up #12,
  due 06-17).

## Follow-ups opened

- **#12 KDEN post-tightening watch** (2026-06-17)
- **#13 Obs-certainty gate exemption audit** (2026-06-19): running-max-settled
  outcomes (upper tail crossed / NO below running max) are model-prob ~1.0 but
  can be blocked by the disagreement cap as if they were model noise — measure
  before adding an exemption.
