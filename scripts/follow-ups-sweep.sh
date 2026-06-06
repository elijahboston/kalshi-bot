#!/bin/bash
# Daily follow-ups sweep — invoked headless by launchd
# (~/Library/LaunchAgents/com.elijah.kalshi-bot.follow-ups.plist, 8:53am daily).
#
# Runs Claude Code in print mode with full autonomy to execute the canonical
# sweep defined in docs/follow-ups.md §"Scheduled automation": check due items
# against the live DB, act within the hard guardrails (never dry_run=false,
# never delete data, never new categories), log outcomes, commit if green.
#
# Manual run:  bash scripts/follow-ups-sweep.sh
# Output:      logs/follow-ups-sweep.log (gitignored)

set -euo pipefail

REPO="/Users/elijah/projects/kalshi-bot"
CLAUDE_BIN="/opt/homebrew/bin/claude"
LOG="$REPO/logs/follow-ups-sweep.log"

cd "$REPO"
mkdir -p logs

{
  echo ""
  echo "===== follow-ups sweep $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="

  # PATH for the tools the sweep needs (bun, sqlite3, git) — launchd provides
  # a minimal environment, so be explicit.
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

  "$CLAUDE_BIN" -p \
    --dangerously-skip-permissions \
    --max-turns 100 \
    "You are the scheduled daily follow-ups sweep for the kalshi-bot repo (running headless via launchd — there is no user to ask; skip any CronCreate/CronList re-arm steps, launchd handles scheduling). Read docs/follow-ups.md, especially the 'Scheduled automation' section, and execute its canonical sweep prompt exactly: compare Due dates to today, run due items' checks against ./data/kalshi-bot.db and logs/bot.log, ACT under full autonomy where decision criteria are unambiguously met, respect every guardrail (never set dry_run=false, never delete data, never expand market categories), record outcomes in the file's Log section, run bun test, and commit+push doc/config changes only if tests are green. End with the compact status summary." \
    2>&1

  echo "===== sweep done $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit $?) ====="
} >> "$LOG"
