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

```sh
curl -fsSL https://bun.sh/install | bash
sudo install -m 0755 ~/.bun/bin/bun /usr/local/bin/bun
```

```sh
sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl sqlite3
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

## 4. Create the service user and the environment file

```sh
sudo useradd --system --home-dir /srv/tessera --shell /usr/sbin/nologin tessera
sudo mkdir -p /srv/tessera/data
sudo chown -R tessera:tessera /srv/tessera/data
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

## 5. Install the units, timer and sudoers fragment

From the repo's `deploy/` directory:

```sh
sudo install -m 0644 deploy/tessera.service       /etc/systemd/system/tessera.service
sudo install -m 0644 deploy/tessera-backup.service /etc/systemd/system/tessera-backup.service
sudo install -m 0644 deploy/tessera-backup.timer   /etc/systemd/system/tessera-backup.timer
sudo install -m 0755 deploy/tessera-backup.sh      /usr/local/bin/tessera-backup
sudo install -m 0440 deploy/tessera-deploy.sudoers /etc/sudoers.d/tessera-deploy
sudo visudo -c -f /etc/sudoers.d/tessera-deploy
sudo systemctl daemon-reload
sudo systemctl enable --now tessera.service tessera-backup.timer
```

The sudoers fragment grants the GitHub Actions user `tessera-deploy` the right to
restart only the `tessera` unit after an rsync — nothing else. Create that user on the
VPS and add its public key to `~tessera-deploy/.ssh/authorized_keys`; the CI deploy job
uses the matching private key from the `VPS_SSH_KEY` secret.

## 6. Apply the migrations, then import the data

Pick **one** of the two paths. They are mutually exclusive: the migration loop creates
the schema, so the import must then be data-only; a copied `.sqlite` file already carries
its schema and must not be re-migrated.

### Path A — start from an empty database (recommended)

Migrations are plain SQL and apply in filename order. Apply **all** of them, including
`0016_state_backfill.sql`: the test harnesses deliberately omit 0016, but production has
it and the deployed state depends on it.

```sh
cd /srv/tessera
for f in $(ls migrations/*.sql | sort); do
  echo "applying $f"
  sqlite3 /srv/tessera/data/tessera.sqlite < "$f"
done
```

Then export from D1 **without the schema** (`--no-schema`) and pipe the rows in. Without
that flag the dump re-emits `CREATE TABLE` statements that now collide with the
migrations above. `wrangler` needs your Cloudflare credentials, so run the export on your
dev machine and copy the dump to the VPS:

```sh
# on the dev machine
wrangler d1 export tessera-db --remote --no-schema --output=d1-dump.sql
scp d1-dump.sql <ip>:/tmp/d1-dump.sql

# on the VPS
sqlite3 /srv/tessera/data/tessera.sqlite < /tmp/d1-dump.sql
```

### Path B — copy an existing SQLite file

Because the schema and dialect are unchanged, a known-good local file is a straight copy.
But **the copy may be behind on migrations**, and a backup taken before `0014` has no
`learned_at_seq` on `facts` — the app then fails at runtime with `no such column`, not at
startup. So after copying, apply whatever is missing.

The file carries a `d1_migrations` table naming what has already run, so the loop below
applies only the remainder. It is not re-runnable over an already-applied migration —
`0013` rebuilds the `presets` table and errors on a second pass — which is exactly why the
already-run set is read rather than a fixed list assumed.

```sh
cp backup-2026-10-02/local.sqlite /srv/tessera/data/tessera.sqlite

for f in $(ls migrations/*.sql | sort); do
  name=$(basename "$f")
  if sqlite3 /srv/tessera/data/tessera.sqlite \
       "SELECT 1 FROM d1_migrations WHERE name = '$name'" | grep -q 1; then
    echo "already applied: $name"
    continue
  fi
  echo "applying $name"
  sqlite3 /srv/tessera/data/tessera.sqlite < "$f"
done
```

Verify the copy is at the current schema — both lines must print a column name:

```sh
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT group_concat(name) FROM pragma_table_info('facts')" | tr ',' '\n' | grep learned_at_seq
sqlite3 /srv/tessera/data/tessera.sqlite \
  "SELECT group_concat(name) FROM pragma_table_info('chat_cast')" | tr ',' '\n' | grep joined_seq
```

Verify either path with:

```sh
sqlite3 /srv/tessera/data/tessera.sqlite "SELECT count(*), max(seq) FROM messages"
```

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
