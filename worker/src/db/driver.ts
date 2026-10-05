/**
 * The database seam.
 *
 * Every query in this app goes through `env.DB.prepare(sql).bind(...)` plus
 * `.all()`/`.first()`/`.run()`, and `env.DB.batch([...])` for grouped writes. That shape
 * came from D1, which is a thin HTTP wrapper over SQLite, and it is also the shape
 * `bun:sqlite` and `better-sqlite3` expose. Declaring it here is what lets the driver be
 * swapped — Cloudflare D1 to a local file — without touching a single SQL string.
 *
 * The interface is deliberately the smallest thing the existing call sites already use:
 * no `.raw()`, no `.exec()`, no cursor, no `RETURNING`-specific helper. Anything added
 * here would be a new capability the call sites do not have, which is how a seam turns
 * into a rewrite.
 */

export interface DbResult<T> {
  results: T[];
  success: true;
  /**
   * `changes` is the number of rows a write touched. Two call sites read it:
   * `cast.ts` to tell "the UPDATE matched nothing" from "it matched", and `jobs.ts` to
   * report how many stale leases a sweep recovered. A statement that writes nothing —
   * every read — reports 0.
   */
  meta: { changes: number };
}

/**
 * A prepared statement. `bind` returns the same statement with new parameters rather
 * than a copy, which is what D1 does and what every call site assumes: they build the
 * statement inline and chain `.bind(...).all()` in one expression.
 */
export interface DbStatement<T = unknown> {
  bind(...values: unknown[]): DbStatement<T>;
  all<R = T>(): Promise<DbResult<R>>;
  first<R = T>(): Promise<R | null>;
  run(): Promise<{ success: true; meta: { changes: number } }>;
}

export interface Db {
  prepare<T = unknown>(sql: string): DbStatement<T>;
  /**
   * Runs every statement in one transaction, returning one result per statement in
   * order. D1's batch is all-or-nothing over one round trip; a driver that ran the
   * statements one by one would let a mid-batch failure leave the writes before it
   * committed, which is the half-saved form the batch exists to prevent.
   */
  batch<R = unknown>(statements: DbStatement[]): Promise<Array<DbResult<R>>>;
}
