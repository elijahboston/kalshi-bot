# Follow-ups — deferred checks with due dates

**When to use:** Check at the start of every working session for due deferred decisions.
**Last verified:** 2026-06-10 by Elijah Boston

Decisions we deliberately postponed until data exists. **Check the Due column at the start of every working session**; when an item comes due, run its check, record the outcome inline (✅/❌ + one line + date), and either act or set a new due date. Items here are *scheduled judgments*, not bugs or backlog — those live in [`improvements/`](improvements/) and the issue-shaped sections of [`spec.md`](spec.md).

The regime boundary for all measurements is **2026-06-05T20:00Z** (first trade after the win-rate-80 redirection). The `wins` REPL command defaults to it.

| # | Due | Item | Check | Decide |
|---|-----|------|-------|--------|
| 1 | weekly | CLI exact actuals still flowing | `SELECT actual_source, COUNT(*) FROM weather_forecasts WHERE actual_value IS NOT NULL AND fetched_at >= date('now','-2 days') GROUP BY 1` — expect a steady stream of `cli` rows (resolved 2026-06-08, see Log); `grep "ground-truth health" logs/bot.log` stays ~100% | If `cli` rows stop appearing: NWS CLI site-code mapping or product retention regressed — debug `getCliReport` |
| 2 | weekly | Confirmation pathway health (validated 2026-06-09 at n=30/90%) | `wins by_path` — confirmation arm stays ≥80%; verify NO exit churn: `SELECT COUNT(*) FROM orders o JOIN signals s ON o.signal_id=s.id WHERE o.action='sell' AND s.recommendation LIKE 'confirm%' AND o.created_at >= '2026-06-06T18:00'` ≈ 0 (only conviction-floor/stop-loss sells expected) | If churn reappears: exit policy regression — bisect against the entryKind exit policy. If win rate drops <70% on n≥10: re-examine `confirmation_min_market_conviction` (0.80 → 0.85) |
| 3 | ✅ 2026-06-15 | Ultra-sniper 3-day watch — CLOSED | 21Z KAUS 80%, 22Z KAUS 100% — ultra-sniper working for KAUS/KMIA. 21Z KDEN 50% was the drag; root cause is KDEN model quality, not ultra-sniper. Fixed via #12. | Ultra-sniper stays at 4h. |
| 4 | 2026-06-26 (sizing re-decide) | **The 80% verdict** — ✅ **PASSED 2026-06-19: 86.1% (n=115), pnl +$58.88** (≥80% AND pnl>0; by_confidence monotonic 75%→89.5%→95.5%; no NEW ⚠ COSTING gate family). Sizing bump DEFERRED. | `wins summary` — the program's pass/fail line AND pnl > 0; `wins by_gate` for any family flipped to ⚠ COSTING; `wins by_confidence` — is the new formula monotonic? | Verdict met. The prescribed `confirmation_bet_size_cents` bump is **inert** under pct sizing (`confidence_size_pct_enabled=true` makes pct the sole path); live lever is `confidence_size_max_pct`. Bump DEFERRED to 2026-06-26: the adjacent-bracket guard that mitigates pct-sizing's correlated-loss amplification shipped 2026-06-18 with 0 settled validation — bump max_pct only once it has a settled track record. **Live-capital conversation = Elijah's call (dry_run stays true).** |
| 5 | ✅ 2026-06-19 — CLOSED | N12: entry-hour re-cut | `wins by_hour` — the old 18–20Z deficit did NOT survive: 18Z 83.3%, **19Z 94.4%, 20Z 100%**. Only weak hour is 21Z (71.4%, −$31.06) = KDEN-tainted (KDEN disabled; active 21Z healthy) — a station issue, not an hour issue. | No hour gate warranted. **N12 closed permanently.** |
| 6 | ✅ 2026-06-19 — CLOSED | Prior weights were tuned on broken-geometry data | Post-fix YES-outcome Brier: **model 0.1122 vs market 0.0743** (acted, n=88); **model 0.0148 vs market 0.0001** (KAUS/KMIA settled, n=168). Market remains decisively better-calibrated than the model — the *opposite* of the condition to lower `market_prior_weight`. | The market-leaning blend (`market_prior_weight=0.3`, `historical_prior_weight=0.5`) is validated. **No change; closed.** |
| 7 | 2026-06-26 | Disabled stations (KORD/KLAX/KNYC/KDEN) probation | Blocked-signal would-win (deduped/ticker): **KNYC 11.1% (n=9)**, KORD 50% (n=2), KLAX (n=1), **KDEN 50% (n=8)**. KNYC <40% → keep. KORD/KLAX n≤2 → insufficient. KDEN's acted record 74.2%/−$35.76 (below fee-adj breakeven, the #12 disable reason) outweighs its 50% blocked rate. | 2026-06-19: no station clears a confident ~50%+ bar with adequate data. **All four kept disabled.** Re-check 2026-06-26. |
| 8 | ✅ 2026-06-19 — CLOSED (cleanup note) | Sigma floor binding rate | Binding **0.88% (2604 / 295,936 signals since regime)** — well under the 5% line. CLI-exact actuals have stopped the empirical-sigma collapse; the floor rarely binds. | <5% → floor is effectively dead weight. **Measurement closed.** Cleanup note: `sigma_floor_bracket_width_factor` can be removed at next code cleanup (no-op in practice; not removed now to avoid an out-of-band code change mid-measurement). |
| 9 | weekly | Gate health sweep | `wins by_gate` — 30 seconds | Any family ⚠ COSTING with n≥10 is the next tuning target |
| 10 | when #4 passes | Precip/snowfall expansion | Before enabling: audit their settlement semantics from titles/rules (Finding 11 class — do NOT trust the legacy parse), then per-category bias rows | Separate plan doc; deliberately out of scope until `high_temp` proves ≥80% |
| 11 | 2026-06-26 (with #4 sizing) | Confidence-scaled %-of-balance sizing (2026-06-19: clean, scaling positively, left UNCHANGED) | Enabled in paper 2026-06-09 (`confidence_size_pct_enabled=true`, `max_exposure_pct_of_balance=0.12`, 1–10% across conf 0.80→1.0). Check: `wins summary` PnL trajectory vs the flat-$5 era; `grep "pct-size" logs/bot.log` — do realized sizes land in the expected ~3.4–9.6% band? any `at max exposure` skips (cap too tight)? max single-position drawdown sane? | 2026-06-19: realized sizes conf 0.90→5.7% … 0.97→8.8% (in-band); **0 floored-to-min, 0 at-max-exposure clips, 0 zero-contract skips**; PnL scaling positively (+$58.88, up from +$42.40 on 06-18). Correlated-stacking amplification now structurally mitigated by the adjacent-bracket guard (shipped 06-18, 29 blocks incl. the KMIA B93.5 leg). **"Clean & scaling positively → leave it."** max% re-decision tied to #4 (2026-06-26). |
| 12 | ✅ 2026-06-15 | KDEN post-tightening watch — CLOSED | KDEN net −$35.76 (74.2%, n=31); confirmation 81.5% (n=27) below ~89% fee-adj breakeven; contrarian 1/4=25%. Tightening did not fix it. | **KDEN added to `disabled_stations`** (ops set 2026-06-15). Revisit at #7 probation 2026-06-19. |
| 13 | ✅ 2026-06-19 — CLOSED | Obs-certainty gate exemption (audit first) | Audit: of 90 contrarian-gate skips since regime (74 coin-flip + 16 disagreement), **0 had obs-certainty** — all sit in est_prob 0.13–0.39 (genuine model disagreement). The estimator never output ~1.0 on a contrarian-blocked signal; the feared "certainty blocked as noise" failure mode is not occurring. | Material-count bar (≥5/week) not met. **Closed.** Obs-certainty is handled upstream by the obs anchor / ultra-sniper, which produces high-confidence signals that don't land in the coin-flip/disagreement zone. |

## Scheduled automation

Three daily launchd agents run in sequence. All honour the `.sweep-paused` sentinel (`bun ops pause` / `bun ops resume`).

| Time | Agent | Script | Log |
|------|-------|--------|-----|
| 8:53am | Follow-ups sweep | `scripts/follow-ups-sweep.sh` | `logs/follow-ups-sweep.log` |
| 9:55am | DB snapshot | `scripts/db-snapshot.sh` | `logs/db-snapshot.log` |
| 10:00am | Performance review | `scripts/daily-perf-review.sh` | `logs/daily-perf-review.log` |

All three agents also append a section to **`docs/YYYY-MM-DD-log.md`** — a single markdown file per calendar day. The sweep writes the `## 08:53` section, the snapshot writes `## 09:55`, and the perf review writes `## 10:00` then commits and pushes the complete file. If the machine was off during a window, the next agent to run initialises the header.

The **snapshot** (9:55am) uses SQLite's `.backup` for a consistent copy of `data/kalshi-bot.db` → `data/snapshots/kalshi-bot-YYYY-MM-DD.db`, rotating files older than 7 days. It always runs before the review so the review has a stable reference point.

The **performance review** (10:00am) runs Claude Code headless: wins scoreboard (`summary`, `by_gate`, `by_station`, `by_confidence`, `by_hour`), weekly health checks (#1 CLI actuals, #2 confirmation churn), due follow-up items, ⚠ threshold checks, and commits any doc/config changes if tests pass. The bash wrapper then commits `docs/YYYY-MM-DD-log.md` separately so the daily log is always a clean one-line commit.

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

- **2026-06-19 — follow-ups sweep — THE VERDICT BATCH (#4/#5/#6/#7/#8/#11/#13 all due; weeklies #1/#2/#9 next 06-22):** Seven dated items resolved in one sweep. `wins summary`: **86.1% (n=115), pnl +$58.88** (up from 85.7%/n=112/+$42.40 on 06-18; +3 net-positive settlements). **No config changes** — every item closed, kept-as-is, or deferred per the ambiguity guardrail; the one prescribed config action (#4 bet-size bump) targets an inert knob and its live equivalent is deferred. **dry_run stays true.**
  - **#4 ✅ PASSED — the 80% verdict is met.** 86.1% ≥ 80% AND +$58.88 > 0. by_confidence **monotonic** (0.85–0.90 = 75.0%/n=36 → 0.90–0.95 = 89.5%/n=57 → ≥0.95 = 95.5%/n=22). No NEW ⚠ COSTING gate family (already-hold 84.2%/n=76 event-cap-correct, other 82.4%/n=17 cap-overflow/dust, recent-loss 85.7%/n=14 & cooldown 81.8%/n=11 KDEN neg-edge red herrings, coin-flip 50%/n=10 neutral — all previously characterized). **Sizing bump DEFERRED, not skipped:** the prescribed `confirmation_bet_size_cents 500→1000` is **inert** because `confidence_size_pct_enabled=true` makes pct-of-balance the *sole* sizing path (verified in execution.ts:362 — pct "takes precedence over the flat/confirmation/high-confidence/Kelly dollar paths"). The live lever is `confidence_size_max_pct`. Bumping it amplifies pct-sizing's correlated-loss tail, and the **adjacent-bracket guard that mitigates exactly that** shipped only 2026-06-18 (29 blocks, 0 settled validation). Per the ambiguity guardrail, scaling up before the mitigation is proven is the wrong move → **re-decide 2026-06-26** once the guard has settled outcomes. **Live-capital conversation flagged for Elijah** (human decision; dry_run untouched).
  - **#5 ✅ CLOSED — N12 entry-hour deficit is gone.** `wins by_hour`: 18Z 83.3% (n=18), **19Z 94.4% (n=18), 20Z 100% (n=15)** — the old 18–20Z deficit did not survive the obs anchor + new regime. The only weak hour is 21Z (71.4%, −$31.06), which is KDEN-tainted (KDEN disabled; active 21Z healthy per prior sweeps) — a station artifact, not an hour effect. No hour gate warranted; N12 closed permanently.
  - **#6 ✅ CLOSED — keep the market-leaning blend.** Post-geometry-fix YES-outcome Brier: **model 0.1122 vs market 0.0743** (settled acted, n=88); **model 0.0148 vs market 0.0001** (KAUS/KMIA settled, n=168). The market remains decisively better-calibrated than the model — the *opposite* of #6's trigger to lower `market_prior_weight`. Lowering it (trust the worse model more) would be harmful. `market_prior_weight=0.3` / `historical_prior_weight=0.5` validated; no change.
  - **#7 — all four stations kept disabled; re-check 2026-06-26.** Blocked-signal would-win (deduped last/ticker): **KNYC 11.1% (n=9)** → <40%, keep (clear); KORD 50% (n=2) & KLAX (n=1) → insufficient data; **KDEN 50% (n=8)** blocked-rate is outweighed by its acted record (74.2%, −$35.76, below ~89% fee-adj breakeven — the #12 disable reason). No station clears a confident ~50%+ probation bar with adequate n → no re-enable.
  - **#8 ✅ CLOSED — sigma floor is dead weight.** Binding **0.88% (2604 / 295,936 signals since regime)**, well under 5%. CLI-exact actuals stopped the empirical-sigma collapse, so the floor rarely binds. Cleanup note left: `sigma_floor_bracket_width_factor` can be dropped at the next code cleanup (no-op in practice; not removed now to avoid an out-of-band code change mid-measurement).
  - **#11 — pct sizing left UNCHANGED.** Realized sizes conf 0.90→5.7% … 0.97→8.8% (in the expected ~3.4–9.6% band); **0 floored-to-min, 0 at-max-exposure clips, 0 zero-contract skips**. PnL scaling positively. Correlated-stacking amplification now structurally mitigated by the adjacent-bracket guard (29 blocks incl. the KMIA B93.5 second-leg — the exact 06-15 −$56 pattern). "Clean & scaling positively → leave it." max% re-decision folded into #4 (2026-06-26).
  - **#13 ✅ CLOSED — obs-certainty exemption immaterial.** Of 90 contrarian-gate skips since regime (74 coin-flip + 16 disagreement), **0 had obs-certainty** — all sit in est_prob 0.13–0.39 (genuine model disagreement, exactly what the gates target). The estimator never output ~1.0 on a contrarian-blocked signal, so the "certainty blocked as noise" failure mode is not occurring (obs-certainty is handled upstream by the obs anchor / ultra-sniper). Bar (≥5/week) not met → closed.
  - **Guardrails all green:** 158/158 regime orders `dry_run=1` (paper); `disabled_stations=KORD,KLAX,KNYC,KDEN`; #1 CLI actuals `cli|36` last 2d; #2 confirmation exit churn = 0; ground-truth health **93.8% (n=195)** — KNYC/KLAX/KMIA/KAUS/KDEN all 100%, only disabled KORD 64% (21/33) below the line but frozen. By station: KAUS 90.6% +$44.57, KMIA 90.3% +$50.07, KDEN [disabled] 74.2% −$35.76 (aging out). **Next big checkpoint: 2026-06-26 (#4 sizing bump / #7 probation / #11 max%).**

- **2026-06-18 — performance review (10:00; complements the 08:53 follow-ups sweep below):** No new settlements since the morning sweep — `wins summary` unchanged at **85.7% (n=112), pnl +$42.40**. Nothing formally due (weeklies #1/#2/#9 last ran 06-15 → next 06-22; the entire dated batch #4/#5/#6/#7/#8/#11/#13 lands **tomorrow, 2026-06-19**; #3/#12 closed). Re-ran the perf-review ⚠ threshold checks — only one literal flag, fully KDEN-contaminated, not newly actionable:
  - ⚠ **21Z 71.4% (n=21), −$31.06 — negative PnL** (win rate above the 70% floor). Station split: **KAUS 10/11 = 90.9%**, KDEN 5/10 = 50% — the entire drag is now-disabled KDEN; active 21Z is healthy. Watch #5 (2026-06-19).
  - **0.85–0.90 conf bucket 75.0% (n=36)** — sits exactly *at* the <75% flag threshold (not below), unchanged from the morning sweep; ≥0.95 = 95.2% (n=21, +$49.86), 0.90–0.95 = 89.1% (n=55). Watch #4 (2026-06-19).
  - **Gate sweep — no NEW n≥10 COSTING family.** already-hold (83.6%/n=73, event-cap design-correct), other (80%/n=15, cap-overflow/dust/lottery blocks), recent-loss (85.7%/n=14, KDEN neg-edge red herring), cooldown (81.8%/n=11, neg-edge red herring), coin-flip (50%/n=10, neutral by definition) — all previously characterized.
  - **Green:** #1 CLI actuals `cli|33` (last 2d); #2 confirmation 89.4% (n=104, +$41.57) + exit churn = 0; overall 85.7% ≥ 85% (cushion intact); active KAUS+KMIA 90.1% (73/81); KDEN [disabled] still the drag at 74.2% (−$35.76) but aging out.
  - **No config changes** — nothing formally due today, numbers identical to the morning sweep, the one flag is KDEN-tainted → ambiguity guardrail, knobs untouched. **Big day tomorrow: the #4 80% verdict + the #5/#6/#7/#8/#11/#13 batch all land 2026-06-19.**

- **2026-06-18 — follow-ups sweep (nothing due; guardrail safety checks only):** No item formally due. The entire dated batch (#4/#5/#6/#7/#8/#11/#13) comes due **tomorrow, 2026-06-19**; weeklies #1/#2/#9 ran 06-15 → next 06-22; #3/#12 closed. Ran the guardrail health checks regardless, **all green:** 165 regime orders all `dry_run=1` (paper); `dry_run=true` and `disabled_stations` correctly includes KDEN; #1 CLI actuals `cli|33` last 2d; #2 confirmation exit churn = 0; ground-truth health **95.4% (n=195)** — only disabled KORD (72%, 23/32) below 100%, above the 90% line; all six active+disabled stations otherwise 100%. **`wins summary`: 85.7% (n=112), pnl +$42.40** — up from 85.6% (n=104, +$29.96) on 06-17; **8 new net-positive settlements**. Confirmation 89.4% (n=104, +$41.57); **active KAUS+KMIA 90.1% (73/81)** (KAUS 90.2% +$33.38, KMIA 90.0% +$44.78); KDEN [disabled] still the drag at 74.2% (−$35.76) but aging out. Re-checked the two recurring soft flags — both still fully KDEN-tainted, neither newly actionable:
  - **21Z 71.4% (n=21), −$31.06** — split is **KXHIGHAUS 11 / KXHIGHDEN 10**; the negative PnL is the now-disabled KDEN half (active KAUS 21Z healthy, 7/8 on 06-17). Above the 70% floor; watch #5 (2026-06-19).
  - **0.85–0.90 conf bucket 75.0% (n=36)** — sits exactly *at* the <75% flag threshold (improved from 73.5% on 06-17), KDEN-contaminated as before; ≥0.95 = 95.2% (n=21, +$49.86), 0.90–0.95 = 89.1% (n=55). Watch #4 (2026-06-19).
  - **Gate sweep — no NEW n≥10 COSTING family.** already-hold (83.6%/n=73, event-cap design-correct), other (80%/n=15, cap-overflow/dust/lottery blocks), recent-loss (85.7%/n=14, KDEN neg-edge red herring), cooldown (81.8%/n=11, neg-edge red herring per 06-17), coin-flip (50%/n=10, neutral by definition) — all previously characterized.
  - **No config changes** — nothing due, all metrics improving/stable, every flag KDEN-tainted or a known red herring → ambiguity guardrail, knobs untouched. **Big day tomorrow: the #4 80% verdict + the #5/#6/#7/#8/#11/#13 batch all land 2026-06-19.**

- **2026-06-17 — manual session (loss breakdown + stacking analysis):** Analyzed the two ~$20 losses flagged in the equity drawdown: **KMIA Jun 15 −$20.00** (`confirm_yes` YES on "93-94°" at 80¢, 25c) and **KDEN Jun 12 −$18.48** (`confirm_yes` YES on "88-89°" at 88¢, 21c). Both are the smaller leg of a **correlated two-leg adjacent-bracket stack** — the bot simultaneously confirmed both brackets of the same event and the temperature ran to the higher one, losing both. KMIA Jun 15 combined loss −$56.08; KDEN Jun 12 combined loss −$43.59. Root causes: (1) confirm pathway treats adjacent brackets as independent when they're anti-correlated; (2) pre-peak entry (`postPeakCollapse=false`) with model mean straddling the boundary; (3) per-event cap (0.15×) allowed both legs to clear individually; (4) pct sizing amplified dollar damage 4×. Options documented in [`improvements/correlated-bracket-stacking-2026-06-17.md`](improvements/correlated-bracket-stacking-2026-06-17.md). **Decision deferred to 2026-06-19** alongside #4 and #11 — Option A (adjacent bracket mutual exclusivity) is the recommended surgical fix.

- **2026-06-17 — performance review (10:00; complements the 08:53 follow-ups sweep below):** No new settlements since the morning sweep — `wins summary` unchanged at **85.6% (n=104), pnl +$29.96**. Nothing formally due (weeklies #1/#2/#9 last ran 06-15 → next 06-22; dated batch #4/#5/#6/#7/#8/#11/#13 all 2026-06-19; #3/#12 closed). Re-ran the perf-review ⚠ threshold checks — two literal flags, both fully KDEN-contaminated, none newly actionable:
  - ⚠ **21Z 66.7% (−$46.02), <70% + negative** — station split: **KAUS 7/8 = 87.5%**, KDEN 5/10 = 50%. The entire drag is now-disabled KDEN; active 21Z is healthy. Watch #5 (2026-06-19).
  - ⚠ **0.85–0.90 conf bucket 73.5% (n=34), <75%** — split: **KMIA 11/13 = 84.6%, KAUS 10/12 = 83.3%** (active = 21/25 = 84%), KDEN 4/9 = 44.4% drags it. Watch #4 (2026-06-19).
  - **Cooldown gate crossed n≥10 (n=10, would-win 80% ⚠ COSTING) — red herring, NOT a new tuning target.** All 24 cooldown-blocked signals (10 deduped) carry **negative edge** (−0.01 to −0.29; sole exception +0.044), all `confirm_*` on KXHIGHA/KXHIGHD — the gate correctly rejected negative-EV bets that happened to settle favorably. Same pattern as recent-loss. The other ⚠ families are all previously characterized: already-hold 84.1% (n=69, event-cap design-correct), recent-loss 85.7% (n=14, KDEN neg-edge red herring), other 78.6% (n=14, cap-overflow/dust/lottery blocks).
  - **Green:** #1 CLI actuals `cli|36` (last 2d); #2 confirmation 89.6% (n=96) + exit churn = 0; overall 85.6% ≥ 85% (cushion intact); no confidence bucket failure beyond the KDEN-tainted 0.85–0.90 (≥0.95 = 94.1%, 0.90–0.95 = 90.6%).
  - **No config changes** — nothing due today, numbers identical to the morning sweep, all flags are KDEN-tainted/red-herring → ambiguity guardrail, knobs untouched. All eyes on the **#4 80% verdict (2026-06-19)** and the carried sizing/event-cap question from #11.

- **2026-06-17 — follow-ups sweep (nothing due; guardrail safety checks only):** No item formally due — weeklies #1/#2/#9 ran 06-15 → next 06-22; the dated batch (#4/#5/#6/#7/#8/#11/#13) is all **2026-06-19**; #3/#12 closed. Ran the guardrail health checks regardless, **all green:** 153 regime orders all `dry_run=1` (paper); #1 CLI actuals `cli|36` last 2d; #2 confirmation exit churn = 0; ground-truth health **96.7–96.8%** (n=184–190, only disabled KORD at 81% below 100%, above the 90% line). **`wins summary`: 85.6% (n=104), pnl +$29.96** — up from 84.8% (n=92, +$1.95) on 06-16; 12 new net-positive settlements. Confirmation 89.6% (n=96, +$29.13); **active KAUS+KMIA 90.4% (66/73)** (KAUS 91.1% +$34.46, KMIA 89.3% +$31.26); KDEN [disabled] still the drag at 74.2% (−$35.76) but aging out. **No config changes** (nothing due, all metrics improving → ambiguity guardrail, knobs untouched). All eyes on the **#4 80% verdict 2026-06-19** (and the carried sizing/event-cap question from #11).

- **2026-06-16 — performance review (10:00; complements the 08:53 follow-ups sweep below):** No new settlements since the morning sweep — `wins summary` unchanged at **84.8% (n=92), pnl +$1.95**. Re-ran the perf-review ⚠ threshold checks; three literal flags, all KDEN-contaminated, already characterized in the morning entry, none newly actionable:
  - ⚠ **Overall 84.8% < 85% threshold** — dragged by now-disabled KDEN (74.2%, n=31, −$35.76); active KAUS+KMIA portfolio is **90.2% (55/61)**. Expected to recover as KDEN entries age out of the window.
  - ⚠ **21Z 64.7% (−$48.94)** — 10/17 are KDEN entries; watch at #5 (2026-06-19).
  - ⚠ **0.85–0.90 conf bucket 74.2% (n=31, <75%)** — 9/31 KDEN; watch at #4 (2026-06-19).
  - **Green:** #1 CLI actuals `cli|36` (last 2d); #2 confirmation exit churn = 0; gate sweep (#9) shows **no NEW n≥10 COSTING family** — already-hold (83.1%/n=65), recent-loss (85.7%/n=14), other (78.6%/n=14) all previously characterized as event-cap design-correct / red-herring KDEN negative-edge blocks.
  - **No config changes** — nothing due today (weeklies #1/#2/#9 checked 06-15 → next 06-22; #11 handled this morning → 06-19); numbers identical to the morning sweep, so per the ambiguity guardrail no knobs touched. All eyes on the **#4 80% verdict (2026-06-19).**

- **2026-06-16 — follow-ups sweep (only #11 due; weeklies #1/#2/#9 ran 06-15 → next 06-22):**
  - **⚠ PnL volatility event (not a collapse):** equity dropped **$566.65 → $515.93 (−$51)** on 06-16; cumulative realized PnL $58.51 → $17.93. Cause: a **correlated two-leg KMIA loss on the 26JUN15 event** — `B93.5` confirm_yes (25c@80¢, −$19.82) + `T94` confirm_no (44c@82¢, −$19.68), both settled at the high tail (≈$39.50 combined). Same correlated-stacking failure mode as KDEN Jun 12. The event-exposure cap (`max_event_exposure_pct_of_balance=0.15`) permitted both legs (~$56 cost < ~$71 cap at the time). Under pct sizing these were 25/44 contracts vs ~6 flat — the loss was ~4× what the flat-$5 era would have produced.
  - **Health checks all green:** ground-truth health 96.7% (n=180, >90% line; only disabled KORD at 80%); #1 CLI actuals `cli|36` last 2 days; #2 confirmation exit churn = 0; all 133 regime orders `dry_run=1` (paper, safe).
  - **#11 first-week read — sizing functioning, left UNCHANGED:** `grep pct-size` (14 entries) shows realized sizes **4.8%–8.4% of balance**, confidence-ramped (conf 0.88→0.96 = 4.8%→8.4%) — squarely in the expected ~3.4–9.6% band. **Zero `at max exposure` skips** — the 12% cap is not clipping legitimate single entries. PnL is **scaling positively on net** (equity peaked +$66 on 06-15 vs flat era's lower peaks; +$15.93 over the regime even after the 06-16 hit). Per #11's three branches the data is closest to "clean & scaling positively → leave it and revisit max% at the #4 verdict." The "net worse" branch is NOT met (equity net positive, higher peak than flat era), so per the ambiguity guardrail **no sizing knob was changed**. The amplified-correlated-loss risk is the key thing to weigh at #4. **Due bumped to 2026-06-19 to coincide with the #4 verdict.**
  - **Carry to #4 (2026-06-19):** evaluate whether to (a) tighten `max_event_exposure_pct_of_balance` (0.15) and/or add a same-event opposite-bracket guard so pct sizing can't stack two large correlated legs (KDEN Jun12 + KMIA Jun15 are two such events now), and (b) only then revisit `confidence_size_max_pct`.
  - **Fixed a pre-existing time-bomb test** (unrelated to the sweep): two `checkGroundTruthHealth` tests hardcoded `2026-06-01/02` target dates that have now aged out of production's rolling 14d window (`targetDate >= now-14d`), so they failed with n=1. Anchored the seed dates to `Date.now()` (daysAgo helper) so they always sit in-window. 777/777 green.
  - **`wins summary`: 84.8% (n=92), pnl +$1.95.** Headline is dragged by now-disabled KDEN's 74.2% (n=31); **active KAUS+KMIA portfolio is 90.2% (55/61)** — KAUS 91.9% +$28.21, KMIA 87.5% +$9.50. 21Z (64.7%, −$48.94) and the 0.85–0.90 conf bucket (74.2%) are both ≥half KDEN entries (21Z: 10/17 KDEN; bucket: 9/31 KDEN) — expected to lift now that KDEN is frozen. Watch at #4/#5.

- **2026-06-15 — performance review + follow-ups sweep (weeklies #1/#2/#9; #3 closed; #12 acted early):**
  - **Overall:** 87.1% (n=85), +$70.34 pnl — down from 89.8% on 2026-06-11 (n=49). KDEN is the drag.
  - **#1 ✅ weekly:** `cli|36` actuals in last 2 days — ground-truth healthy.
  - **#2 ✅ weekly:** confirmation 91.0% (n=78), zero exit churn — healthy. Next: 2026-06-22.
  - **#9 ✅ weekly gate sweep:** `edge<threshold` (314, 3.2%), `scout mode` (322, 28.6%), `contra-market` (37, 16.2%), `station health` (14, 28.6%), `obs stale` (9, 0%) — all SAVING. `already hold` (60, 86.7%) ⚠ COSTING — growing but is event-exposure-cap blocking additional correlated positions (design correct; watching vs raising `max_event_exposure_pct_of_balance`). `recent-loss` (13, 92.3%) ⚠ COSTING — **red herring again** (all negative-edge KDEN signals). `other` (12, 75%) ⚠ COSTING but on inspection: event-exposure-cap overflow + dust-bet + lottery-filter blocks — all correct; not real leakage. `coin-flip` (8, 62.5%) and `cooldown` (8, 75%) both approaching n=10 — watch next week. Next: 2026-06-22.
  - **#3 ✅ closed — ultra-sniper verdict:** 21Z degraded to 60% (−$58.97) and 22Z negative (−$27.69). Root cause is **KDEN not ultra-sniper**: 21Z KDEN 50% (n=10, pre-peak for Denver), 21Z KAUS 80% (n=5) — KAUS/KMIA post-peak entries are performing well (22Z KAUS 100%). Ultra-sniper stays enabled; KDEN disable (below) addresses the bleeding.
  - **#12 ✅ acted early — KDEN disabled:** KDEN net −$35.76 since tightening (74.2%, n=31). Both pathways failing: confirmation 81.5% (n=27, below ~89% fee-adj breakeven at 86¢ avg); contrarian 1/4 = 25%. Jun 12 was the disaster event (both sides of 90-91° bracket lost on same day — correlated stacked entries). **`disabled_stations` set to `KORD,KLAX,KNYC,KDEN` via ops set.** Without KDEN: KAUS 93.8% +$39.78, KMIA 95.5% +$66.32 → portfolio improves substantially. Revisit at #7 probation check (2026-06-19).

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
