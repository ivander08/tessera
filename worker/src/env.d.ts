/**
 * The bindings the app runs against.
 *
 * This was `interface Env extends __BaseEnv_Env {}` merged into wrangler's generated
 * `worker-configuration.d.ts`, which is where `DB: D1Database`, `ASSETS: Fetcher` and the
 * `APP_NAME` literal came from. The app is served by its own Bun process now, so the
 * bindings are declared here instead of generated: the same names, with `DB` typed as the
 * driver seam rather than as a Cloudflare binding, and `ASSETS` typed as the one method
 * the fetch handler calls on it.
 */
interface Env {
  /** The database. A local SQLite file on the server; D1 while the Worker still runs. */
  DB: import('./db/driver').Db;
  /**
   * The SPA's asset tree. In the Worker runtime this is the `assets` binding; the
   * self-hosted server passes a small object that reads from `dist/`.
   */
  ASSETS: { fetch(req: Request): Promise<Response> };
  APP_NAME: string;
  /** A Worker secret (`wrangler secret put`), or `TESSERA_TOKEN` in the server's env. */
  TESSERA_TOKEN: string;
}

/**
 * The slice of Cloudflare's `ExecutionContext` the app actually uses.
 *
 * It came from wrangler's generated types; declaring it here is what lets the Worker's
 * entry point and the self-hosted server's share one request signature. `waitUntil` is
 * the only member called — `passThroughOnException` is declared so a real
 * `ExecutionContext` still satisfies this, and so the tests' stubs do not need a cast
 * they do not otherwise deserve.
 */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
