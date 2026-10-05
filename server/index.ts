import { openDatabase } from '../worker/src/db/sqlite';
import worker from '../worker/src/index';
import { onWorkerWake, recoverStale } from '../worker/src/jobs';
import { runPendingMemoryJob } from '../worker/src/memory/schedule';
import { serveAssets } from './assets';
import { DeferredWork } from './deferred';

/**
 * The Tessera server.
 *
 * This replaces the Cloudflare Worker runtime. It is the same `fetch` handler — the
 * dispatch chain in `worker/src/index.ts` is imported, not reimplemented — with the two
 * things the Worker provided supplied by hand:
 *
 * - `ASSETS`, which was the Workers Static Assets binding and is now a reader over
 *   `dist/` with the SPA fallback (`server/assets.ts`).
 * - `ctx.waitUntil`, which was the isolate's execution context and is now a set of
 *   promises drained on shutdown (`server/deferred.ts`).
 *
 * Everything else is `Bun.serve`. The database is a local SQLite file, so there is no
 * binding to wire and no per-row billing behind a turn.
 */

const PORT = Number(process.env.PORT ?? 8787);
/** Loopback only: Caddy terminates TLS and is the only thing that should reach this. */
const HOST = process.env.HOST ?? '127.0.0.1';
/** How often the stale-lease sweep runs. See the note on the interval below. */
const SWEEP_INTERVAL_MS = 60_000;

const token = process.env.TESSERA_TOKEN;
if (!token) {
  // Without this the app boots and 401s every request, which reads as a client bug rather
  // than a missing secret. Fail loudly at startup instead.
  console.error('[server] TESSERA_TOKEN is not set — refusing to start. See docs/vps-deploy.md.');
  process.exit(1);
}

const db = openDatabase();
const deferred = new DeferredWork();

const env: Env = {
  DB: db,
  ASSETS: { fetch: serveAssets },
  APP_NAME: process.env.APP_NAME ?? 'Tessera',
  TESSERA_TOKEN: token,
};

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // Bun's default idle timeout is 10s, which a turn can exceed: the model is streaming
  // and the client is waiting on it. The stream itself keeps the socket busy, but the gap
  // before the first token can be longer than that on a cold provider, and a request cut
  // off there would look like a failed turn.
  idleTimeout: 120,
  fetch(req) {
    return worker.fetch(req, env, {
      waitUntil: (promise: Promise<unknown>) => {
        deferred.add(promise);
      },
      // The Worker called this to let a thrown error fall through to the asset handler.
      // Nothing here is behind the handler, so a request that reaches it has already been
      // answered or has failed — there is nowhere to fall through to.
      passThroughOnException: () => {},
    });
  },
});

console.log(`[server] listening on http://${HOST}:${PORT}`);

/**
 * One sweep at boot, then one a minute.
 *
 * `onWorkerWake` is memoized — it runs its `recoverStale` at most once per module load,
 * which was the right granularity for an isolate that is created on a cold start. A
 * long-lived process has exactly one cold start, so reusing the hook on a timer would
 * sweep once and then never again. The interval therefore calls `recoverStale` directly:
 * same sweep, and it can actually repeat.
 *
 * Both are fire-and-forget. A sweep that fails must not take the server down with it, and
 * the next one will simply try again.
 */
void onWorkerWake(env);
const sweep = setInterval(() => {
  void recoverStale(env).catch((error: unknown) => {
    console.warn(`[jobs] periodic stale-job sweep failed: ${String(error)}`);
  });
}, SWEEP_INTERVAL_MS);
// The timer must not be the reason the process stays alive.
sweep.unref?.();

/**
 * A queued memory job is drained per request, the same as the Worker did, rather than on
 * the sweep timer: the request is what proves the app is in use, and the drain is bounded
 * (`runPendingMemoryJob` runs at most a few jobs).
 */
const drainMemory = setInterval(() => {
  void runPendingMemoryJob(env).catch(() => {});
}, SWEEP_INTERVAL_MS);
drainMemory.unref?.();

let stopping = false;

/**
 * Graceful shutdown.
 *
 * `server.stop()` first, so no new request can add work; then the deferred promises are
 * awaited, because a turn's write or a memory job may still be in flight. Without this a
 * `systemctl restart` during a turn could drop the write that finishes it.
 */
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal} — draining`);
  clearInterval(sweep);
  clearInterval(drainMemory);
  await server.stop();
  await deferred.drain();
  db.close();
  console.log('[server] stopped');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
