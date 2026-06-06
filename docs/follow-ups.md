# Follow-ups — deferred checks with due dates

Decisions we deliberately postponed until data exists. **Check the Due column at the start of every working session**; when an item comes due, run its check, record the outcome inline (✅/❌ + one line + date), and either act or set a new due date. Items here are *scheduled judgments*, not bugs or backlog — those live in [`improvements/`](improvements/) and the issue-shaped sections of [`spec.md`](spec.md).

The regime boundary for all measurements is **2026-06-05T20:00Z** (first trade after the win-rate-80 redirection). The `wins` REPL command defaults to it.

| # | Due | Item | Check | Decide |
|---|-----|------|-------|--------|
| 1 | 2026-06-07 | CLI exact actuals flowing | `SELECT actual_source, COUNT(*) FROM weather_forecasts WHERE actual_value IS NOT NULL AND fetched_at >= '2026-06-06' GROUP BY 1` — expect `cli` rows after tonight's settlements; `grep "ground-truth health" logs/bot.log` stays ~100% | If no `cli` rows: debug `getCliReport` (office mapping / product retention) before bias quality degrades |
| 2 | 2026-06-09 | Confirmation pathway, first ~10 settled | `wins summary` + `wins by_path` — expect ≥80% on the confirmation arm; verify NO exit churn: `SELECT COUNT(*) FROM orders o JOIN signals s ON o.signal_id=s.id WHERE o.action='sell' AND s.recommendation LIKE 'confirm%' AND o.created_at >= '2026-06-06T18:00'` ≈ 0 (only conviction-floor/stop-loss sells expected) | If churn reappears: exit policy regression. If win rate <70% on n≥10: re-examine `confirmation_min_market_conviction` (0.80 → 0.85) |
| 3 | 2026-06-12 | Enable ultra-sniper? | 3+ clean days of: HRRR in every sniper-window sourceMix, obs anchor active (`postPeakCollapse` in afternoon traces), no data-quality skips spiking (`wins by_gate`: `hrrr unavailable` + `obs stale` families near 0) | If clean: set runtime `ultra_sniper_horizon_hours=4`. Watch the next 3 days' contrarian entries it admits |
| 4 | 2026-06-19 | **The 80% verdict** (≥30 settled trades or 2 weeks) | `wins summary` — the program's pass/fail line; `wins by_gate` for any family flipped to ⚠ COSTING; `wins by_confidence` — is the new formula monotonic? | ≥80%: bump `confirmation_bet_size_cents` 500→1000, start the live-capital conversation. 70–80%: tune the worst gate family, re-run 2 weeks. <70%: full re-audit (estimator traces on every loss) |
| 5 | 2026-06-19 | N12: entry-hour re-cut | `wins by_hour` — does the old 18–20Z deficit survive the obs anchor + new regime? | Persistent deficit with n≥5/bucket: add an hour gate. Otherwise close N12 permanently |
| 6 | 2026-06-19 | Prior weights were tuned on broken-geometry data | `historical_prior_weight=0.5` and `market_prior_weight=0.3` were set when hit rates / calibration ran on half-width brackets. Re-cut: model-vs-market Brier on new-regime signals (calibration view), and `historicalPriorBlend` trace impact on wins vs losses | If the post-fix model is closer to the market than the old Brier gap suggested: consider lowering `market_prior_weight` base (more independent signal) and re-validating `historical_prior_weight` against clean-era hit rates |
| 7 | 2026-06-19 | Disabled stations (KORD/KLAX/KNYC) probation | Their contrarian stream is frozen (health gate can't re-enable on silence — documented N9 caveat). Their *model quality* post-fixes is unknown: compare their skipped-signal would-win rates (`wins by_gate` is global; query per-station: signals × markets where station blocked) | If blocked-signal would-win < 40% at a station: keep disabled. If ~50%+: give it a 1-week probation re-enable and let the auto gate judge from real trades |
| 8 | 2026-06-19 | Sigma floor binding rate | `SELECT COUNT(*) FROM signals WHERE created_at >= '2026-06-05T20:00' AND json_extract(reasoning,'$.sigmaFloorApplied') IS NOT NULL` vs total — with CLI-exact actuals cleaning stdBias, the floor should bind less over time | Binding >50%: empirical sigma still collapsing — investigate. Binding <5%: floor is dead weight, consider removing the knob at next cleanup |
| 9 | weekly | Gate health sweep | `wins by_gate` — 30 seconds | Any family ⚠ COSTING with n≥10 is the next tuning target |
| 10 | when #4 passes | Precip/snowfall expansion | Before enabling: audit their settlement semantics from titles/rules (Finding 11 class — do NOT trust the legacy parse), then per-category bias rows | Separate plan doc; deliberately out of scope until `high_temp` proves ≥80% |

## Scheduled automation

A daily Claude Code cron task (8:53am local) sweeps this file, runs due checks against the local DB, and acts under **full autonomy** within hard guardrails (never `dry_run=false`, never delete data, never new market categories; alarming findings lead the report). Set up 2026-06-06.

**The task is session-bound** (Claude Code's scheduler doesn't persist to disk in this environment) — it dies with the Claude session. Re-arm in any new session by calling `CronCreate` with `cron "53 8 * * *"`, `recurring: true`, and this canonical prompt:

> [Scheduled daily follow-ups check — kalshi-bot]
>
> You are running the scheduled morning follow-ups sweep for the Kalshi climate bot. Work from /Users/elijah/projects/kalshi-bot. You have FULL AUTONOMY within the guardrails below — the user (Elijah) pre-authorized acting on due items without asking.
>
> 1. Read docs/follow-ups.md. Compare each row's Due column to today's date (also handle "weekly" rows by checking the Log for the last sweep ≥7 days ago).
> 2. For every due/overdue item, run its exact Check (sqlite3 against ./data/kalshi-bot.db, log greps, or the `wins` command logic — you can run the REPL handlers via `bun -e` imports as needed). The live DB is at ./data/kalshi-bot.db; bot logs at logs/bot.log; the regime boundary for all measurement is 2026-06-05T20:00Z.
> 3. ACT when a row's Decide criteria are unambiguously met — including runtime_config changes (INSERT/UPDATE on the runtime_config table, e.g. enabling ultra_sniper_horizon_hours=4, bumping confirmation_bet_size_cents, station probation via disabled_stations). When data is insufficient or the call is ambiguous, do NOT act: record findings and push the Due date forward instead.
> 4. GUARDRAILS (override everything): never set dry_run=false (going live is a human decision); never delete data or rewrite history; never expand to new market categories; if any check reveals something alarming (rolling win rate collapsing, ground-truth health < 90%, exit churn returning, HRRR absent from sniper-window sourceMix), lead your response with a loud ⚠ summary before anything else.
> 5. Record every outcome in docs/follow-ups.md's Log section (newest first: date, item #, ✅/❌, one line, action taken or deferred-to date), update Due dates for re-checks, and per CLAUDE.md: run `bun test` and only commit + push if green. Keep changelog entries only for actual algorithm/config changes you made (per its rules).
> 6. Self-perpetuation: this cron task auto-expires 7 days after creation. Run CronList; if this daily task is missing or within 2 days of expiry, re-create it with CronCreate (recurring: true, cron "53 8 * * *") passing THIS ENTIRE PROMPT verbatim. Note the re-arm in your summary.
> 7. End with a compact status: items checked, actions taken, anything due soon, and the current `wins summary` line vs the 80% target.

## Log

Record outcomes here as items close (newest first):

- *(none yet)*

---

*Created 2026-06-06 at the close of the win-rate-80 build phase ([`win-rate-80-plan`](improvements/win-rate-80-plan-2026-06-05.md) + [`addendum`](improvements/win-rate-80-addendum-2026-06-05.md) fully shipped). The bot is in measurement mode; this file is what keeps the measurements honest.*
