import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import {
  loadAlternatives,
  loadPath,
  loadPathTail,
  pathSeqsAfter,
  tailId,
  walkPath,
  type BranchRow,
} from './branch';

/**
 * The transcript walk.
 *
 * This is the rule that makes regenerating an old message behave the way a reader
 * expects, so it is tested directly rather than through a chat: given a set of rows, the
 * walk must return exactly the scene on screen.
 *
 * The scenario throughout is the one the reader described:
 *
 *     assistant A1   user U1   assistant A2   user U2
 *
 * Regenerating A1 must hide U1, A2 and U2 — they were written after a version of A1 that
 * is no longer showing. Swiping back to A1 must bring all three back, unchanged, because
 * nothing was ever deleted.
 */

let seq = 0;

/** A row with sensible defaults; `parent` names the row it answers. */
function row(
  id: string,
  parent: string | null,
  role: BranchRow['role'],
  active = 1,
): BranchRow {
  return {
    seq: ++seq,
    id,
    parent_id: parent,
    role,
    content: `${role}:${id}`,
    content_tokens: 1,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    cost_usd: null,
    active,
    swipe_group: null,
    speaker: null,
    state_json: null,
    created_at: 0,
  };
}

const ids = (rows: BranchRow[]) => rows.map((r) => r.id);

describe('walkPath', () => {
  test('an empty chat has an empty transcript', () => {
    expect(walkPath([])).toEqual([]);
  });

  test('follows a linear chain in order', () => {
    const rows = [row('a1', null, 'assistant'), row('u1', 'a1', 'user'), row('a2', 'u1', 'assistant')];
    expect(ids(walkPath(rows))).toEqual(['a1', 'u1', 'a2']);
  });

  test('regenerating the first reply hides everything that followed it', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
      // The regenerate: another version of the opening, now the active one.
      row('a1b', null, 'assistant'),
    ];
    expect(ids(walkPath(rows))).toEqual(['a1b']);
  });

  test('swiping back restores the whole continuation, unchanged', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
      row('a1b', null, 'assistant'),
    ];
    // The regenerate above left a1b active. Swiping back flips which version is active —
    // the rows themselves are never rewritten.
    const afterSwipe = rows.map((r) =>
      r.id === 'a1' ? { ...r, active: 1 } : r.id === 'a1b' ? { ...r, active: 0 } : r,
    );
    expect(ids(walkPath(afterSwipe))).toEqual(['a1', 'u1', 'a2', 'u2']);
  });

  test('two versions of a middle turn each keep their own continuation', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
      // Regenerated u1's reply: same parent, so it replaces a2 in the path.
      row('a2b', 'u1', 'assistant'),
      // A new turn written on top of the new version.
      row('u2b', 'a2b', 'user'),
    ];
    expect(ids(walkPath(rows))).toEqual(['a1', 'u1', 'a2b', 'u2b']);
  });

  test('a deleted position takes its continuation out of the transcript', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
    ];
    // Delete the user turn: the row is deactivated, not removed.
    const afterDelete = rows.map((r) => (r.id === 'u1' ? { ...r, active: 0 } : r));
    expect(ids(walkPath(afterDelete))).toEqual(['a1']);
  });

  test('stops at a position with no active version', () => {
    const rows = [row('a1', null, 'assistant'), row('u1', 'a1', 'user', 0)];
    expect(ids(walkPath(rows))).toEqual(['a1']);
  });

  test('ignores an inactive version even when it is newer', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('a1b', null, 'assistant', 0),
    ];
    expect(ids(walkPath(rows))).toEqual(['a1']);
  });

  test('takes the newest active version when the data is ambiguous', () => {
    // The invariant is one active child; a bad write could break it. The walk must still
    // return a single transcript rather than both versions spliced together.
    const rows = [row('a1', null, 'assistant'), row('a1b', null, 'assistant')];
    expect(ids(walkPath(rows))).toEqual(['a1b']);
  });

  test('terminates on a cycle instead of spinning', () => {
    const rows = [row('a', 'b', 'assistant'), row('b', 'a', 'assistant')];
    // Neither is reachable from the root, so the transcript is empty — the point is that
    // this returns at all.
    expect(walkPath(rows)).toEqual([]);
  });
});

/**
 * The walk as SQL, against a real database.
 *
 * The tests above exercise `walkPath`, the pure version. That is the rule, and it is worth
 * testing — but it is not what runs in production. `loadPath` walks the tree with a
 * recursive CTE, and a CTE can be wrong in ways a pure function cannot: a wrong join
 * returns another chat's rows, a wrong ORDER BY returns them shuffled, and a `LIMIT`
 * inside the recursion truncates the transcript.
 *
 * These tests run the real migrations against an in-memory SQLite and drive the real
 * queries through a D1-shaped shim, so the SQL itself is what is under test.
 */
describe('the walk as SQL', () => {
  // Every migration, so the schema under test is the schema that ships. A partial set
  // silently changes what the queries can do — 0004 alone cannot run without 0003.
  const MIGRATIONS = [
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
  ];

  function makeDb() {
    const db = new Database(':memory:');
    for (const name of MIGRATIONS) {
      db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    }
    const env = {
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) {
              params = values;
              return statement;
            },
            async all() {
              return { results: db.query(sql).all(...(params as never[])), success: true, meta: {} };
            },
            async first() {
              return db.query(sql).get(...(params as never[])) ?? null;
            },
            async run() {
              const result = db.run(sql, ...(params as never[]));
              return { success: true, meta: { changes: result.changes } };
            },
          };
          return statement;
        },
        // D1's batch runs statements in one round trip. The shim has no round trip to
        // save, so it runs them in order and returns one result per statement — which is
        // what the caller reads.
        async batch(statements: Array<{ all(): Promise<unknown> }>) {
          const out = [];
          for (const statement of statements) out.push(await statement.all());
          return out;
        },
      },
    } as unknown as Env;
    return { db, env };
  }

  /**
   * `bun-types` declares `run` as `(...bindings: ParamsType[])` where `ParamsType extends
   * SQLQueryBindings[]`, so a plain variadic call is rejected even though it works at
   * runtime. One seam here keeps the cast out of every call site.
   */
  function run(db: Database, sql: string, ...params: unknown[]): void {
    db.run(sql, ...(params as never[]));
  }

  function seedChat(db: Database, id = 'c1'): string {
    const now = Date.now();
    run(
      db,
      `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                          session_id, created_at, updated_at)
       VALUES (?, NULL, NULL, 't', NULL, 0, ?, ?, ?)`,
      id, `s-${id}`, now, now,
    );
    return id;
  }

  function seed(
    db: Database,
    chatId: string,
    id: string,
    parent: string | null,
    active = 1,
  ): void {
    run(
      db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, active, created_at)
       VALUES (?, ?, ?, 'assistant', ?, ?, ?)`,
      id, chatId, parent, `text-${id}`, active, Date.now(),
    );
  }

  test('returns the visible chain in transcript order, not seq order', async () => {
    const { db, env } = makeDb();
    const chatId = seedChat(db);
    // A1, U1, A2 in order, then A1 is regenerated as A1b — which carries a LATER seq but
    // sits FIRST in the conversation. Ordering by seq would put the opening at the end.
    seed(db, chatId, 'a1', null, 0);
    seed(db, chatId, 'u1', 'a1');
    seed(db, chatId, 'a2', 'u1');
    seed(db, chatId, 'a1b', null, 1);

    const path = await loadPath(env, chatId);
    expect(path.map((r) => r.id)).toEqual(['a1b']);
    expect(path[0].content).toBe('text-a1b');
  });

  test('does not leak another chat into the walk', async () => {
    const { db, env } = makeDb();
    const mine = seedChat(db, 'mine');
    const theirs = seedChat(db, 'theirs');
    seed(db, mine, 'a1', null);
    seed(db, mine, 'u1', 'a1');
    seed(db, theirs, 'z1', null);
    seed(db, theirs, 'z2', 'z1');

    expect((await loadPath(env, mine)).map((r) => r.id)).toEqual(['a1', 'u1']);
    expect((await loadPath(env, theirs)).map((r) => r.id)).toEqual(['z1', 'z2']);
  });

  test('walking a whole chain returns every row', async () => {
    // The recursion must not stop early or drop the tail.
    const { db, env } = makeDb();
    const chatId = seedChat(db);
    seed(db, chatId, 'm0', null);
    for (let index = 1; index < 50; index += 1) {
      seed(db, chatId, `m${index}`, `m${index - 1}`);
    }
    const path = await loadPath(env, chatId);
    expect(path).toHaveLength(50);
    expect(path[0].id).toBe('m0');
    expect(path[49].id).toBe('m49');
  });

  test('loadAlternatives groups every version by the parent they answer', async () => {
    const { db, env } = makeDb();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 0);
    seed(db, chatId, 'a1b', null, 1);
    seed(db, chatId, 'u1', 'a1');

    const groups = await loadAlternatives(env, chatId, [null, 'a1']);
    expect((groups.get('') ?? []).map((r) => r.id)).toEqual(['a1', 'a1b']);
    expect((groups.get('a1') ?? []).map((r) => r.id)).toEqual(['u1']);
    // A parent nobody asked about is not returned, so the query stays bounded by the
    // path rather than by the chat.
    expect(groups.get('nobody')).toBeUndefined();
  });

  test('tailId is the end of the visible path, not the newest row', async () => {
    const { db, env } = makeDb();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 0);
    seed(db, chatId, 'u1', 'a1');
    seed(db, chatId, 'a2', 'u1');
    // A newer row on an abandoned branch. `ORDER BY seq DESC` would pick this one.
    seed(db, chatId, 'orphan', 'a1', 0);

    expect(await tailId(env, chatId)).toBe('a2');
  });

  test('tailId is null for an empty chat', async () => {
    const { db, env } = makeDb();
    const chatId = seedChat(db);
    expect(await tailId(env, chatId)).toBeNull();
  });

  test('pathSeqsAfter returns visible seqs after a point, in order', async () => {
    const { db, env } = makeDb();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null);
    seed(db, chatId, 'u1', 'a1');
    seed(db, chatId, 'a2', 'u1');

    const seqs = await pathSeqsAfter(env, chatId, 0, 10);
    expect(seqs).toHaveLength(3);
    expect(seqs[0]).toBeLessThan(seqs[1]);
    expect(seqs[1]).toBeLessThan(seqs[2]);

    // Bounded: the limit is honoured, so the caller never reads more than it needs.
    expect(await pathSeqsAfter(env, chatId, 0, 2)).toHaveLength(2);
    // And a later `after` skips what it has already covered.
    expect(await pathSeqsAfter(env, chatId, seqs[0], 10)).toEqual([seqs[1], seqs[2]]);
  });

  describe('loadAlternatives: the opening and other chats', () => {
    test('an opening with no alternatives is not a position with hidden versions', async () => {
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      seed(db, chatId, 'a1', null);
      const groups = await loadAlternatives(env, chatId, [null]);
      expect((groups.get('') ?? []).map((r) => r.id)).toEqual(['a1']);
    });

    test('asking only about a mid-conversation parent does not pull in the opening', async () => {
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      seed(db, chatId, 'a1', null);
      seed(db, chatId, 'u1', 'a1');
      const groups = await loadAlternatives(env, chatId, ['a1']);
      expect(groups.has('')).toBe(false);
      expect((groups.get('a1') ?? []).map((r) => r.id)).toEqual(['u1']);
    });

    test("the root case does not leak another chat's opening", async () => {
      // The `OR parent_id IS NULL` branch is easy to get wrong: `chat_id = ? AND a OR b`
      // parses as `(chat_id = ? AND a) OR b`, which drops the chat filter for `b` and
      // returns every chat's opening.
      const { db, env } = makeDb();
      const mine = seedChat(db, 'mine');
      const theirs = seedChat(db, 'theirs');
      seed(db, mine, 'a1', null);
      seed(db, theirs, 'z1', null);

      const groups = await loadAlternatives(env, mine, [null]);
      expect((groups.get('') ?? []).map((r) => r.id)).toEqual(['a1']);
      expect((groups.get('') ?? []).map((r) => r.id)).not.toContain('z1');
    });

    test('no parents asked about means no query at all', async () => {
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      seed(db, chatId, 'a1', null);
      expect((await loadAlternatives(env, chatId, [])).size).toBe(0);
    });
  });

  describe('the D1 parameter cap', () => {
    test('a long chat does not exceed 100 bound parameters', async () => {
      // Found on the real 601-message chat: the first version bound one parameter per path
      // position, and D1 rejects a statement with more than 100. The chat that exposed it
      // is exactly the chat this query exists to keep cheap, so the failure mode was
      // "longest conversation stops loading entirely".
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      const ids: string[] = [];
      let parent: string | null = null;
      for (let index = 0; index < 300; index += 1) {
        const id = `m${index}`;
        seed(db, chatId, id, parent);
        if (parent !== null) ids.push(parent);
        parent = id;
      }

      // Every position on a 300-message path, which is 3x the parameter cap.
      const groups = await loadAlternatives(env, chatId, [null, ...ids]);
      expect(groups.size).toBeGreaterThan(100);
      // And the answers must still be right, not merely returned: each id has one child.
      for (const id of ids.slice(0, 20)) {
        expect((groups.get(id) ?? []).length).toBe(1);
      }
      // The opening must appear exactly once. The root clause rides on the first chunk, and
      // repeating it per chunk would return the opening once per chunk — which the client
      // reads as duplicate swipe entries.
      expect((groups.get('') ?? []).length).toBe(1);
      // No position may appear twice, whatever the chunking did.
      const seen = new Set<string>();
      for (const [, rows] of groups) {
        for (const row of rows) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
        }
      }
    });

    test('a chat longer than the cap still returns the whole path', async () => {
      // The end-to-end shape: what the transcript endpoint does with a long chat.
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      let parent: string | null = null;
      for (let index = 0; index < 250; index += 1) {
        const id = `m${index}`;
        seed(db, chatId, id, parent);
        parent = id;
      }
      const path = await loadPath(env, chatId);
      expect(path).toHaveLength(250);
      const groups = await loadAlternatives(
        env,
        chatId,
        path.map((row) => row.parent_id),
      );
      // The opening is included, and every other position resolves to one child.
      expect((groups.get('') ?? []).length).toBe(1);
      expect(groups.size).toBe(250);
    });
  });

  /**
   * The bounded backward walk.
   *
   * The whole point of `loadPathTail` is that its cost does not grow with the
   * conversation, and the only way that stays true is if the bound is real. These tests
   * pin the bound and the paging contract, because a cursor that is off by one row is
   * invisible until a reader pages a long scene and sees a turn twice.
   */
  describe('loadPathTail', () => {
    /**
     * A linear chain of `count` rows. Returns the chat id.
     *
     * `prefix` disambiguates the row ids: `messages.id` is globally unique, not unique per
     * chat, so two chains in one database cannot both start at `m0`.
     */
    function chain(
      db: Database,
      count: number,
      chatId: string = seedChat(db),
      prefix = 'm',
    ): string {
      let parent: string | null = null;
      for (let index = 0; index < count; index += 1) {
        const id = `${prefix}${index}`;
        seed(db, chatId, id, parent);
        parent = id;
      }
      return chatId;
    }

    test('returns exactly `limit` rows, oldest-first, ending at the tail', async () => {
      const { db, env } = makeDb();
      const chatId = chain(db, 250);

      const tail = await loadPathTail(env, chatId, 60);
      expect(tail).toHaveLength(60);
      expect(tail[0].id).toBe('m190');
      expect(tail[59].id).toBe('m249');
      // Oldest-first, matching `loadPath`, so the caller never reverses.
      expect(tail.map((row) => row.id)).toEqual(
        Array.from({ length: 60 }, (_, index) => `m${190 + index}`),
      );
    });

    test('a window larger than the chat returns the whole chat', async () => {
      const { db, env } = makeDb();
      const chatId = chain(db, 12);
      const rows = await loadPathTail(env, chatId, 60);
      expect(rows).toHaveLength(12);
      expect(rows[0].id).toBe('m0');
      expect(rows[11].id).toBe('m11');
    });

    test('a cursor returns the previous page and excludes the cursor row', async () => {
      const { db, env } = makeDb();
      const chatId = chain(db, 250);

      const newest = await loadPathTail(env, chatId, 60);
      const older = await loadPathTail(env, chatId, 60, newest[0].id);
      expect(older).toHaveLength(60);
      expect(older[59].id).toBe('m189');
      expect(older[0].id).toBe('m130');
      // No overlap: the cursor row itself is not repeated.
      expect(older.map((row) => row.id)).not.toContain(newest[0].id);
    });

    test('paging collects the whole path in order with no duplicates', async () => {
      const { db, env } = makeDb();
      const chatId = chain(db, 11);

      const collected: BranchRow[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: BranchRow[] = await loadPathTail(env, chatId, 4, cursor);
        if (page.length === 0) break;
        collected.unshift(...page);
        cursor = page[0].id;
        if (page.length < 4) break;
      }

      const whole = await loadPathTail(env, chatId, 500);
      expect(collected.map((row) => row.id)).toEqual(whole.map((row) => row.id));
      expect(collected.map((row) => row.id)).toEqual(
        Array.from({ length: 11 }, (_, index) => `m${index}`),
      );
    });

    test('limit 0 returns nothing, not the tail row', async () => {
      // The SQL alone returns one row for `limit 0`: the seed always produces a row and
      // it is the recursive term that is bounded.
      const { db, env } = makeDb();
      const chatId = chain(db, 5);
      expect(await loadPathTail(env, chatId, 0)).toEqual([]);
      expect(await loadPathTail(env, chatId, -1)).toEqual([]);
    });

    test('an empty chat returns nothing', async () => {
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      expect(await loadPathTail(env, chatId, 60)).toEqual([]);
    });

    test('an unknown cursor returns nothing', async () => {
      const { db, env } = makeDb();
      const chatId = chain(db, 10);
      expect(await loadPathTail(env, chatId, 60, 'nope')).toEqual([]);
    });

    test("a cursor from another chat returns nothing", async () => {
      const { db, env } = makeDb();
      const mine = chain(db, 10, seedChat(db, 'mine'), 'a');
      chain(db, 10, seedChat(db, 'theirs'), 'z');
      // The cursor exists, but in a different chat — the `chat_id` guard is what rejects
      // it, so a leaked id cannot splice another scene's rows into this one.
      expect(await loadPathTail(env, mine, 60, 'z5')).toEqual([]);
      expect(await loadPathTail(env, mine, 60, 'a5')).toHaveLength(5);
    });

    test('follows the active version when a position has several', async () => {
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      seed(db, chatId, 'a1', null, 0);
      seed(db, chatId, 'u1', 'a1');
      seed(db, chatId, 'a2', 'u1');
      seed(db, chatId, 'u2', 'a2');
      // A regenerate at the opening: same parent, newer seq, now the active one. Its
      // continuation is off the path, and the walk must not reach it.
      seed(db, chatId, 'a1b', null, 1);
      seed(db, chatId, 'u1b', 'a1b');

      const rows = await loadPathTail(env, chatId, 60);
      expect(rows.map((row) => row.id)).toEqual(['a1b', 'u1b']);
      // Walking back past the opening's parent ends the walk rather than picking up the
      // abandoned continuation.
      expect(rows[0].parent_id).toBeNull();
    });

    test('paging across a mid-path regenerate stays on the visible path', async () => {
      const { db, env } = makeDb();
      const chatId = seedChat(db);
      seed(db, chatId, 'a1', null);
      seed(db, chatId, 'u1', 'a1');
      seed(db, chatId, 'a2', 'u1', 0);
      seed(db, chatId, 'a2b', 'u1', 1);
      seed(db, chatId, 'u2', 'a2b');

      const rows = await loadPathTail(env, chatId, 2);
      expect(rows.map((row) => row.id)).toEqual(['a2b', 'u2']);
      const older = await loadPathTail(env, chatId, 2, rows[0].id);
      expect(older.map((row) => row.id)).toEqual(['a1', 'u1']);
    });
  });
});
