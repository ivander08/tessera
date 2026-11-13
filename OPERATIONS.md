# Operations

How Tessera runs in production, how to reach it, and the rules that keep the live data safe.

Everything below assumes the machine that holds `~/.ssh/tessera_deploy`.

---

## 1. What is running where

| | |
|---|---|
| Host | `43.134.3.67` |
| SSH user | `tessera-deploy` (deploy + read), no sudo |
| App root | `/srv/tessera` |
| Service | `tessera.service` (systemd) |
| Listen | `127.0.0.1:8787`, fronted by a reverse proxy on `:80` |
| Database | `/srv/tessera/data/tessera.sqlite` (+ `-wal`, `-shm`) |
| Secrets | `/etc/tessera.env`, mode `600`, owned by root — **not readable as `tessera-deploy`** |
| Public API | `http://43.134.3.67/api` |
| Code on the host | the same tree as this repo, minus `data/`, `node_modules/`, `dist/` |

The service user `tessera` owns the tree and the database. `tessera-deploy` is in the
`tessera` group, which is why it can *read* the database and sync code, but cannot read the
environment file or restart the service without sudo.

---

## 2. SSH

```bash
ssh -i ~/.ssh/tessera_deploy -o BatchMode=yes -o ConnectTimeout=15 tessera-deploy@43.134.3.67
```

`BatchMode=yes` is deliberate: it fails immediately instead of waiting for a password prompt
that will never be answered.

**If it fails with `kex_exchange_identification: read: Connection reset`** — that is the host
dropping a connection mid-handshake, not a key problem. It is intermittent; retrying once is
the fix. A genuine key problem says `Permission denied (publickey)` instead.

Check the fingerprint of the key you are holding matches the one CI uses:

```bash
ssh-keygen -lf ~/.ssh/tessera_deploy
```

---

## 3. The service

```bash
systemctl is-active tessera          # active / inactive
systemctl status tessera --no-pager  # last lines + start time
systemctl show tessera -p ActiveEnterTimestamp
```

`journalctl` **does not work as `tessera-deploy`**: the account is not in `systemd-journal`
or `adm`, so every query answers `-- No entries --` — which reads as "the service logged
nothing" when it means "you cannot see the log". Reading logs needs root:

```bash
# as root
journalctl -u tessera -n 100 --no-pager
journalctl -u tessera -f
journalctl -u tessera --since "30 min ago" --no-pager | grep -i state   # state engine warnings
```

Without root the usable alternative is the app's own surface: `/api/health`, the state
panel, and the memory/compact panels, which report their own failures inline.

Restarting needs sudo, which `tessera-deploy` does not have. Deploys do it through CI;
anything else needs the root account.

The health probe the deploy uses:

```bash
curl -fsS http://127.0.0.1:8787/api/health     # run ON the host
curl -fsS http://43.134.3.67/api/health        # from anywhere
```

---

## 4. The database

SQLite in WAL mode. The running app holds it open, so **reading is always safe, writing from
a shell is not** (see §7).

```bash
sqlite3 /srv/tessera/data/tessera.sqlite
```

Useful one-liners, all read-only:

```bash
# Which chats exist, newest first
sqlite3 /srv/tessera/data/tessera.sqlite \
  'SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC LIMIT 10;'

# Per-chat memory volume
sqlite3 /srv/tessera/data/tessera.sqlite \
  'SELECT chat_id, status, count(*) FROM facts GROUP BY chat_id, status ORDER BY 3 DESC;'
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT chat_id, tier, count(*), sum(tokens) FROM summaries GROUP BY chat_id, tier ORDER BY 3 DESC;"

# The world state a chat's next turn will read
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT json FROM state WHERE chat_id='<chat-id>';"

# A chat's scene setup (craft toggles, memory mode, time pace)
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT json FROM chat_scene_setup WHERE chat_id='<chat-id>';"

# What a preset actually carries
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT name, knobs_json, config_json FROM presets WHERE id='<preset-id>';"

# Schema
sqlite3 /srv/tessera/data/tessera.sqlite '.tables'
sqlite3 /srv/tessera/data/tessera.sqlite '.schema facts'
```

The authoritative schema is `migrations/` in this repo — the live file should match it after
every deploy, because `deploy/migrate.sh` runs before the service restarts.

### Backups

Never copy the `.sqlite` file alone: in WAL mode the newest writes live in `-wal`. Use SQLite's
own snapshot:

```bash
ssh -i ~/.ssh/tessera_deploy tessera-deploy@43.134.3.67 \
  "sqlite3 /srv/tessera/data/tessera.sqlite \".backup /tmp/tessera-\$(date +%s).sqlite\""
scp -i ~/.ssh/tessera_deploy tessera-deploy@43.134.3.67:/tmp/tessera-*.sqlite ./backup.sqlite
```

Pull one to work on locally:

```bash
scp -i ~/.ssh/tessera_deploy tessera-deploy@43.134.3.67:/srv/tessera/data/tessera.sqlite ./prod.sqlite
```

---

## 5. The API

Everything the UI does goes through `http://43.134.3.67/api` with a bearer token:

```bash
curl -s http://43.134.3.67/api/settings \
  -H "Authorization: Bearer $TESSERA_TOKEN"
```

**The token is not in this repository** (it is public). Keep it in a password manager or a
shell variable, and never paste it into a file that can be committed:

```bash
export TESSERA_TOKEN='…'        # this shell only
```

A missing or wrong token answers `{"error":"unauthorized"}`. The local dev token in
`.dev.vars` is a *different* token and does not work against production.

Prefer the API over the database for anything that writes: it runs the validators
(`parsePresetConfig`, `readCard`, `parseSceneSetup`, `validatePatch`) and updates timestamps.
A direct `UPDATE` skips all of that.

---

## 6. Deploying

**Push to `main`.** That is the whole procedure.

CI (`.github/workflows/deploy.yml`) runs, in order:

1. `bun install --frozen-lockfile`
2. `bunx tsc -b` and `bunx tsc -p tsconfig.test.json --noEmit`
3. `bun test`
4. `bunx oxlint src worker server`
5. `bun run build` → `dist/`
6. `rsync` the tree to `/srv/tessera/` (excluding `.git`, `node_modules`, `data`, `.bun`)
7. `sh deploy/migrate.sh` → `bun install --production` → `systemctl restart tessera`
8. health probe on the host

Consequences worth knowing:

- **A failing test never reaches production.** Fix and push again.
- **Migrations run before the restart**, so a migration failure aborts while the old process
  is still serving — the recoverable order.
- **`data/` is excluded from the sync**, deliberately: it holds the only copy of the database.
- A second push during a deploy cancels the first (`concurrency`), so the newest commit wins.

Watch it:

```bash
gh run list --limit 3
gh run watch
```

Required repo secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.

---

## 7. Rules for touching live data

1. **Read with `sqlite3`, write with the API.** The app holds the database open; a shell
   `UPDATE` can be overwritten by the app's next write and skips every validator.
2. If a direct write is genuinely unavoidable: stop the service first (needs root), take a
   `.backup` snapshot, make the change, restart, and re-check the affected endpoint.
3. **Never** touch `/srv/tessera/data` from a deploy or an `rsync`.
4. Anything destructive in the UI is a tombstone (`deleted = 1`) or a supersession, not a
   `DELETE`. Keep that property when adding operations — memory is meant to be auditable.
5. The prod token is a credential. Do not put it in a commit, an issue, or a chat log.

---

## 8. Common symptoms

| Symptom | Look at |
|---|---|
| Turn fails, no reply | `journalctl -u tessera -n 50` — provider errors surface as a failed turn |
| Clock jumps / state wrong | the state panel's **Re-derive from last exchange**; then `SELECT json FROM state` |
| Chat is slow | provider latency; `last_prefix_hash` / cache meters in the chat's debug data |
| Preset changes ignored | `GET /api/chats/:id` → `preset_id`; a chat edits its own preset, not the global one |
| Settings page has no model fields | by design — generation lives in presets; set **Default preset** on Settings |
