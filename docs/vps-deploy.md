# Deploying Tessera on the Tencent Lighthouse VPS

The Cloudflare Worker + D1 deployment is being retired: D1's 5M-rows-read/day free tier
cannot carry the recursive visible-path walk. The replacement is one Bun process on a
Lighthouse instance, serving `dist/` and `/api/*` from `127.0.0.1:8787`, with Caddy in
front for TLS and the SSE flush. The database stays SQLite, as a local file.

This runbook is ordered and copy-pasteable. The only placeholders are `<ip>`,
`<domain>` and `<the existing token>`. Every command assumes a shell on the VPS as a
user with sudo; the privileged steps are marked.

## 1. Prerequisites

- Ubuntu 22.04 or 24.04, a public IPv4 address.
- Ports **80** and **443** opened in the **Tencent Lighthouse console firewall**, not
  only in `ufw`. The console firewall is a second layer in front of the instance and
  will silently drop traffic the OS would otherwise accept. Tencent also blocks port 25
  by default; this app sends no mail, so that is not a problem here.
- The instance is shared with another user, each with their own home. Nothing below
  writes outside `/srv/tessera`, `/srv/backups` and `/etc/tessera*`, so the two
  deployments cannot collide — provided this app binds `127.0.0.1:8787` and Caddy owns
  `:80`/`:443`. If the other user also runs a reverse proxy, exactly one of the two must
  own ports 80/443 and template the other's site to its own loopback port.
- **Unverified until you are on the box:** the exact OS/version, whether `bun`, `caddy`
  and `sqlite3` are already installed, free RAM/disk, and whether your login user has
  sudo. If the image is not Debian-family or the account is unprivileged, ask the
  instance owner (the other user) to perform the privileged steps.

## 2. Install bun, caddy and sqlite3

First confirm your account has sudo; every step from here needs it. If it does not, ask
the instance owner (the other user) to run the privileged commands.

```sh
sudo -n true && echo "sudo OK" || echo "NO SUDO — stop and ask the instance owner"
```

`unzip` is not optional: bun's installer hard-fails with `unzip is required to install
bun` and exits, so installing it first is the difference between one command and a
puzzling error.

```sh
sudo apt-get update
sudo apt-get install -y unzip curl sqlite3
curl -fsSL https://bun.sh/install | bash
sudo install -m 0755 ~/.bun/bin/bun /usr/local/bin/bun
bun --version
```

Caddy comes from its own apt repository, because the version in Ubuntu's archive is old
enough to differ on the `flush_interval` directive the SSE stream depends on.

```sh
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
sudo systemctl enable --now caddy
```

## 3. Place the repo and build the SPA

```sh
sudo mkdir -p /srv/tessera /srv/backups
sudo chown "$USER":"$USER" /srv/tessera
git clone https://github.com/ivander08/tessera.git /srv/tessera
cd /srv/tessera
bun install --frozen-lockfile
bun run build
```

`bun run build` typechecks and emits `dist/`. It is the only build: the app is web-only,
and the SPA is same-origin with the API, so there is no API base URL to bake in.

## 4. Create the service user and hand over the tree

The unit runs as `tessera`, which must be able to **read** the app (`server/`, `dist/`,
`migrations/`) and **write** only its data directory. The clone from §3 is owned by your
login user, so the tree is handed over here — do not skip this, or the service fails at
startup with a permission error on `server/index.ts`.

```sh
sudo useradd --system --home-dir /srv/tessera --shell /usr/sbin/nologin tessera
sudo mkdir -p /srv/tessera/data
sudo chown -R tessera:tessera /srv/tessera
```

CI deploys by rsyncing into `/srv/tessera` as `tessera-deploy`, so that account needs
group write on the tree — and it needs a shell, unlike the service user.

```sh
sudo useradd --create-home --shell /bin/bash tessera-deploy
sudo usermod -aG tessera tessera-deploy
sudo chmod -R g+w /srv/tessera
sudo -u tessera-deploy mkdir -p ~tessera-deploy/.ssh
```

Add the CI public key (the pair to the `VPS_SSH_KEY` secret) so the deploy job can log in:

```sh
sudo -u tessera-deploy tee ~tessera-deploy/.ssh/authorized_keys >/dev/null <<'EOF'
ssh-ed25519 AAAA... your CI public key
EOF
sudo chmod 700 ~tessera-deploy/.ssh
sudo chmod 600 ~tessera-deploy/.ssh/authorized_keys
sudo chown -R tessera-deploy:tessera-deploy ~tessera-deploy/.ssh
```

`/etc/tessera.env` holds the bearer token, so it is mode 600 and owned by root; systemd
reads it as the unit's `EnvironmentFile` and the process inherits it.

```sh
sudo install -m 600 -o root -g root /dev/null /etc/tessera.env
sudo tee /etc/tessera.env >/dev/null <<'EOF'
TESSERA_TOKEN=<the existing token>
APP_NAME=Tessera
DATABASE_PATH=/srv/tessera/data/tessera.sqlite
PORT=8787
EOF
sudo chmod 600 /etc/tessera.env
```

Reuse the token already in the Cloudflare Worker secret so existing provider keys stay
decryptable; `TESSERA_TOKEN` is the key-encryption key, and changing it makes every
stored provider key undecryptable. If you need a fresh one: `openssl rand -hex 32`.

> **Order matters.** The clone in §3 happens as your login user, before the `tessera`
> user exists. If you run §4's `chown` before §3, the clone fails. If you forget the
> `chown` entirely, `systemctl start tessera` fails with
> `Permission denied` on `/srv/tessera/server/index.ts`.

## 5. Install the units, timer and sudoers fragment

From the repo's `deploy/` directory:

```sh
sudo install -m 0644 deploy/tessera.service        /etc/systemd/system/tessera.service
sudo install -m 0644 deploy/tessera-backup.service /etc/systemd/system/tessera-backup.service
sudo install -m 0644 deploy/tessera-backup.timer   /etc/systemd/system/tessera-backup.timer
sudo install -m 0755 deploy/tessera-backup.sh      /usr/local/bin/tessera-backup
sudo install -m 0440 deploy/tessera-deploy.sudoers /etc/sudoers.d/tessera-deploy
sudo visudo -c -f /etc/sudoers.d/tessera-deploy
sudo systemctl daemon-reload
sudo systemctl enable --now tessera.service tessera-backup.timer
```

**Check the `systemctl` path in the sudoers fragment before you rely on it.** The file
grants `/bin/systemctl restart tessera`; on Ubuntu `systemctl` is usually
`/usr/bin/systemctl`, and sudo matches the path literally, so a mismatch means the CI
restart silently fails with `command not allowed`. Confirm and fix if needed:

```sh
command -v systemctl
# if that prints /usr/bin/systemctl, edit the fragment:
sudo sed -i 's|/bin/systemctl|/usr/bin/systemctl|' /etc/sudoers.d/tessera-deploy
sudo visudo -c -f /etc/sudoers.d/tessera-deploy
```

## 6. Get your data onto the VPS

**Do not use `wrangler d1 export`.** It refuses any database containing FTS5 virtual
tables (`X [ERROR] D1 Export error: cannot export databases with Virtual Tables (fts5)`),
and Tessera has two — `messages_fts` and `facts_fts`. Before it fails it also **takes an
exclusive lock on the live database**, which your still-running Worker needs. There is no
flag that works around it.

The good news: you do not need D1 for this at all. `backup-2026-10-02/local.sqlite` is a
complete SQLite copy of the database, schema and rows, taken straight from D1. Copying a
file is the migration.

### 6a. Decide whether you can accept the copy's age

The file is from **2026-10-02**. Anything written in Tessera after that date exists only
in D1. Check what you would lose:

```sh
cd C:\Users\Ivander\Documents\Projects\tessera
sqlite3 backup-2026-10-02/local.sqlite \
  "SELECT max(seq) AS last_seq, datetime(max(created_at)/1000,'unixepoch') AS last_write FROM messages"
```

If that timestamp is the last time you used the app, nothing is lost and you are done
deciding. If you have written since, you have two choices:

- **Accept the gap.** Simplest, if it is a handful of messages you can retype.
- **Pull the missing rows through the D1 HTTP API**, which has no virtual-table
  limitation and does not lock the database. Read those with
  `wrangler d1 execute tessera-db --remote --json --command="SELECT ... FROM messages WHERE seq > <last_seq>"`
  and insert them into the copied file. Ask before doing this — the tables have to be
  reconciled together (`messages`, `chats`, `state`, `facts`, `summaries`), not one at a
  time, or foreign keys and the visible-path walk will disagree.

Everything below assumes the first choice.

### 6b. Copy the file to the VPS

```sh
# from the dev machine
scp backup-2026-10-02/local.sqlite ivander@<ip>:/tmp/tessera.sqlite
```

```sh
# on the VPS — the data directory is owned by the service user
sudo install -o tessera -g tessera -m 0644 /tmp/tessera.sqlite /srv/tessera/data/tessera.sqlite
```

### 6c. Apply the migrations the file is missing

The copied file carries a `d1_migrations` table listing what already ran, so this loop
applies only the remainder — expect `0014`, `0015` and `0016`.

It must read that table rather than run a fixed list, because **the migrations are not
re-runnable**: `0013` rebuilds the `presets` table and fails on a second pass. This is the
one step where doing it "twice to be safe" causes the damage.

```sh
cd /srv/tessera
for f in $(ls migrations/*.sql | sort); do
  name=$(basename "$f")
  if sqlite3 /srv/tessera/data/tessera.sqlite \
       "SELECT 1 FROM d1_migrations WHERE name = '$name'" | grep -q 1; then
    echo "already applied, skipping: $name"
    continue
  fi
  echo "applying $name"
  sqlite3 /srv/tessera/data/tessera.sqlite < "$f" || { echo "FAILED on $name"; break; }
done
```

Each line must print either `already applied, skipping` or `applying`. A `FAILED` line
means stop and read the error — do not re-run the loop.

### 6d. Verify the schema is current

Both commands must print a column name. If either prints nothing, the corresponding
migration did not run, and the app will fail later with `no such column` rather than
refusing to start.

```sh
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT group_concat(name) FROM pragma_table_info('facts')" | tr ',' '\n' | grep learned_at_seq
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT group_concat(name) FROM pragma_table_info('chat_cast')" | tr ',' '\n' | grep joined_seq
```

### 6e. Rebuild the search index

`0016` rewrites rows, and a `wrangler`-produced file may carry an empty FTS index. Check,
then rebuild if the first number is 0 while the second is not. `messages_fts` is an
external-content table, so `rebuild` regenerates the index from `messages` — it does not
touch or duplicate your data.

```sh
sqlite3 /srv/tessera/data/tessera.sqlite "SELECT count(*) FROM messages_fts; SELECT count(*) FROM messages;"

# only if messages_fts is empty and messages is not
sqlite3 /srv/tessera/data/tessera.sqlite "INSERT INTO messages_fts(messages_fts) VALUES('rebuild');"
sqlite3 /srv/tessera/data/tessera.sqlite "INSERT INTO facts_fts(facts_fts) VALUES('rebuild');"
```

### 6f. Record the source counts, for the parity check in §11

```sh
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT (SELECT count(*) FROM chats) AS chats, (SELECT count(*) FROM messages) AS messages, (SELECT max(seq) FROM messages) AS last_seq"
```

Write that line down. §11 compares the running app against it — matching counts are what
prove the copy was complete, and they are meaningless if taken after the app has already
written to the file.

## 7. Bring up over the IP and verify

```sh
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl restart tessera
```

```sh
systemctl status tessera --no-pager
curl -s localhost:8787/api/health
```

`/api/health` must return `{"ok":true,"app":"Tessera"}`. Then check the SPA and the SPA
fallback through Caddy:

```sh
curl -sI http://localhost/ | head -1
curl -sI http://localhost/some/spa/route | head -1
```

Both must be `200`; the second confirms unknown paths fall back to `index.html`. From
another machine, `curl -s http://<ip>/api/health` must also answer — if it does not, the
Lighthouse console firewall is still closed.

> **The IP-first phase is cleartext HTTP.** With no hostname, Caddy serves `http://<ip>/`
> unencrypted, so the bearer token crosses the network in the clear on every request.
> Keep this phase short, keep it off public networks, and attach the domain before any
> normal use.

## 8. Durability

This is the one thing SQLite-on-a-VPS makes your responsibility; D1's managed backups go
away with D1.

- The `tessera-backup.timer` runs `tessera-backup` every six hours (00:17, 06:17, 12:17,
  18:17) and keeps the newest 28 files in `/srv/backups` — a week of history. The script
  uses SQLite's `.backup`, not `cp`, because WAL mode keeps recent commits in a sidecar
  file a copy would miss.
- Add a weekly **off-box** copy — the instance has a single volume, so a backup that
  never leaves it does not survive the instance. Copy `/srv/backups/` weekly to a
  destination you control (another host over `rsync`/`scp`, or object storage), and keep
  the last N there too. Schedule it the same way as the six-hourly timer: a second
  `*.timer` unit, or a `cron` entry.

## 9. Cutover to the domain

Point the domain's A record at the VPS IP, then edit `/etc/caddy/Caddyfile`: replace the
`:80` site address with the hostname and add the global `email` block, as shown in the
commented post-cutover form in `deploy/Caddyfile`. `sudo systemctl reload caddy`.

Caddy obtains and renews a Let's Encrypt certificate automatically. **Nothing in the app
changes and nothing needs rebuilding:** the SPA calls `/api/*` same-origin, so there is
no API base URL and no CORS entry tied to the origin. Only the scheme in the browser
address bar changes.

## 10. Rollback

D1 is untouched until the VPS is proven, so rollback is a DNS/traffic decision, not a
data migration.

1. If the domain was switched, point the A record back at the Cloudflare Worker.
2. Stop the VPS app so it cannot write to a database you are about to abandon:
   `sudo systemctl stop tessera`.
3. Confirm the Worker still answers:
   `curl -s https://tessera.ivanderseah08.workers.dev/api/health`.
4. Investigate on the VPS with the data frozen. Nothing on the VPS was deleted by this
   deployment, so the local SQLite file and `/srv/backups` remain for diagnosis.

Do not delete the D1 database until the VPS has run cleanly through at least one backup
cycle and a restore drill.

## 11. Verification checklist

- [ ] `bun run build` produced `dist/` on the VPS.
- [ ] `systemctl status tessera` is `active (running)`.
- [ ] `curl -s localhost:8787/api/health` → `{"ok":true,"app":"Tessera"}`.
- [ ] `GET /` and `GET /some/spa/route` both return the SPA.
- [ ] `SELECT count(*), max(seq) FROM messages` matches the D1 source.
- [ ] `GET /api/chats` and `GET /api/chats/:id/messages` match the D1 deployment on the
      same data, ids in the same order.
- [ ] Search returns the same hit ids with `«…»` markers; a punctuation-only query
      returns `{hits: []}`, not a 500.
- [ ] A request without a bearer token gets `401`; with the token, `200`.
- [ ] A turn streams SSE frames progressively, not in one burst at the end.
- [ ] `systemctl list-timers tessera-backup.timer` shows the next run.
- [ ] The weekly off-box copy exists and a restore drill from it succeeds.
