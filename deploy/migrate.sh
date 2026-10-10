#!/bin/sh
# Apply any migrations this database has not seen yet.
#
# WHY THIS EXISTS
#
# The deploy workflow rsynced code and restarted the service with no migration step
# anywhere — and the server has none either (`openDatabase()` is just `new SqliteDb(path)`).
# So every migration deployed code that expected a schema the server did not have. That is
# not hypothetical: `0017_memory_dates.sql` added `facts.at`, and without it extraction threw
# `no such column: at` on every attempt, the Memory screen 500'd, and recall failed silently
# inside the prompt builder's catch.
#
# The `db:migrate` scripts in package.json are `wrangler d1 migrations apply --remote` — the
# Cloudflare D1 path, which cannot touch the VPS's SQLite file. Nothing called them from the
# workflow. This is the VPS equivalent.
#
# HOW "ALREADY APPLIED" IS DECIDED
#
# By the `d1_migrations` ledger, NOT by a table of our own. That table is Wrangler's, and the
# VPS database carries it because the schema was imported from D1 — so it is the one
# authoritative record of what has run, and it already knows about 0000-0013. A parallel
# ledger would start empty and replay everything, which is not merely wasteful:
#
#   0013_presets_authored.sql is DESTRUCTIVE and NOT re-runnable. Its first statement is
#     `DELETE FROM presets WHERE prompt_json IS NOT NULL OR regex_json IS NOT NULL;`
#   and it then drops and rebuilds the `presets` table without those columns. Replaying it
#   would delete the reader's imported presets a second time. It is in the ledger, so it is
#   skipped — which is exactly why the ledger and not a schema probe decides.
#
# THE LEDGER CAN LAG THE SCHEMA, AND THAT IS EXPECTED
#
# The runbook migrated a VPS with `for f in migrations/*.sql; do sqlite3 < "$f"; done`, which
# never wrote to the ledger. So the ledger records 0000-0013 (as imported from D1) while the
# schema already has 0014-0016 applied by hand. Those files are therefore not in the ledger
# but ARE applied, and re-running one fails on `duplicate column name`.
#
# That failure is benign, and it is safe to treat as "already applied" for the reason above:
# everything the runbook could have applied by hand without recording is an ADDITIVE `ALTER`
# or an idempotent backfill. The one destructive migration in the set is 0013, and it is
# already in the ledger. So a `duplicate column name` / `already exists` error means the work
# is done, and the ledger is updated to say so. Any OTHER error aborts with a non-zero exit,
# which fails the deploy rather than restarting into a broken schema.
#
# Once this script owns the deploy, every future migration is recorded when it runs and this
# tolerance stops mattering.
#
# Usage: migrate.sh [database-path]
set -eu

DB="${1:-${DATABASE_PATH:-/srv/tessera/data/tessera.sqlite}}"
DIR="$(dirname "$0")/../migrations"

if [ ! -f "$DB" ]; then
  echo "migrate: no database at $DB" >&2
  exit 1
fi
if [ ! -d "$DIR" ]; then
  echo "migrate: no migrations directory at $DIR" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "migrate: sqlite3 not installed" >&2
  exit 1
fi

if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='d1_migrations';")" = "0" ]; then
  cat >&2 <<'ADOPT'
migrate: this database has no `d1_migrations` ledger, so there is no record of which
migrations have run. Refusing to guess: replaying could re-run destructive SQL.

If the schema is already up to date (the normal case for a runbook-migrated VPS), record
that fact once and re-run this script:

  for f in $(ls /srv/tessera/migrations/*.sql | sort); do
    n=$(basename "$f")
    sqlite3 /srv/tessera/data/tessera.sqlite \
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER);
       INSERT INTO d1_migrations (name, applied_at)
       SELECT '$n', strftime('%s','now')
        WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '$n');"
  done
  # then delete the name of the ONE migration you want applied, if any.

If the schema is NOT up to date, run the migrations that have not been applied by hand
first (see docs/vps-deploy.md), then adopt as above.
ADOPT
  exit 1
fi

applied=0
skipped=0

# Sorted, so migrations apply in filename order. `ls | sort` rather than a glob because
# globbing inside a pipeline is not guaranteed sorted by POSIX.
for file in $(ls "$DIR"/*.sql | sort); do
  name="$(basename "$file")"

  if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM d1_migrations WHERE name = '$name';")" != "0" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  echo "migrate: applying $name"
  # `.bail on` stops at the first error so a half-applied file is never reported as success.
  # The output is captured rather than streamed because the ledger insert must only happen
  # when the file actually ran, or when the error proves it had already run.
  if output="$(sqlite3 -bail "$DB" < "$file" 2>&1)"; then
    sqlite3 "$DB" "INSERT INTO d1_migrations (name, applied_at) VALUES ('$name', strftime('%s','now'));"
    applied=$((applied + 1))
  elif echo "$output" | grep -qE 'duplicate column name|already exists'; then
    # Applied by hand by the runbook, which never wrote to the ledger. See the header: every
    # migration that could be in this state is additive, so the error proves the work is done.
    echo "migrate: $name was already applied (ledger was behind) — recording"
    sqlite3 "$DB" "INSERT INTO d1_migrations (name, applied_at) VALUES ('$name', strftime('%s','now'));"
    skipped=$((skipped + 1))
  else
    echo "migrate: FAILED on $name" >&2
    echo "$output" >&2
    exit 1
  fi
done

echo "migrate: done — $applied applied, $skipped already recorded"
