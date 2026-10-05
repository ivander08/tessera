import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

import type { Db, DbResult, DbStatement } from '../db/driver';
import { SqliteDb, type QueryRecord } from '../db/sqlite';

/**
 * The in-memory database every worker test runs against.
 *
 * This was copied into fifteen test files, each with its own D1-shaped shim over
 * `bun:sqlite`. The shim was the production driver's reference implementation and is now
 * the production driver itself (`worker/src/db/sqlite.ts`), so the copy is what remains:
 * one helper, one schema, one `Env`.
 *
 * The migration list is the test schema. It deliberately omits `0016_state_backfill.sql`,
 * which backfills a column that no test seeds — production has it, and the deploy runbook
 * applies it.
 */

export const TEST_MIGRATIONS = [
  '0000_init.sql',
  '0001_memory.sql',
  '0002_state.sql',
  '0003_presets.sql',
  '0004_swipes_presets.sql',
  '0005_branching.sql',
  '0006_walk_index.sql',
  '0007_scene_setup.sql',
  '0008_cast.sql',
  '0009_message_speaker.sql',
  '0011_message_state.sql',
  '0012_message_deleted.sql',
  '0013_presets_authored.sql',
  '0014_provenance.sql',
  '0015_supersession_provenance.sql',
];

/**
 * The migrations as one script.
 *
 * Read from `migrations/` rather than inlined, so a schema change cannot pass the tests
 * while production runs the old shape. The path resolves from this module, so no caller
 * has to know how deep it sits.
 */
export function migrationScript(names: readonly string[] = TEST_MIGRATIONS): string {
  return names
    .map((name) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'))
    .join('\n');
}

export interface TestDb {
  /** The migrated connection, for seeding rows and asserting on them directly. */
  db: Database;
  /** The seam the code under test reads through. */
  seam: SqliteDb;
  env: Env;
}

export interface TestEnvOptions {
  /** Bindings beyond `DB` and `APP_NAME` — `TESSERA_TOKEN`, `ASSETS`. */
  extra?: Partial<Env>;
  /**
   * An existing connection to wrap instead of opening a fresh in-memory one.
   *
   * A test that layers extra answers over rows it seeded needs the seam to read the very
   * same database, or it would be answering from a second, empty copy.
   */
  db?: Database;
  /**
   * Called for every statement, in order.
   *
   * A few tests assert on the shape of the queries the prompt assembly makes rather than
   * only on its output; observing here keeps that possible without a second shim.
   */
  observe?: (record: QueryRecord) => void;
  /**
   * Answer a statement without touching the database.
   *
   * Several tests drive the code with a fake `settings` table and a fake encrypted provider
   * key, because building a real encrypted key row per test would be noise around what
   * they actually assert. Returning `undefined` falls through to the real database.
   */
  stub?: (sql: string, params: unknown[]) => StubAnswer | undefined;
}

/** What a `stub` answers with. `rows: []` is a real "no rows"; `null` is a `first` miss. */
export interface StubAnswer {
  rows?: unknown[];
  /** Answers `first()` directly, so a stub can return a row `all()` would not. */
  row?: unknown | null;
}

/**
 * A migrated in-memory database and an `Env` that reads through the production driver.
 */
export function makeTestEnv(options: TestEnvOptions = {}): TestDb {
  const db = options.db ?? new Database(':memory:');
  if (!options.db) db.exec(migrationScript());
  const seam = new SqliteDb(db, { observe: options.observe });
  const DB = options.stub ? new StubDb(seam, options.stub) : seam;
  return { db, seam, env: { DB, APP_NAME: 'Tessera', ...options.extra } as Env };
}

/**
 * The seam with a test's answers layered over it.
 *
 * A statement class rather than a patched object, so the delegated methods stay
 * type-checked and the fall-through path is the same driver production runs.
 */
class StubStatement implements DbStatement {
  private readonly owner: StubDb;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(owner: StubDb, sql: string, params: unknown[] = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): DbStatement {
    return new StubStatement(this.owner, this.sql, values);
  }

  async all<R = unknown>(): Promise<DbResult<R>> {
    const stubbed = this.owner.answer(this.sql, this.params);
    if (stubbed) {
      return { results: (stubbed.rows ?? []) as R[], success: true, meta: { changes: 0 } };
    }
    return this.owner.inner.prepare<R>(this.sql).bind(...this.params).all<R>();
  }

  async first<R = unknown>(): Promise<R | null> {
    const stubbed = this.owner.answer(this.sql, this.params);
    if (stubbed) return (stubbed.row ?? null) as R | null;
    return this.owner.inner.prepare<R>(this.sql).bind(...this.params).first<R>();
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const stubbed = this.owner.answer(this.sql, this.params);
    if (stubbed) return { success: true, meta: { changes: 0 } };
    return this.owner.inner.prepare(this.sql).bind(...this.params).run();
  }

  /**
   * The same statement against the real driver.
   *
   * `batch` runs inside one `bun:sqlite` transaction, and a transaction callback cannot
   * take a statement it did not prepare. Rebuilding each statement against the inner
   * driver is what lets a batch of stubbed statements still run atomically — and the
   * stub is for reads, so nothing here needs an answer from it.
   */
  unwrap(): DbStatement {
    return this.owner.inner.prepare(this.sql).bind(...this.params);
  }
}

class StubDb implements Db {
  readonly inner: SqliteDb;
  private readonly stub: (sql: string, params: unknown[]) => StubAnswer | undefined;

  constructor(inner: SqliteDb, stub: (sql: string, params: unknown[]) => StubAnswer | undefined) {
    this.inner = inner;
    this.stub = stub;
  }

  answer(sql: string, params: unknown[]): StubAnswer | undefined {
    return this.stub(sql, params);
  }

  prepare<T = unknown>(sql: string): DbStatement<T> {
    return new StubStatement(this, sql) as DbStatement<T>;
  }

  batch<R = unknown>(statements: DbStatement[]): Promise<Array<DbResult<R>>> {
    // Each statement is rebuilt against the real driver, because the transaction inside
    // `SqliteDb.batch` cannot run a statement it did not prepare. The stub answers reads,
    // and a batch is writes, so nothing here needs an answer from it.
    return this.inner.batch<R>(
      statements.map((statement) =>
        statement instanceof StubStatement ? statement.unwrap() : statement,
      ),
    );
  }
}

/**
 * A statement run outside the seam, for seeding and for asserting on what was written.
 *
 * `bun:sqlite` types its variadic bindings more narrowly than this helper needs, and the
 * cast is the same one the seam makes for the same reason.
 */
export function exec(raw: Database, sql: string, ...params: unknown[]): void {
  raw.run(sql, ...(params as never[]));
}

/** The first row of a query, or null. */
export function one<T>(raw: Database, sql: string, ...params: unknown[]): T | null {
  return (raw.query(sql).get(...(params as never[])) as T | null) ?? null;
}

/** Every row of a query. */
export function all<T>(raw: Database, sql: string, ...params: unknown[]): T[] {
  return raw.query(sql).all(...(params as never[])) as T[];
}
