import { Database } from 'bun:sqlite';
import type { Db, DbResult, DbStatement } from './driver';

/**
 * The `Db` seam over a local SQLite file.
 *
 * This replaces Cloudflare D1 with `bun:sqlite`. The SQL is untouched — the same
 * `WITH RECURSIVE` walks, the same FTS5 tables, the same `ON CONFLICT` and `RETURNING` —
 * because both are SQLite. What changes is where the file lives: a page in a local WAL
 * instead of a row read billed by a remote service.
 *
 * The shape mirrors D1 exactly, including the parts that look like quirks:
 *
 * - `bind` returns the same statement with new parameters, so an inline
 *   `prepare(sql).bind(...).all()` reads the same as it always did.
 * - `.all()` on a write statement resolves to `{ results: [], meta: { changes } }`.
 *   D1 returns the same empty array, so a call site that runs a write through `.all()`
 *   behaves identically.
 * - `batch` is one transaction, so a statement that fails rolls back the ones before it.
 *
 * `bun:sqlite` is synchronous. The seam is async because D1 was and because every call
 * site awaits it; the awaits resolve on the same tick, so nothing is gained or lost.
 */

/** One statement a caller ran, for the tests that assert on the queries, not just rows. */
export interface QueryRecord {
  sql: string;
  params: unknown[];
  /** Rows returned. Zero for a write. */
  rows: number;
}

export interface SqliteDbOptions {
  /** Called for every statement, in order. Used by the query-recording tests. */
  observe?: (record: QueryRecord) => void;
}

class SqliteStatement implements DbStatement {
  private readonly owner: SqliteDb;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(owner: SqliteDb, sql: string, params: unknown[] = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): DbStatement {
    return new SqliteStatement(this.owner, this.sql, values);
  }

  async all<R = unknown>(): Promise<DbResult<R>> {
    return this.owner.execute<R>(this.sql, this.params);
  }

  async first<R = unknown>(): Promise<R | null> {
    return this.owner.execute<R>(this.sql, this.params).results[0] ?? null;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const { meta } = this.owner.execute(this.sql, this.params);
    return { success: true, meta };
  }

  /** The synchronous form `batch` needs: a transaction callback cannot await. */
  executeSync<R = unknown>(): DbResult<R> {
    return this.owner.execute<R>(this.sql, this.params);
  }
}

export class SqliteDb implements Db {
  private readonly db: Database;
  private readonly observe: ((record: QueryRecord) => void) | undefined;

  /**
   * Takes a path, or a connection the caller already opened.
   *
   * The second form is what the tests use: they want the raw `bun:sqlite` handle for
   * seeding and assertions, and the seam over the very same connection so the code under
   * test reads the rows they wrote rather than a second copy of them.
   */
  constructor(source: string | Database, options: SqliteDbOptions = {}) {
    this.db = typeof source === 'string' ? new Database(source, { create: true }) : source;
    this.observe = options.observe;

    // WAL so a reader is never blocked by the writer. This app has exactly one writer —
    // its own process — and WAL is what keeps the 6-hourly `.backup` timer from stalling
    // behind a turn's writes.
    this.db.exec('PRAGMA journal_mode = WAL');
    // The migrations assume enforcement; `scene.test.ts` turns it on by hand for the same
    // reason. Without it, deleting a chat would leave its scene setup and cast rows.
    this.db.exec('PRAGMA foreign_keys = ON');
    // The backup timer opens the file from a second process. Without a timeout, a write
    // landing while `.backup` holds its read lock fails at once instead of waiting out the
    // few milliseconds the copy takes.
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  prepare<T = unknown>(sql: string): DbStatement<T> {
    return new SqliteStatement(this, sql) as DbStatement<T>;
  }

  /**
   * One transaction for the whole batch, matching D1: a statement that fails rolls back
   * every statement before it, so a half-applied save is not a state the caller can
   * observe. The results are collected inside the callback and returned in statement
   * order.
   */
  async batch<R = unknown>(statements: DbStatement[]): Promise<Array<DbResult<R>>> {
    const out: Array<DbResult<R>> = [];
    const run = this.db.transaction(() => {
      for (const statement of statements) {
        if (!(statement instanceof SqliteStatement)) {
          // A statement from another driver cannot join this transaction. Running it here
          // would put a write outside the atomicity the caller asked for, which is a
          // silent difference in behavior rather than a limitation worth tolerating.
          throw new Error('batch() received a statement that did not come from this database');
        }
        out.push(statement.executeSync<R>());
      }
    });
    run();
    return out;
  }

  /**
   * The one place a statement runs.
   *
   * `columnNames` is what tells a read from a write. A plain `INSERT`/`UPDATE`/`DELETE`
   * reports no columns, so `.all()` on one is an empty array — which is what D1 returns
   * too. `INSERT … RETURNING` reports its returned column and comes back as rows, so the
   * two `RETURNING` reads in `jobs.ts` keep working unchanged.
   */
  execute<R = unknown>(sql: string, params: unknown[]): DbResult<R> {
    const bindings = params as never[];
    const query = this.db.query(sql);

    if (query.columnNames.length === 0) {
      const result = this.db.run(sql, ...bindings);
      this.observe?.({ sql, params, rows: 0 });
      return { results: [], success: true, meta: { changes: result.changes } };
    }

    const rows = query.all(...bindings) as R[];
    this.observe?.({ sql, params, rows: rows.length });
    // A statement that returns rows is not a write, so it reports no changes — the same
    // thing D1 reports. `meta.changes` is only meaningful for a statement that modified
    // rows, and both readers of it run UPDATEs.
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  /** Closes the file. Used by the server's shutdown. */
  close(): void {
    this.db.close();
  }
}

/**
 * Opens the database at `DATABASE_PATH`.
 *
 * The default is relative so a local `bun run server` works with no configuration; the
 * systemd unit sets an absolute path under `/srv/tessera/data`.
 */
export function openDatabase(path = process.env.DATABASE_PATH ?? './data/tessera.sqlite'): SqliteDb {
  return new SqliteDb(path);
}
