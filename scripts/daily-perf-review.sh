#!/bin/bash
# Daily performance review — invoked by launchd at 10:00am, after the 9:55am snapshot.
#
# Runs Claude Code in headless print mode to review recent bot performance:
# wins summary, gate sweep, station/hour/confidence breakdowns, due follow-ups,
# and any config actions within the hard guardrails. Logs to docs/follow-ups.md.
#
# Also appends a markdown section to docs/YYYY-MM-DD-log.md and commits the
# complete daily log to git (as the last agent to run each day).
#
# Manual run:  bash scripts/daily-perf-review.sh
# Output:      logs/daily-perf-review.log (gitignored)
#              docs/YYYY-MM-DD-log.md     (tracked, committed here)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_BIN="/opt/homebrew/bin/claude"
LOG="$REPO/logs/daily-perf-review.log"
TODAY="$(date +%Y-%m-%d)"
DAILY_LOG="$REPO/docs/$TODAY-log.md"
TMPOUT="$(mktemp /tmp/kalshi-perf-XXXXXX.txt)"

cd "$REPO"
mkdir -p logs

trap 'rm -f "$TMPOUT"' EXIT

# Honour the same pause sentinel as the follow-ups sweep.
if [ -f "$REPO/.sweep-paused" ]; then
  MSG="$(date -u +%Y-%m-%dT%H:%M:%SZ) perf-review skipped: .sweep-paused sentinel present"
  echo "$MSG" >> "$LOG"
  [ ! -f "$DAILY_LOG" ] && printf "# Daily Log — %s\n\n" "$TODAY" > "$DAILY_LOG"
  printf "## 10:00 — Performance Review\n\n> Skipped: \`.sweep-paused\` sentinel present.\n\n" >> "$DAILY_LOG"
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Initialize daily log header if neither prior agent ran today.
if [ ! -f "$DAILY_LOG" ]; then
  printf "# Daily Log — %s\n\n" "$TODAY" > "$DAILY_LOG"
fi

{
  echo ""
  echo "===== daily-perf-review $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
} >> "$LOG"

# Capture claude output so we can write it to both logs.
set +e
"$CLAUDE_BIN" -p \
  --dangerously-skip-permissions \
  --max-turns 60 \
  "You are the scheduled daily performance review for the kalshi-bot (running headless via launchd — no user to ask; skip CronCreate/CronList steps). Working directory: $REPO. Regime boundary for all measurements: 2026-06-05T20:00Z.

## Step 1 — Bot health
Run: bun ops status
Run: bun ops due

## Step 2 — Wins scoreboard
Run via bun -e (from the repo root):
  const { winsCommands } = await import('./app/cli/src/commands/wins.ts');
  const cmd = winsCommands[0];
  console.log(await cmd.handler(['summary']));
  console.log(await cmd.handler(['by_gate']));
  console.log(await cmd.handler(['by_station']));
  console.log(await cmd.handler(['by_confidence']));
  console.log(await cmd.handler(['by_hour']));

## Step 3 — Weekly health checks
Run these SQL checks against data/kalshi-bot.db:
- CLI actuals flowing (#1): SELECT actual_source, COUNT(*) FROM weather_forecasts WHERE actual_value IS NOT NULL AND fetched_at >= date('now','-2 days') GROUP BY 1
- Confirmation churn (#2): SELECT COUNT(*) FROM orders o JOIN signals s ON o.signal_id=s.id WHERE o.action='sell' AND s.recommendation LIKE 'confirm%' AND o.created_at >= '2026-06-06T18:00'

## Step 4 — Surface ⚠ findings (lead any alarming item)
Flag if ANY of:
- Overall win rate < 85% (approaching the 80% target with shrinking cushion)
- Gate family with n>=10 and would-win% > 50% that wasn't flagged last time
- 21Z hour win rate < 70% or still showing negative PnL (watch item from 2026-06-11)
- CLI actuals: zero 'cli' rows in last 2 days (ground-truth regression)
- Confirmation exit churn > 0 (policy regression)
- Any confidence bucket with n>=5 and win rate < 75%

## Step 5 — Due follow-up items
Read docs/follow-ups.md. For every item whose Due date is today or earlier (including 'weekly' items last checked >=7 days ago per the Log), run its exact Check query, then act per its Decide column. Config changes via: bun ops set <key> <value> --why 'follow-up #N: <reason>'
GUARDRAILS: never set dry_run=false; never delete data; never add market categories; if anything alarming surfaces, log it loudly before acting on anything else.

## Step 6 — Log
Append a new entry to docs/follow-ups.md Log section (newest first), recording: date, items checked, findings, actions taken or deferred, current 'wins summary' line. Then run bun test — commit and push only if tests are green. Only create a commit if you made actual changes (config sets or doc updates). Do NOT commit docs/${TODAY}-log.md — the bash wrapper handles that.

## Step 7 — Summary line
End your response (stdout) with exactly one line:
  PERF-REVIEW: <win_rate>% (n=<n>) pnl=<pnl> | actions: <list or 'none'>

## Step 8 — Obsidian daily note
Write a concise daily summary to the Obsidian vault. The vault is at $OBSIDIAN_VAULT (set OBSIDIAN_VAULT in the environment; skip this step if unset).
Target path: $OBSIDIAN_VAULT/Projects/ClimateBot/Daily Logs/<TODAY>-daily-log.md
(replace <TODAY> with today's YYYY-MM-DD date)

Check whether that file already exists (use the Read tool or Bash ls):
- If it does NOT exist: use the Write tool to create it with this structure:
---
title: \"ClimateBot Daily Log — <TODAY>\"
date: <TODAY>
tags: [climatebot, kalshi, trading, daily-log, complete]
source: automated-sweep
---

# ClimateBot Daily Log — <TODAY>

## Morning Sweep

<compact 3–6 bullet summary: win rate, pnl, n, key flags or soft flags, actions taken or none>

## Guardrails

<green/amber/red status for each weekly check>

## Next

<upcoming due items with dates>

- If it ALREADY EXISTS: use the Edit tool to append a '## Morning Sweep' section at the end of the file, with the same compact content. Do NOT overwrite the file or remove existing content.

Use the Write or Edit tools to write the file — do NOT print the note content to stdout. After writing, output a single confirmation line: 'Obsidian note written: <path>'." \
  > "$TMPOUT" 2>&1
CLAUDE_EXIT=$?
set -e

cat "$TMPOUT" >> "$LOG"
{
  echo "===== perf-review done $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit $CLAUDE_EXIT) ====="
} >> "$LOG"

# Append section to daily log.
{
  printf "## 10:00 — Performance Review\n\n"
  cat "$TMPOUT"
  if [ $CLAUDE_EXIT -ne 0 ]; then
    printf "\n> ⚠ Review exited with code %d\n" "$CLAUDE_EXIT"
  fi
  printf "\n"
} >> "$DAILY_LOG"

# Commit the complete daily log (last agent to run, so the log is now complete).
git add "$DAILY_LOG"
if ! git diff --cached --quiet; then
  git commit -m "docs: daily log $TODAY" --no-verify 2>&1 | tee -a "$LOG" || true
  git push 2>&1 | tee -a "$LOG" || true
fi

exit $CLAUDE_EXIT
