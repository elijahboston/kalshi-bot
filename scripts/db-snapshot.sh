#!/bin/bash
# Daily DB snapshot — invoked by launchd at 9:55am, before the 10am perf review.
#
# Uses SQLite's `.backup` command for a consistent copy even while the bot is
# writing. Keeps the last 7 days of snapshots and rotates older ones.
#
# Manual run:  bash scripts/db-snapshot.sh
# Output:      data/snapshots/kalshi-bot-YYYY-MM-DD.db
#              logs/db-snapshot.log

set -euo pipefail

REPO="/Users/elijah/projects/kalshi-bot"
DB="$REPO/data/kalshi-bot.db"
SNAP_DIR="$REPO/data/snapshots"
LOG="$REPO/logs/db-snapshot.log"
KEEP_DAYS=7

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO"
mkdir -p "$SNAP_DIR" logs

{
  echo ""
  echo "===== db-snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="

  DEST="$SNAP_DIR/kalshi-bot-$(date +%Y-%m-%d).db"

  if [ ! -f "$DB" ]; then
    echo "ERROR: source DB not found at $DB"
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
