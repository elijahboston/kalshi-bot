# Follow-ups — deferred checks with due dates

**When to use:** Check at the start of every working session for due deferred decisions.
**Last verified:** 2026-06-10 by Elijah Boston

Decisions we deliberately postponed until data exists. **Check the Due column at the start of every working session**; when an item comes due, run its check, record the outcome inline (✅/❌ + one line + date), and either act or set a new due date. Items here are *scheduled judgments*, not bugs or backlog — those live in [`improvements/`](improvements/) and the issue-shaped sections of [`spec.md`](spec.md).

The regime boundary for all measurements is **2026-06-05T20:00Z** (first trade after the win-rate-80 redirection). The `wins` REPL command defaults to it.

| # | Due | Item | Check | Decide |
|---|-----|------|-------|--------|
| 1 | weekly | CLI exact actuals still flowing | `SELECT actual_source, COUNT(*) FROM weather_forecasts WHERE actual_value IS NOT NULL AND fetched_at >= date('now','-2 days') GROUP BY 1` — expect a steady stream of `cli` rows (resolved 2026-06-08, see Log); `grep "ground-truth health" logs/bot.log` stays ~100% | If `cli` rows stop appearing: NWS CLI site-code mapping or product retention regressed — debug `getCliReport` |
| 2 | weekly | Confirmation pathway health (validated 2026-06-09 at n=30/90%) | `wins by_path` — confirmation arm stays ≥80%; verify NO exit churn: `SELECT COUNT(*) FROM orders o JOIN signals s ON o.signal_id=s.id WHERE o.action='sell' AND s.recommendation LIKE 'confirm%' AND o.created_at >= '2026-06-06T18:00'` ≈ 0 (only conviction-floor/stop-loss sells expected) | If churn reappears: exit policy regression — bisect against the entryKind exit policy. If win rate drops <70% on n≥10: re-examine `confirmation_min_market_conviction` (0.80 → 0.85) |
| 3 | 2026-06-14 | Ultra-sniper 3-day watch (enabled 2026-06-11) | `wins by_gate` — did ultra-sniper admit any new contrarian entries in the 21:35Z sniper window? `wins by_hour` — 21Z rate improving or still 66.7%? | If new sniper-window entries appear with win rate ≥80%: leave enabled, close item. If 21Z continues bleeding or new entries lose: consider restricting `ultra_sniper_horizon_hours` to 6+ (tighter window), or adding a 21Z pre-peak gate |
| 4 | 2026-06-19 | **The 80% verdict** (≥30 settled trades or 2 weeks) | `wins summary` — the program's pass/fail line AND pnl > 0 (at ~86¢ avg confirmation entry, breakeven win rate ≈ avg price ≈ 86% — 80% wins can still lose money; see 2026-06-07 Log); `wins by_gate` for any family flipped to ⚠ COSTING; `wins by_confidence` — is the new formula monotonic? | ≥80% AND pnl>0: bump `confirmation_bet_size_cents` 500→1000, start the live-capital conversation. ≥80% but pnl≤0: entry prices too high — consider lowering the 93¢ cap or requiring larger model-market agreement margin. 70–80%: tune the worst gate family, re-run 2 weeks. <70%: full re-audit (estimator traces on every loss) |
| 5 | 2026-06-19 | N12: entry-hour re-cut | `wins by_hour` — does the old 18–20Z deficit survive the obs anchor + new regime? | Persistent deficit with n≥5/bucket: add an hour gate. Otherwise close N12 permanently |
| 6 | 2026-06-19 | Prior weights were tuned on broken-geometry data | `historical_prior_weight=0.5` and `market_prior_weight=0.3` were set when hit rates / calibration ran on half-width brackets. Re-cut: model-vs-market Brier on new-regime signals (calibration view), and `historicalPriorBlend` trace impact on wins vs losses | If the post-fix model is closer to the market than the old Brier gap suggested: consider lowering `market_prior_weight` base (more independent signal) and re-validating `historical_prior_weight` against clean-era hit rates |
| 7 | 2026-06-19 | Disabled stations (KORD/KLAX/KNYC) probation | Their contrarian stream is frozen (health gate can't re-enable on silence — documented N9 caveat). Their *model quality* post-fixes is unknown: compare their skipped-signal would-win rates (`wins by_gate` is global; query per-station: signals × markets where station blocked) | If blocked-signal would-win < 40% at a station: keep disabled. If ~50%+: give it a 1-week probation re-enable and let the auto gate judge from real trades |
| 8 | 2026-06-19 | Sigma floor binding rate | `SELECT COUNT(*) FROM signals WHERE created_at >= '2026-06-05T20:00' AND json_extract(reasoning,'$.sigmaFloorApplied') IS NOT NULL` vs total — with CLI-exact actuals cleaning stdBias, the floor should bind less over time | Binding >50%: empirical sigma still collapsing — investigate. Binding <5%: floor is dead weight, consider removing the knob at next cleanup |
| 9 | weekly | Gate health sweep | `wins by_gate` — 30 seconds | Any family ⚠ COSTING with n≥10 is the next tuning target |
| 10 | when #4 passes | Precip/snowfall expansion | Before enabling: audit their settlement semantics from titles/rules (Finding 11 class — do NOT trust the legacy parse), then per-category bias rows | Separate plan doc; deliberately out of scope until `high_temp` proves ≥80% |
| 11 | 2026-06-16 | Confidence-scaled %-of-balance sizing, first week | Enabled in paper 2026-06-09 (`confidence_size_pct_enabled=true`, `max_exposure_pct_of_balance=0.12`, 1–10% across conf 0.80→1.0). Check: `wins summary` PnL trajectory vs the flat-$5 era; `grep "pct-size" logs/bot.log` — do realized sizes land in the expected ~3.4–9.6% band? any `at max exposure` skips (cap too tight)? max single-position drawdown sane? | If sizing is amplifying losses faster than wins (win rate unchanged but PnL more volatile and net worse): widen the floor (raise `confidence_size_floor_confidence`) or lower `confidence_size_max_pct`. If the 12% exposure cap is clipping legitimate single entries: raise it. If clean and PnL scaling positively: leave it and revisit max% at the #4 verdict |
| 12 | 2026-06-17 | KDEN post-tightening watch | KDEN owned 100% of post-regime losses (3/3, all confirmations at 87–93¢; 81.3% win vs ~87¢ breakeven; +1.8°F warm forecast bias; both 06-06 losses entered ~21Z = pre-peak Denver). The 2026-06-10 tightening (entry cap 0.93→0.88, per-event exposure cap) should contain it. Check: `wins by_station` — KDEN PnL ≥ 0 since 2026-06-10? | Still bleeding: add a per-station confirmation entry-price cap (map knob like `station_edge_surcharge`, e.g. KDEN 0.85) or require post-peak obs (`postPeakCollapse` in trace) for KDEN confirmations within 1 bracket of the running max. Clean: close |
| 13 | 2026-06-19 | Obs-certainty gate exemption (audit first) | When the running max has already settled an outcome (upper tail crossed; NO on a bracket fully below running max), the estimator correctly outputs ~1.0 — but the contrarian gates (disagreement cap 0.25, coin-flip zone) can block the trade as if it were model noise. Audit: post-regime signals where `json_extract(reasoning,'$.runningMaxClamp')` (or equivalent trace field) proves certainty AND skip_reason is a contrarian gate — how many, and what edge was left on the table? | Material count (≥5/week with ≥10¢ payoff): add an explicit obs-certainty exemption that bypasses disagreement/coin-flip gates (NOT the spread guard). Pairs with #3 ultra-sniper. Immaterial: close |

## Scheduled automation

Three daily launchd agents run in sequence. All honour the `.sweep-paused` sentinel (`bun ops pause` / `bun ops resume`).

| Time | Agent | Script | Log |
|------|-------|--------|-----|
| 8:53am | Follow-ups sweep | `scripts/follow-ups-sweep.sh` | `logs/follow-ups-sweep.log` |
| 9:55am | DB snapshot | `scripts/db-snapshot.sh` | `logs/db-snapshot.log` |
| 10:00am | Performance review | `scripts/daily-perf-review.sh` | `logs/daily-perf-review.log` |

The **snapshot** (9:55am) uses SQLite's `.backup` for a consistent copy of `data/kalshi-bot.db` → `data/snapshots/kalshi-bot-YYYY-MM-DD.db`, rotating files older than 7 days. It always runs before the review so the review has a stable reference point.

The **performance review** (10:00am) runs Claude Code headless: wins scoreboard (`summary`, `by_gate`, `by_station`, `by_confidence`, `by_hour`), weekly health checks (#1 CLI actuals, #2 confirmation churn), due follow-up items, ⚠ threshold checks, and commits any doc/config changes if tests pass.

**Operate sweeps with `bun ops`** (`status | due | knobs | history | set --why | sweep | pause | resume`).

**1. launchd install (machine-level, survives reboots & closed sessions)** — Claude cannot install LaunchAgents itself; run this once in Terminal:

```sh
# Make scripts executable
chmod +x /Users/elijah/projects/kalshi-bot/scripts/follow-ups-sweep.sh
chmod +x /Users/elijah/projects/kalshi-bot/scripts/db-snapshot.sh
chmod +x /Users/elijah/projects/kalshi-bot/scripts/daily-perf-review.sh

mkdir -p ~/Library/LaunchAgents

# 8:53am — follow-ups sweep
cat > ~/Library/LaunchAgents/com.elijah.kalshi-bot.follow-ups.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.elijah.kalshi-bot.follow-ups</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>/Users/elijah/projects/kalshi-bot/scripts/follow-ups-sweep.sh</string></array>
    <key>WorkingDirectory</key><string>/Users/elijah/projects/kalshi-bot</string>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>53</integer></dict>
    <key>StandardOutPath</key><string>/Users/elijah/projects/kalshi-bot/logs/follow-ups-launchd.log</string>
    <key>StandardErrorPath</key><string>/Users/elijah/projects/kalshi-bot/logs/follow-ups-launchd.log</string>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

# 9:55am — DB snapshot (before the 10am review)
cat > ~/Library/LaunchAgents/com.elijah.kalshi-bot.db-snapshot.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.elijah.kalshi-bot.db-snapshot</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>/Users/elijah/projects/kalshi-bot/scripts/db-snapshot.sh</string></array>
    <key>WorkingDirectory</key><string>/Users/elijah/projects/kalshi-bot</string>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>55</integer></dict>
    <key>StandardOutPath</key><string>/Users/elijah/projects/kalshi-bot/logs/db-snapshot-launchd.log</string>
    <key>StandardErrorPath</key><string>/Users/elijah/projects/kalshi-bot/logs/db-snapshot-launchd.log</string>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

# 10:00am — daily performance review
cat > ~/Library/LaunchAgents/com.elijah.kalshi-bot.daily-perf-review.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.elijah.kalshi-bot.daily-perf-review</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>/Users/elijah/projects/kalshi-bot/scripts/daily-perf-review.sh</string></array>
    <key>WorkingDirectory</key><string>/Users/elijah/projects/kalshi-bot</string>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>/Users/elijah/projects/kalshi-bot/logs/daily-perf-review-launchd.log</string>
    <key>StandardErrorPath</key><string>/Users/elijah/projects/kalshi-bot/logs/daily-perf-review-launchd.log</string>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

# Load all three
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.elijah.kalshi-bot.follow-ups.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.elijah.kalshi-bot.db-snapshot.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.elijah.kalshi-bot.daily-perf-review.plist

launchctl list | grep kalshi   # verify all three loaded

# Optional test-fire (snapshot first, then review):
# launchctl kickstart gui/$(id -u)/com.elijah.kalshi-bot.db-snapshot
# launchctl kickstart gui/$(id -u)/com.elijah.kalshi-bot.daily-perf-review
```

Once launchd is confirmed, delete any in-session cron duplicate (`CronList` → `CronDelete`) to avoid double sweeps.

**2. In-session Claude Code cron (fallback)** — session-bound (the scheduler doesn't persist to disk here); dies with the Claude session. Re-arm in any new session by calling `CronCreate` with `cron "53 8 * * *"`, `recurring: true`, and this canonical prompt:

> [Scheduled daily follow-ups check — kalshi-bot]
>
> You are running the scheduled morning follow-ups sweep for the Kalshi climate bot. Work from /Users/elijah/projects/kalshi-bot. You have FULL AUTONOMY within the guardrails below — the user (Elijah) pre-authorized acting on due items without asking.
>
> 1. Read docs/follow-ups.md. Compare each row's Due column to today's date (also handle "weekly" rows by checking the Log for the last sweep ≥7 days ago).
> 2. For every due/overdue item, run its exact Check (sqlite3 against ./data/kalshi-bot.db, log greps, or the `wins` command logic — you can run the REPL handlers via `bun -e` imports as needed). The live DB is at ./data/kalshi-bot.db; bot logs at logs/bot.log; the regime boundary for all measurement is 2026-06-05T20:00Z.
> 3. ACT when a row's Decide criteria are unambiguously met — including runtime_config changes (via `bun ops set <key> <value> --why "follow-up #N: ..."`, e.g. enabling ultra_sniper_horizon_hours=4, bumping confirmation_bet_size_cents, station probation via disabled_stations). When data is insufficient or the call is ambiguous, do NOT act: record findings and push the Due date forward instead.
> 4. GUARDRAILS (override everything): never set dry_run=false (going live is a human decision); never delete data or rewrite history; never expand to new market categories; if any check reveals something alarming (rolling win rate collapsing, ground-truth health < 90%, exit churn returning, HRRR absent from sniper-window sourceMix), lead your response with a loud ⚠ summary before anything else.
> 5. Record every outcome in docs/follow-ups.md's Log section (newest first: date, item #, ✅/❌, one line, action taken or deferred-to date), update Due dates for re-checks, and per CLAUDE.md: run `bun test` and only commit + push if green. Keep changelog entries only for actual algorithm/config changes you made (per its rules).
> 6. Self-perpetuation: this cron task auto-expires 7 days after creation. Run CronList; if this daily task is missing or within 2 days of expiry, re-create it with CronCreate (recurring: true, durable: true, cron "53 8 * * *") passing THIS ENTIRE PROMPT verbatim. Note the re-arm in your summary.
> 7. End with a compact status: items checked, actions taken, anything due soon, and the current `wins summary` line vs the 80% target.

## Log

Record outcomes here as items close (newest first):

- **2026-06-11 — performance review (weeklies #1/#2/#9; #3 ✅ enabled):**
  - **#1 ✅ weekly:** `cli|36` actuals landed in last 2 days — ground-truth pipeline healthy.
  - **#2 ✅ weekly:** `confirm_no` 92.6% (n=27), `confirm_yes` 94.1% (n=17), overall confirmation 93.2% (n=44) — well above 80% target. Zero confirmation sells (exit churn = 0). Next: 2026-06-18.
  - **#9 ✅ weekly gate sweep:** `edge<threshold` (186, 3.2%) and `scout mode` (179, 26.8%), `contra-market` (22, 18.2%), `station health` (11, 27.3%), `obs stale` (5, 0%) all SAVING. `already hold` (n=37, 86.5%) ⚠ COSTING — above n≥10 bar; however these are per-event-cap blocks on correlated positions (design intent); watching for now vs raising `max_event_exposure_pct_of_balance`. `recent-loss` (n=12, 100%) reads ⚠ COSTING but is a **red herring** — all 12 blocked KDEN Jun-9 signals had negative edge (-4 to -30¢); the gate correctly rejected negative-EV bets that happened to settle favorably. `cooldown` (n=5, 80%) and `other` (n=8, 62.5%) below n=10 action bar. Next: 2026-06-18.
  - **#3 ✅ ENABLED:** All conditions met (5 clean days since HRRR fix): HRRR present in every sniper-window sourceMix (107/267 members); `postPeakCollapse=true` confirmed firing at 21:35Z for KAUS/KMIA; zero `hrrr-unavailable`/`obs-stale` quality skips. **`ultra_sniper_horizon_hours` set to 4** via `ops set`. Watch next 3 days for contrarian entries admitted in the sniper window. ⚠ Note: 21Z acted trades show 66.7% win rate (−$17.36, n=9) — these are pre-peak entries; ultra-sniper post-peak entries should be better but monitor #5 early.
  - **Overall:** 89.8% (n=49), +$80.75 pnl. By station: KAUS 100%, KMIA 92.9%, KDEN 80.0%. **21Z hour** is the outlier: 66.7%, −$17.36 — watch for #5. Confidence tier 0.85–0.90 at 77.8% (n=18) is below fee-adj breakeven (~89% at 88¢ cap) but PnL +$48.65 due to contrarian wins in the bucket.

- **2026-06-10 — algorithm review (confirmation tightening; items #12/#13 opened):** Full review of the post-regime record (39 settled, 92.3%, +$12.20 — 100% confirmation pathway; contrarian still anti-predictive: blocked 10–28¢-edge signals would-win only 0–30%, gates stay). Four changes shipped, see [`improvements/confirmation-tightening-2026-06-10.md`](improvements/confirmation-tightening-2026-06-10.md): (1) `confirmation_max_entry_price` 0.93→0.88 — the 90–93¢ band was 12/14 but **net −$4.00** vs +$16.20 across 80–89¢; (2) per-event exposure cap (`max_event_exposure_pct_of_balance=0.15`) — every event was getting 2–4 correlated entries and 2 of the 3 losses were one KDEN event pair; (3) recent-loss re-entry guard now exempts confirmations (edge ≤ 0 made the 1.5×-edge bar unsatisfiable; 12/15 blocked re-entries would have won); (4) **PnL is now fee-true** — `takerFeeCents` deducted in `computePerSidePnl` (→ calibration → paper balance) and the `wins` scoreboard. NOTE for #4: the verdict's PnL numbers now include taker fees (~0.5–0.8¢/contract at confirmation prices); breakeven at 88¢ cap ≈ 89% fee-adjusted. Opened #12 (KDEN watch) and #13 (obs-certainty gate exemption audit). 764/764 tests green.

- **2026-06-10 — sweep (⚠ deploy bug found + fixed; nothing formally due):** Nothing was due (weeklies #1/#2/#9 all run within 3 days; next dated item #3 on the 12th). Proactive check of yesterday's confidence-sizing rollout surfaced a bug: **the feature was enabled in the DB but inert in the running bot.** Root cause: `getConfig()` cached `runtime_config` once per process — every `ops set` to the long-running bot did nothing until a restart, and `bun --watch` only soft-reloads on real file content edits, NOT the bare `touch` I'd used to "apply" it. The 7 post-enable buys were all flat 5–6 contracts. This also meant the sweep's own future `ops set` actions (ultra-sniper, station probation) would have silently no-op'd. **Fixed:** `refreshRuntimeConfig()` re-reads `runtime_config` every orchestrator tick; `applyRuntimeOverrides` exported + tested; ops CLI/skill messaging corrected. Confirmed the bot soft-reloaded at 13:35Z (orchestrator re-init) with fresh config — pct sizing is now live, and #11's first-week check (due 2026-06-16) now has a real starting point. Also flagged: ground-truth health dipped to 98% (KORD 89%, 3/28 misses over 14d) — above the 90% alarm line, watching. 751/751 tests green.

- **2026-06-09 — sweep (item #2 validated, first PnL-positive read):** **#2 ✅** confirmation pathway passes its first real read at n=30: **90.0% win rate, pnl +$5.24** — and PnL has flipped positive (was −$0.60 yesterday at n=21). The breakeven-vs-win-rate gap flagged for #4 is now cleared: 90% wins clears the ~87% breakeven at ~87¢ avg entry. Split: `confirm_no` 88.2% (n=17, +$1.68), `confirm_yes` 92.3% (n=13, +$3.56). **Zero confirmation sells** since inception — the entryKind exit policy holds, no churn regression. No config change (win rate far above the 70% re-tune trigger). Converted #2 to a weekly churn+win-rate health check. No other items due (#1 weekly → 2026-06-15, #9 weekly → 2026-06-14). Next: #3 ultra-sniper enablement, 2026-06-12.

- **2026-06-08 — sweep (item #1 resolved):** **#1 ✅** the 2026-06-07 CLI site-code fix works end-to-end — 18 `cli`-source actuals landed after last night's settlements (all six stations, 2026-06-07, exact integer °F: KNYC 81, KORD 83, KAUS/KDEN 91, KMIA 89, KLAX 72 — vs the old settlement-midpoint `.5`s). Ground-truth health holds 100% (n=147). Converted #1 from a one-off debug item into a weekly "still flowing?" health check. No other items due (#9 weekly was run 2026-06-07 → next 2026-06-14). `wins summary` advanced as 9 markets settled mid-sweep: **85.7% (n=21), pnl −$0.60** (up from 83.3%/n=12/−$1.18 yesterday) — still net-negative on ~87¢ avg entries, exactly the breakeven-vs-win-rate gap flagged for #4. #2 (confirmation first read) now has enough sample but isn't due until 2026-06-09 — leaving it for tomorrow's sweep per its date.

- **2026-06-07 — sweep (items #1, #9) + ⚠ incident round 2:**
  - **⚠ Station-health gate re-disabled all six stations at 2026-06-06T21:09Z** — seven minutes after the manual restore. Root cause: the first clamp bound on `markets.updated_at`, a settled-at proxy rewritten by ANY touch of the market row; the bracket-geometry migration had bumped 1,584 old markets past the boundary, so old-regime trades sailed through (gate saw "KAUS 38% over 37 trades" — all Apr 26–Jun 4 entries). Fix: the regime clamp now also binds on `orders.created_at` (immutable entry time); regression test added (round 2); `disabled_stations` restored to `KORD,KLAX,KNYC` via audited `ops set`. Overnight damage: negligible (9 blocked signals, all KNYC — manually disabled anyway; zero would-be entries at the wrongly-disabled five).
  - **#1 ❌→fixed:** no `cli` actuals ever landed — `getCliReport` queried `/products/types/CLI/locations/{WFO}` but the NWS products API indexes CLI by **site code** (`/locations/OKX` returns an empty `@graph`, no error; `/locations/NYC` works). Fixed to fetch by `CLI_SITE_CODE`; live-verified exact values for KNYC/KMIA/KAUS/KDEN Jun 6 (e.g. KDEN 91 vs settlement-mid 90.5). Re-check tomorrow (#1 due 2026-06-08) that reconciliation writes `cli` rows end-to-end. NOT done: retro-upgrading the ~84 existing `settlement`-source rows to exact CLI values (in-place rewrite of ground-truth history — needs Elijah's explicit go-ahead; CLI products are retained ~7 days, so the window for May 31–Jun 6 closes fast).
  - **#9 ✅ weekly gate sweep:** `edge<threshold` (n=63, 1.6% would-win), `scout mode` (35, 28.6%), `contra-market` (7, 14.3%), `station health` (7, 28.6%) all SAVING. `already hold` (n=9, 66.7%) and `other` (n=6, 66.7%) read ⚠ COSTING but are below the n≥10 action bar — watch next week. Next weekly: 2026-06-14.
  - **Observation for #4:** `wins summary` = **83.3% (n=12), pnl −$1.18** — above the 80% target yet net-negative, because at ~86¢ avg confirmation entry the breakeven win rate is ~86%. Added "AND pnl > 0" to #4's verdict criteria.
- **2026-06-06 — ⚠ incident (caught by `bun ops status` on its first run):** the station-health gate's 30-day window reached across the regime boundary into old-bot statistics and **disabled all six stations** at 17:24Z (KAUS 38%, KMIA 40%, KDEN 41% — all old-regime rates below the 45% floor). Restored `disabled_stations=KORD,KLAX,KNYC` via `bun ops set` (audited); root-caused and fixed: the gate's window now clamps to `REGIME_BOUNDARY_ISO` (2026-06-05T20:00Z, exported from `@kcb/shared`) so it can only ever judge the current bot; regression test added; gate writes are now attributed in `runtime_config_log` as `station-health-gate`.

---

*Created 2026-06-06 at the close of the win-rate-80 build phase ([`win-rate-80-plan`](improvements/win-rate-80-plan-2026-06-05.md) + [`addendum`](improvements/win-rate-80-addendum-2026-06-05.md) fully shipped). The bot is in measurement mode; this file is what keeps the measurements honest.*
