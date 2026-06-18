#!/bin/bash
# Daily follow-ups sweep — invoked headless by launchd
# (~/Library/LaunchAgents/com.elijah.kalshi-bot.follow-ups.plist, 8:53am daily).
#
# Runs Claude Code in print mode with full autonomy to execute the canonical
# sweep defined in docs/follow-ups.md §"Scheduled automation": check due items
# against the live DB, act within the hard guardrails (never dry_run=false,
# never delete data, never new categories), log outcomes, commit if green.
#
# Also appends a markdown section to docs/YYYY-MM-DD-log.md for the daily log.
#
# Manual run:  bash scripts/follow-ups-sweep.sh
# Output:      logs/follow-ups-sweep.log (gitignored)
#              docs/YYYY-MM-DD-log.md    (tracked)

set -euo pipefail

REPO="/Users/elijah/projects/kalshi-bot"
CLAUDE_BIN="/opt/homebrew/bin/claude"
LOG="$REPO/logs/follow-ups-sweep.log"
TODAY="$(date +%Y-%m-%d)"
DAILY_LOG="$REPO/docs/$TODAY-log.md"
TMPOUT="$(mktemp /tmp/kalshi-sweep-XXXXXX.txt)"

cd "$REPO"
mkdir -p logs

trap 'rm -f "$TMPOUT"' EXIT

# Pause sentinel — `bun ops pause` creates it, `bun ops resume` removes it.
if [ -f "$REPO/.sweep-paused" ]; then
  MSG="$(date -u +%Y-%m-%dT%H:%M:%SZ) sweep skipped: .sweep-paused sentinel present (bun ops resume to re-enable)"
  echo "$MSG" >> "$LOG"
  # Still note the skip in the daily log
  [ ! -f "$DAILY_LOG" ] && printf "# Daily Log — %s\n\n" "$TODAY" > "$DAILY_LOG"
  printf "## 08:53 — Follow-ups Sweep\n\n> Skipped: \`.sweep-paused\` sentinel present.\n\n---\n\n" >> "$DAILY_LOG"
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Initialize daily log header if this is the first writer today.
if [ ! -f "$DAILY_LOG" ]; then
  printf "# Daily Log — %s\n\n" "$TODAY" > "$DAILY_LOG"
fi

{
  echo ""
  echo "===== follow-ups sweep $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
} >> "$LOG"

# Capture claude output so we can write it to both logs.
set +e
"$CLAUDE_BIN" -p \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "You are the scheduled daily follow-ups sweep for the kalshi-bot repo (running headless via launchd — there is no user to ask; skip any CronCreate/CronList re-arm steps, launchd handles scheduling). Read docs/follow-ups.md, especially the 'Scheduled automation' section, and execute its canonical sweep prompt exactly: compare Due dates to today, run due items' checks against ./data/kalshi-bot.db and logs/bot.log, ACT under full autonomy where decision criteria are unambiguously met, respect every guardrail (never set dry_run=false, never delete data, never expand market categories), record outcomes in the file's Log section, run bun test, and commit+push doc/config changes only if tests are green. End with the compact status summary. IMPORTANT: Do NOT write directly to docs/*-log.md files — the bash wrapper that invokes you captures your stdout and appends it to the daily log automatically. Only write to docs/follow-ups.md." \
  > "$TMPOUT" 2>&1
CLAUDE_EXIT=$?
set -e

cat "$TMPOUT" >> "$LOG"
{
  echo "===== sweep done $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit $CLAUDE_EXIT) ====="
} >> "$LOG"

# Append section to daily log.
{
  printf "## 08:53 — Follow-ups Sweep\n\n"
  cat "$TMPOUT"
  if [ $CLAUDE_EXIT -ne 0 ]; then
    printf "\n> ⚠ Sweep exited with code %d\n" "$CLAUDE_EXIT"
  fi
  printf "\n---\n\n"
} >> "$DAILY_LOG"

exit $CLAUDE_EXIT
