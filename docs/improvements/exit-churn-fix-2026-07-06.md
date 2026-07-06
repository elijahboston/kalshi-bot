# Exit-churn fix — 2026-07-06

## Symptom

"We win a majority of positions but the losers eat the profits, keeping us
break-even." True at the account level: new-regime **realized round-trip P&L =
−$54.60** (`calibration`, `traded=1`, `resolved_at ≥ 2026-06-05`), while the
`wins` scoreboard reads **84.9% (n=172)**.

## Diagnosis — three layers of accounting

The 84.9% is *settle-assumed* (each filled buy scored as if held to
settlement; early exits deliberately ignored — see `wins.ts`). It measures
**entry quality**, and entries are good:

| view | win rate | net P&L (new regime) |
|---|---|---|
| Settle-assumed (`wins`, hold to settlement) | 84.9% | **+$153** |
| Realized round-trip (`calibration`) | 67% | **−$55** |

The entire ~$200 gap is **premature exits**. Matching entry trades to exit
(`sell`) trades on settled markets, new regime:

- **49 positions were exited early; 32 (65%) would have won at settlement.**
- Realized exit P&L **−$375.31** vs **−$75.78** if held → **exits cost $299.53.**
- On the 32 would-be winners, holding recovers **+$488**; on the 17 true
  losers, holding gives back **−$189**. Net strongly favours holding.

Root cause in `exit-eval.ts`: confirmation positions (the bulk of trades, ~85¢
entries) run a **stop-loss at 25% drawdown with no edge gate** plus a
**conviction-floor bail at 60¢**. An 85¢ entry trips the stop at ~64¢ / the
floor at 60¢ — but Kalshi binaries swing hard intraday and mostly recover to
100¢, so the exits dump winners right before they pay. The exit tuning is stale
relative to the post-geometry-fix entries (the code's own earlier
counterfactual once showed exits net-positive; that has flipped).

## Backtest (40 confirmation positions exited, new regime)

Modelled trigger `T = max(entry×(1−stop_loss_pct), floor)`; exit at `T` if the
observed low reached it, else hold to settlement.

| scenario | net P&L | vs actual |
|---|---|---|
| Actual (realized) | −$399.89 | — |
| Current thresholds, clean execution | −$231.81 | +$168 |
| **Moderate** (stop 0.45, floor 0.45) | **−$20.60** | **+$379** |
| Aggressive (stop 0.70, floor 0.30) | −$94.17 | +$306 |
| Hold everything to settlement | −$84.88 | +$315 |

**Moderate wins outright** — it holds through shallow dips (recovers the dumped
winners) yet still catches genuine collapses at ~45¢ (caps the true-loser
tail), so it beats both Aggressive and hold-all, which let real losers ride to
near-total loss.

## Change shipped

Applied via `bun ops set` (attributed, `dry_run` stays true; bot re-reads
`runtime_config` each tick):

- `stop_loss_pct` 0.25 → **0.45**
- `confirmation_exit_conviction_floor` 0.60 → **0.45**

No code change — both keys were on env/code defaults and are now DB overrides
read by `packages/config` `KNOB_MAP`.

## Two secondary findings (follow-ups #14/#15)

1. **The exit-churn monitor (#2) is blind.** Its check joins `sell` orders to
   `confirm%` signals, but `executeExit` orders don't carry the entry's
   `signal_id` — so it returned ~1 while **72 real sells** occurred. Churn was
   invisible to the very check meant to catch it. Fix: count sells directly /
   via position `entryKind`.
2. **Exit-execution slippage ~$168/regime.** Realized (−$399.89) is $168 worse
   than the same thresholds executing cleanly at trigger (−$231.81): stops
   filled at 37–48¢ when the trigger was ~60–63¢. Leaks even at optimal
   thresholds — separate fix (exit tick cadence / marketable-limit exit).

## Caveats

One regime, 40 confirm positions. The sim assumes clean trigger execution
(reality is worse — hence finding #2) and that a position sold early would not
have fallen further post-exit (safe for the recovered winners; Moderate catches
the losers at the trigger regardless). Validate on settled positions opened
after 2026-07-06 (follow-up #14, due 2026-07-13).
