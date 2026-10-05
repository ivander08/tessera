# `deploy/` — VPS deployment artifacts

Everything here is installed to a system path on the Lighthouse VPS. The runbook that
uses them, in order, is [`../docs/vps-deploy.md`](../docs/vps-deploy.md).

| File | Installed to | Purpose |
|---|---|---|
| `tessera.service` | `/etc/systemd/system/tessera.service` | Runs `bun run server/index.ts` as the `tessera` user, restarts on failure, binds loopback only. |
| `Caddyfile` | `/etc/caddy/Caddyfile` | Bring-up `:80` reverse proxy to `127.0.0.1:8787` with `flush_interval -1` for SSE; commented post-cutover domain form. |
| `tessera-backup.sh` | `/usr/local/bin/tessera-backup` | Six-hourly `.backup` of the SQLite file into `/srv/backups`, pruning to 28. |
| `tessera-backup.service` | `/etc/systemd/system/tessera-backup.service` | Oneshot wrapper the timer invokes. |
| `tessera-backup.timer` | `/etc/systemd/system/tessera-backup.timer` | Fires the backup every six hours; `Persistent=true`. |
| `tessera-deploy.sudoers` | `/etc/sudoers.d/tessera-deploy` (0440) | Lets the GitHub Actions user restart only the `tessera` unit. |

Install commands, the `/etc/tessera.env` contents, the migration and data import, and
the rollback procedure are all in the runbook.
