#!/usr/bin/env bash
#
# Converges a Tessera VPS from ANY partial state to a working one.
#
# The runbook's numbered steps assume a clean box. A box that was half-configured while
# the runbook was still being corrected is not one, and re-reading the steps to work out
# which half you are in is the confusing part. This script replaces that: every step
# below is idempotent, so running it twice changes nothing the second time, and running
# it on a half-done box finishes the job.
#
# It does NOT touch the database. /srv/tessera/data is left exactly as it is, so it is
# safe to run after §6 has imported your data.
#
# Usage:
#   sudo ./deploy/setup-vps.sh                  # converge everything
#   sudo ./deploy/setup-vps.sh --check          # report only, change nothing
#   sudo ./deploy/setup-vps.sh --token <token>  # also write /etc/tessera.env
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER=tessera
DEPLOY_USER=tessera-deploy
ENV_FILE=/etc/tessera.env
DATA_DIR="$REPO_DIR/data"

CHECK_ONLY=false
TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=true ;;
    --token) shift; TOKEN="${1:-}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  echo "run this with sudo" >&2
  exit 1
fi

ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
fix()  { printf '  \033[33mFIX\033[0m   %s\n' "$1"; }
skip() { printf '  \033[90m--\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

FAILED=0

# Run a command, or report what would be run under --check.
apply() {
  local description="$1"; shift
  if $CHECK_ONLY; then fix "$description"; else "$@"; fix "$description"; fi
}

section "1. Packages"

for pkg in bun caddy sqlite3; do
  if command -v "$pkg" >/dev/null 2>&1; then
    ok "$pkg present ($(command -v "$pkg"))"
  else
    bad "$pkg MISSING — see docs/vps-deploy.md §2"
    FAILED=1
  fi
done

# The unit calls bun by absolute path, so a bun that only exists in ~/.bun is not enough.
if [ -x /usr/local/bin/bun ]; then
  ok "/usr/local/bin/bun present"
else
  bad "/usr/local/bin/bun missing — the systemd unit calls it by absolute path"
  FAILED=1
fi

section "2. Users"

if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user $SERVICE_USER exists"
else
  apply "create system user $SERVICE_USER" \
    useradd --system --home-dir "$REPO_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

if id "$DEPLOY_USER" >/dev/null 2>&1; then
  ok "user $DEPLOY_USER exists"
else
  apply "create deploy user $DEPLOY_USER" \
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

# CI rsyncs as the deploy user into a tree owned by the service user, so it needs the
# group. `usermod -aG` is idempotent — re-adding an existing membership is a no-op.
# Only add when missing. `usermod -aG` is idempotent, but calling it unconditionally
# printed FIX on every run, which makes the report useless as a "what changed" summary.
if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx "$SERVICE_USER"; then
  ok "$DEPLOY_USER is in group $SERVICE_USER"
else
  apply "add $DEPLOY_USER to group $SERVICE_USER" \
    usermod -aG "$SERVICE_USER" "$DEPLOY_USER"
fi

section "3. Ownership and permissions"

# The service must READ the app (server/, dist/, migrations/) and WRITE only data/.
# Getting this half-right is the failure the old runbook caused: it chowned only data/,
# so the service could not read server/index.ts and died on startup.
if $CHECK_ONLY; then
  ls -ld "$REPO_DIR" "$DATA_DIR" 2>/dev/null || true
else
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$DATA_DIR"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"
  # Group-write so the deploy user can rsync into it. `chmod -R g+w` on a tree owned by
  # tessera:tessera grants that to group tessera, which is why the usermod above matters.
  chmod -R g+w "$REPO_DIR"
  fix "chown -R $SERVICE_USER:$SERVICE_USER $REPO_DIR"
  fix "chmod -R g+w $REPO_DIR"
fi

if sudo -u "$SERVICE_USER" test -r "$REPO_DIR/server/index.ts" 2>/dev/null; then
  ok "$SERVICE_USER can read server/index.ts"
else
  bad "$SERVICE_USER CANNOT read server/index.ts — the service will fail to start"
  FAILED=1
fi

if sudo -u "$SERVICE_USER" test -w "$DATA_DIR" 2>/dev/null; then
  ok "$SERVICE_USER can write data/"
else
  bad "$SERVICE_USER CANNOT write data/ — SQLite will fail"
  FAILED=1
fi

# Setgid on directories so files rsync creates inherit the tessera group. Without it a
# deploy writes files owned by the deploy user's own group, and the service cannot read
# them — a failure that appears only on the *next* deploy, not this one.
if ! $CHECK_ONLY; then
  find "$REPO_DIR" -type d -exec chmod g+s {} + 2>/dev/null || true
fi

# The error output is NOT discarded. `sudo -u` can fail for reasons that have nothing to
# do with permissions — a missing home directory, a PAM refusal, a bad sudoers entry — and
# swallowing stderr turns every one of them into a misleading "cannot write".
write_probe="$(sudo -u "$DEPLOY_USER" sh -c "id -nG; ls -ld '$REPO_DIR'; touch '$REPO_DIR/.write-probe' && echo PROBE-OK || echo PROBE-FAIL" 2>&1)"
if printf '%s' "$write_probe" | grep -q PROBE-OK; then
  ok "$DEPLOY_USER can write the tree (CI rsync)"
  $CHECK_ONLY || rm -f "$REPO_DIR/.write-probe"
else
  bad "$DEPLOY_USER CANNOT write the tree — CI deploys will fail"
  printf '%s\n' "$write_probe" | sed 's/^/        /'
  FAILED=1
fi

section "4. Environment file"

if [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE exists"
  if grep -q '^TESSERA_TOKEN=.\+' "$ENV_FILE"; then
    ok "TESSERA_TOKEN is set"
  else
    bad "TESSERA_TOKEN is empty — every request will 401"
    FAILED=1
  fi
  if grep -q "^DATABASE_PATH=$DATA_DIR/tessera.sqlite" "$ENV_FILE"; then
    ok "DATABASE_PATH points at $DATA_DIR/tessera.sqlite"
  else
    bad "DATABASE_PATH does not point at $DATA_DIR/tessera.sqlite:"
    grep '^DATABASE_PATH=' "$ENV_FILE" | sed 's/^/        /'
    FAILED=1
  fi
elif [ -n "$TOKEN" ]; then
  if $CHECK_ONLY; then
    fix "would write $ENV_FILE"
  else
    install -m 600 -o root -g root /dev/null "$ENV_FILE"
    {
      echo "TESSERA_TOKEN=$TOKEN"
      echo "APP_NAME=Tessera"
      echo "DATABASE_PATH=$DATA_DIR/tessera.sqlite"
      echo "PORT=8787"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    fix "wrote $ENV_FILE"
  fi
else
  bad "$ENV_FILE missing — re-run with --token <the existing token>"
  FAILED=1
fi

section "5. systemd units"

install_unit() {
  local src="$1" dest="$2" mode="$3"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    ok "$(basename "$dest") is current"
  else
    apply "install $(basename "$dest")" install -m "$mode" "$src" "$dest"
  fi
}

install_unit "$REPO_DIR/deploy/tessera.service"        /etc/systemd/system/tessera.service        0644
install_unit "$REPO_DIR/deploy/tessera-backup.service" /etc/systemd/system/tessera-backup.service 0644
install_unit "$REPO_DIR/deploy/tessera-backup.timer"   /etc/systemd/system/tessera-backup.timer   0644
install_unit "$REPO_DIR/deploy/tessera-backup.sh"      /usr/local/bin/tessera-backup              0755

# The sudoers fragment hardcodes systemctl's path, and sudo matches that path as a
# string — /bin/systemctl is a DIFFERENT string from /usr/bin/systemctl even though one
# symlinks the other. The repo ships /usr/bin, but this box may differ, so the installed
# copy is rewritten to whatever `command -v systemctl` actually prints.
SYSTEMCTL="$(command -v systemctl)"
if $CHECK_ONLY; then
  fix "would install sudoers fragment allowing $SYSTEMCTL restart tessera"
else
  sed "s|/usr/bin/systemctl|$SYSTEMCTL|" "$REPO_DIR/deploy/tessera-deploy.sudoers" \
    > /etc/sudoers.d/tessera-deploy
  chmod 0440 /etc/sudoers.d/tessera-deploy
  chown root:root /etc/sudoers.d/tessera-deploy
  fix "installed sudoers fragment allowing $SYSTEMCTL restart tessera"
fi

if visudo -c -f /etc/sudoers.d/tessera-deploy >/dev/null 2>&1; then
  ok "sudoers fragment parses"
else
  bad "sudoers fragment does NOT parse — CI cannot restart the service"
  visudo -c -f /etc/sudoers.d/tessera-deploy || true
  FAILED=1
fi

if $CHECK_ONLY; then
  skip "systemctl daemon-reload / enable"
else
  systemctl daemon-reload
  systemctl enable tessera.service >/dev/null 2>&1 || true
  systemctl enable tessera-backup.timer >/dev/null 2>&1 || true
  fix "daemon-reload, enabled tessera.service and tessera-backup.timer"
fi

section "6. Caddy"

# The Ubuntu caddy package ships a default Caddyfile that is a STATIC FILE SERVER
# (`root * /usr/share/caddy` + `file_server`), not a reverse proxy. Leaving it in place is
# a silent failure: `/` answers 200 from the placeholder index.html, `/api/health` 404s,
# and nothing ever reaches the app. It reads as "the app is broken" when in fact the web
# server never forwards to it — which is exactly how it was first deployed. Hence a
# check, not just an install.
if [ -f /etc/caddy/Caddyfile ] && grep -q 'reverse_proxy' /etc/caddy/Caddyfile; then
  if cmp -s "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile; then
    ok "Caddyfile is the Tessera one and current"
  else
    apply "install Caddyfile (differs from the repo copy)" \
      install -m 0644 "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
  fi
else
  apply "install Caddyfile (replacing the package's static file server)" \
    install -m 0644 "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
fi

if grep -q 'flush_interval -1' /etc/caddy/Caddyfile; then
  ok "SSE flush_interval -1 present"
else
  bad "Caddyfile has no 'flush_interval -1' — replies will arrive in one burst"
  FAILED=1
fi

if $CHECK_ONLY; then
  skip "caddy validate / reload"
elif caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy >/dev/null 2>&1 || true
  fix "validated and reloaded caddy"
else
  bad "Caddyfile does not validate"
  caddy validate --config /etc/caddy/Caddyfile || true
  FAILED=1
fi

section "7. SSH access for CI"

if sudo -u "$DEPLOY_USER" test -s ~"$DEPLOY_USER"/.ssh/authorized_keys 2>/dev/null; then
  ok "$DEPLOY_USER has an authorized_keys file"
else
  bad "$DEPLOY_USER has NO authorized_keys — CI cannot log in"
  echo "        add the CI public key: see docs/vps-deploy.md §4"
  FAILED=1
fi

section "8. Database"

if [ -f "$DATA_DIR/tessera.sqlite" ]; then
  ok "database present ($(du -h "$DATA_DIR/tessera.sqlite" | cut -f1))"
  # Single quotes, not double: SQLite reads a double-quoted token as an IDENTIFIER, so
  # `|| " chats, "` is a "no such column" error rather than a string. That error must also
  # NOT be hidden, or a broken query reads as "the schema is missing".
  if counts="$(sqlite3 "$DATA_DIR/tessera.sqlite" \
        "SELECT (SELECT count(*) FROM chats) || ' chats, ' || (SELECT count(*) FROM messages) || ' messages'")"; then
    ok "$counts"
  else
    bad "could not read the database — is it a valid SQLite file?"
    FAILED=1
  fi
  for col in learned_at_seq superseded_at_seq; do
    if sqlite3 "$DATA_DIR/tessera.sqlite" \
         "SELECT group_concat(name) FROM pragma_table_info('facts')" | grep -q "$col"; then
      ok "facts.$col present"
    else
      bad "facts.$col MISSING — migration 0014/0015 did not run"
      FAILED=1
    fi
  done
  if sqlite3 "$DATA_DIR/tessera.sqlite" "SELECT count(*) FROM messages_fts" >/dev/null 2>&1; then
    ok "FTS5 search index present"
  else
    bad "messages_fts MISSING — full-text search will fail"
    FAILED=1
  fi
else
  bad "no database at $DATA_DIR/tessera.sqlite — run docs/vps-deploy.md §6"
  FAILED=1
fi

section "Summary"

if [ "$FAILED" -eq 0 ]; then
  printf '  \033[32mAll checks passed.\033[0m\n\n'
  echo "  Start the service:"
  echo "    sudo systemctl restart tessera"
  echo "    systemctl status tessera --no-pager"
  echo "    curl -s localhost:8787/api/health"
  echo
  echo "  Then install the Caddyfile and reload Caddy (docs/vps-deploy.md §7)."
else
  printf '  \033[31mSome checks failed — fix the FAIL lines above.\033[0m\n'
  exit 1
fi
