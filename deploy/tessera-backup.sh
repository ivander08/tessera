#!/usr/bin/env bash
# Nightly .backup of the live SQLite database. Installed to /usr/local/bin/tessera-backup
# and run by tessera-backup.timer. This is the replacement for D1's managed backups:
# on a VPS nobody else snapshots the file, so if this does not run, there is no copy.
set -euo pipefail

# DATABASE_PATH comes from the same EnvironmentFile as the app. The fallback keeps a
# manual invocation working when the script is run by hand outside systemd.
DATABASE_PATH="${DATABASE_PATH:-/srv/tessera/data/tessera.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups}"
KEEP="${KEEP:-28}"

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/tessera-$(date +%F-%H%M).sqlite"

# `.backup`, never `cp`. The database runs in WAL mode, so recent commits live in the
# -wal sidecar; a file copy taken mid-write can capture a torn page and no WAL, and the
# result does not open. `.backup` uses SQLite's online backup API and produces a single
# consistent file including everything already checkpointed or still in the WAL.
sqlite3 "$DATABASE_PATH" ".backup '$OUT'"

# Keep the newest $KEEP; 28 six-hourly runs is a week of history. Newest-first by mtime,
# skip the first $KEEP, delete the rest. `-r` keeps the empty case from erroring under
# `set -e` before the first backup ever lands.
ls -1t "$BACKUP_DIR"/tessera-*.sqlite 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
