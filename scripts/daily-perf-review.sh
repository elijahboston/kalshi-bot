#!/bin/bash
# Daily performance review — invoked by launchd at 10:00am, after the 9:55am snapshot.
#
# Runs Claude Code in headless print mode to review recent bot performance:
# wins summary, gate sweep, station/hour/confidence breakdowns, due follow-ups,
# and any config actions within the hard guardrails. Logs to docs/follow-ups.md.
#
# Manual run:  bash scripts/daily-perf-review.sh
# Output:      logs/daily-perf-review.log (gitignored)

set -euo pipefail

REPO="/Users/elijah/projects/kalshi-bot"
CLAUDE_BIN="/opt/homebrew/bin/claude"
LOG="$REPO/logs/daily-perf-review.log"

cd "$REPO"
mkdir -p logs

# Honour the same pause sentinel as the follow-ups sweep.
if [ -f "$REPO/.sweep-paused" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) perf-review skipped: .sweep-paused sentinel present" >> "$LOG"
  exit 0
fi

{
  echo ""
  echo "===== daily-perf-review $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="

  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

  "$CLAUDE_BIN" -p \
    --dangerously-skip-permissions \
    --max-turns 60 \
    "You are the scheduled daily performance review for the kalshi-bot (running headless via launchd — no user to ask; skip CronCreate/CronList steps). Working directory: /Users/elijah/projects/kalshi-bot. Regime boundary for all measurements: 2026-06-05T20:00Z.

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
- Gate family with n≥10 and would-win% > 50% that wasn't flagged last time
- 21Z hour win rate < 70% or still showing negative PnL (watch item from 2026-06-11)
- KDEN PnL flipping negative (watch item #12, due 2026-06-17)
- CLI actuals: zero 'cli' rows in last 2 days (ground-truth regression)
- Confirmation exit churn > 0 (policy regression)
- Any confidence bucket with n≥5 and win rate < 75%

## Step 5 — Due follow-up items
Read docs/follow-ups.md. For every item whose Due date is today or earlier (including 'weekly' items last checked ≥7 days ago per the Log), run its exact Check query, then act per its Decide column. Config changes via: bun ops set <key> <value> --why 'follow-up #N: <reason>'
GUARDRAILS: never set dry_run=false; never delete data; never add market categories; if anything alarming surfaces, log it loudly before acting on anything else.

## Step 6 — Log
Append a new entry to docs/follow-ups.md Log section (newest first), recording: date, items checked, ⚠ findings, actions taken or deferred, current 'wins summary' line. Then run bun test — commit and push only if tests are green. Only create a commit if you made actual changes (config sets or doc updates).

## Step 7 — Summary line
End your response with exactly one line:
  PERF-REVIEW: <win_rate>% (n=<n>) pnl=<pnl> | actions: <list or 'none'>" \
    2>&1

  echo "===== perf-review done $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit $?) ====="
} >> "$LOG"
