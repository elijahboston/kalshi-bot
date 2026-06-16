#!/bin/bash
# Daily DB snapshot — invoked by launchd at 9:55am, before the 10am perf review.
#
# Uses SQLite's `.backup` command for a consistent copy even while the bot is
# writing. Keeps the last 7 days of snapshots and rotates older ones.
#
# Also appends a markdown section to docs/YYYY-MM-DD-log.md for the daily log.
#
# Manual run:  bash scripts/db-snapshot.sh
# Output:      data/snapshots/kalshi-bot-YYYY-MM-DD.db
#              logs/db-snapshot.log
#              docs/YYYY-MM-DD-log.md    (tracked)

set -euo pipefail

REPO="/Users/elijah/projects/kalshi-bot"
DB="$REPO/data/kalshi-bot.db"
SNAP_DIR="$REPO/data/snapshots"
LOG="$REPO/logs/db-snapshot.log"
TODAY="$(date +%Y-%m-%d)"
DAILY_LOG="$REPO/docs/$TODAY-log.md"
KEEP_DAYS=7

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO"
mkdir -p "$SNAP_DIR" logs

# Initialize daily log header if the sweep didn't run first.
if [ ! -f "$DAILY_LOG" ]; then
  printf "# Daily Log — %s\n\n" "$TODAY" > "$DAILY_LOG"
fi

{
  echo ""
  echo "===== db-snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="

  DEST="$SNAP_DIR/kalshi-bot-$TODAY.db"

  if [ ! -f "$DB" ]; then
    echo "ERROR: source DB not found at $DB"
    # Note failure in daily log before exiting.
    printf "## 09:55 — DB Snapshot\n\n> ⚠ ERROR: source DB not found at \`%s\`\n\n---\n\n" "$DB" >> "$DAILY_LOG"
    exit 1
  fi

  sqlite3 "$DB" ".backup '$DEST'"
  SIZE=$(du -sh "$DEST" | cut -f1)
  echo "snapshot written: $DEST ($SIZE)"

  # Rotate: delete snapshots older than KEEP_DAYS
  find "$SNAP_DIR" -name "kalshi-bot-*.db" -mtime +"$KEEP_DAYS" -delete
  REMAINING=$(ls "$SNAP_DIR"/kalshi-bot-*.db 2>/dev/null | wc -l | tr -d ' ')
  echo "snapshots retained: $REMAINING (policy: last $KEEP_DAYS days)"

  echo "===== snapshot done $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
} >> "$LOG" 2>&1

# Append section to daily log.
{
  printf "## 09:55 — DB Snapshot\n\n"
  printf "| | |\n|---|---|\n"
  printf "| **File** | \`data/snapshots/kalshi-bot-%s.db\` |\n" "$TODAY"
  printf "| **Size** | %s |\n" "$(du -sh "$SNAP_DIR/kalshi-bot-$TODAY.db" 2>/dev/null | cut -f1 || echo 'unknown')"
  REMAINING=$(ls "$SNAP_DIR"/kalshi-bot-*.db 2>/dev/null | wc -l | tr -d ' ')
  printf "| **Retained** | %s snapshot(s) (7-day policy) |\n" "$REMAINING"
  printf "\n---\n\n"
} >> "$DAILY_LOG"
