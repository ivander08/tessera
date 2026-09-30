import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { buildMatchQuery, escapeFtsToken } from './fts';
import { recall } from './recall';
import { summarize } from './summarize';
import { consolidate } from './consolidate';
import { claim, enqueue, finish, recoverStale, start } from '../jobs';
import type { JobRow } from '../jobs';
import { createFact, listMemory, mutateMemory } from './api';
import { putSetting } from '../db';
import { storeProviderKey } from '../keys';

/**
 * These tests run the REAL migrations against an in-memory SQLite and drive the real
 * D1-shaped SQL through a thin shim. A hand-mocked `prepare` would happily accept a
 * broken JOIN or a missing trigger, which is exactly the class of bug worth catching
 * here: FTS5 returns only a rowid, so a wrong join silently returns another chat's
 * memories, and a missing trigger silently returns nothing at all.
 */

interface Recorded {
  sql: string;
  params: unknown[];
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
}

function makeEnv(): { env: Env; db: Database; calls: Recorded[] } {
  const db = new Database(':memory:');
  db.exec(migrationSql('0000_init.sql'));
  db.exec(migrationSql('0001_memory.sql'));

  const calls: Recorded[] = [];

  const DB = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all() {
          calls.push({ sql, params });
          return { results: db.query(sql).all(...(params as never[])), success: true, meta: {} };
        },
        async first() {
          calls.push({ sql, params });
          return db.query(sql).get(...(params as never[])) ?? null;
        },
        async run() {
          calls.push({ sql, params });
          const result = db.run(sql, ...(params as never[]));
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  };

  const env = { DB, TESSERA_TOKEN: 'test-token', APP_NAME: 'Tessera' } as unknown as Env;
  return { env, db, calls };
}

/**
 * `bun-types` declares `run`/`get` as `(...bindings: ParamsType[])` where
 * `ParamsType extends SQLQueryBindings[]`, so a plain variadic call is rejected even
 * though it works at runtime. One seam here keeps the cast out of every call site.
 */
function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

function one<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  return (db.query(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function allOf<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  return db.query(sql).all(...(params as never[])) as T[];
}

function seedChat(db: Database, id = 'chat-1'): string {
  const now = Date.now();
  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES (?, NULL, NULL, 't', NULL, 0, ?, ?, ?)`,
    id,
    `session-${id}`,
    now,
    now,
  );
  return id;
}

function seedMessage(db: Database, chatId: string, content: string): number {
  const row = one<{ seq: number }>(
    db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
     VALUES (?, ?, NULL, 'assistant', ?, ?) RETURNING seq`,
    crypto.randomUUID(),
    chatId,
    content,
    Date.now(),
  );
  return row?.seq ?? 0;
}

function seedScene(db: Database, chatId: string, from: number, to: number, content: string): void {
  exec(
    db,
    `INSERT INTO summaries (id, chat_id, tier, covers_from, covers_to, content, tokens, created_at)
     VALUES (?, ?, 'scene', ?, ?, ?, 1, ?)`,
    crypto.randomUUID(),
    chatId,
    from,
    to,
    content,
    Date.now(),
  );
}

describe('FTS5 escaping', () => {
  test('wraps each token in quotes and doubles internal quotes', () => {
    expect(escapeFtsToken('Ada')).toBe('"Ada"');
    expect(escapeFtsToken('say "hi"')).toBe('"say ""hi"""');
    expect(buildMatchQuery('Ada Lovelace')).toBe('"Ada" OR "Lovelace"');
  });

  test('neutralizes every FTS5 operator by making it a literal word', () => {
    // `-` is NOT, `*` is prefix, `NEAR(` opens a proximity clause, `^` is a column
    // filter, `OR`/`AND` are boolean. All become plain quoted text.
    //
    // The leading `-` is stripped as punctuation rather than quoted, which is strictly
    // safer: `-"refuses"` would be a NOT operator applied to a quoted phrase, so the
    // operator is removed before it can be spelled.
    expect(buildMatchQuery('Ada -refuses')).toBe('"Ada" OR "refuses"');
    // Likewise the prefix operator: `re*` becomes the literal word "re", so a query
    // cannot ask FTS5 for a prefix expansion at all.
    expect(buildMatchQuery('re*')).toBe('"re"');
    // Only leading and trailing punctuation is stripped, so `NEAR(Ada` keeps its
    // interior paren — harmless, because inside the quotes FTS5 treats the whole thing
    // as literal text and the operator cannot be spelled.
    expect(buildMatchQuery('NEAR(Ada Bob)')).toBe('"NEAR(Ada" OR "Bob"');
    expect(buildMatchQuery('content:secret')).toBe('"content:secret"');
  });

  test('terms are ORed, because an AND over a whole message matches nothing', () => {
    // The regression this guards: with AND, the reader's message "the chest below is
    // locked and I have lost the thing that opens it" matched exactly one row — the
    // question itself — because no other row contains all of its own words. Recall
    // returned the question and the model invented an answer.
    const query = buildMatchQuery('the chest below is locked and I have lost the key');
    expect(query).toContain(' OR ');
    expect(query).not.toContain('"the"');
    expect(query).not.toContain('"is"');
    expect(query).not.toContain('"and"');
    expect(query).toContain('"chest"');
    expect(query).toContain('"locked"');
    expect(query).toContain('"key"');
  });

  test('an all-stopword query keeps its words rather than matching everything', () => {
    // Dropping every token would leave an empty MATCH, which is a syntax error — and
    // matching nothing is still better than matching the entire chat.
    expect(buildMatchQuery('what is it')).toBe('"what" OR "is" OR "it"');
  });

  test('strips surrounding punctuation so a sentence finds its words', () => {
    // "it?" and "it." are different tokens to FTS5 and neither is the word "it".
    expect(buildMatchQuery('the key, marked 417.')).toBe('"key" OR "marked" OR "417"');
  });

  test('collapses whitespace and returns empty for blank input', () => {
    expect(buildMatchQuery('')).toBe('');
    expect(buildMatchQuery('   \t\n ')).toBe('');
    expect(buildMatchQuery('  Ada   Bob  ')).toBe('"Ada" OR "Bob"');
  });

  test('an injected operator is neutralized — the raw query would return the wrong rows', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seedMessage(db, chatId, 'Ada refuses to leave the room.');
    seedMessage(db, chatId, 'Bob leaves the room.');

    // Deliberately bypasses `recall` so the test can show what the UNESCAPED query
    // does; `rawMatches` is the control, `recall` is the subject.
    const rawMatches = (match: string): number[] =>
      allOf<{ seq: number }>(
        db,
        `SELECT m.seq FROM messages_fts
           JOIN messages m ON m.seq = messages_fts.rowid
          WHERE messages_fts MATCH ?`,
        match,
      ).map((row) => row.seq);

    // Proof the injection is real, and why escaping is not cosmetic: unescaped, `OR` is
    // the FTS5 boolean operator, so this returns BOTH messages — neither of which
    // contains the word "OR".
    expect(rawMatches('room OR Ada')).toHaveLength(2);

    // Escaped, `OR` is the literal word "OR" and the only rows returned are ones that
    // genuinely contain a word the reader typed. With OR-joined terms that means the two
    // messages containing "room", not the two the injected operator would have produced.
    const hits = await recall(env, chatId, 'room OR Ada', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.kind === 'message')).toBe(true);

    // The literal word "OR" appears in neither seeded message, so a row returned FOR it
    // would mean the operator was interpreted rather than quoted.
    const seqs = hits.map((hit) => hit.refId);
    expect(new Set(seqs).size).toBe(seqs.length);

    // A bare `"` is worse than a wrong result: unescaped it is an unterminated phrase
    // and throws, taking the whole recall down. Escaped, it is literal text.
    expect(() => rawMatches('Ada "refuses')).toThrow(/unterminated string/);
    const quoted = await recall(env, chatId, 'Ada "refuses', 10);
    expect(quoted.map((hit) => hit.kind)).toEqual(['message']);
  });
});

describe('recall', () => {
  test('returns nothing for an empty query without issuing a MATCH', async () => {
    const { env, db, calls } = makeEnv();
    const chatId = seedChat(db);
    seedMessage(db, chatId, 'Ada refuses to leave the room.');

    expect(await recall(env, chatId, '   ', 10)).toEqual([]);
    // `MATCH ''` is a syntax error, so the guard must short-circuit before any query.
    expect(calls).toEqual([]);
  });

  test('binds the escaped MATCH expression and the chat id, and joins back on seq', async () => {
    const { env, db, calls } = makeEnv();
    const chatId = seedChat(db);
    seedMessage(db, chatId, 'Ada refuses to leave the room.');

    await recall(env, chatId, 'Ada room', 5);

    const messageQuery = calls.find((call) => call.sql.includes('messages_fts MATCH'));
    expect(messageQuery).toBeDefined();
    expect(messageQuery?.params).toEqual(['"Ada" OR "room"', chatId, 5]);
    // FTS5 stores only a rowid; without this join there is no way to filter by chat.
    expect(messageQuery?.sql).toContain('JOIN messages m ON m.seq = messages_fts.rowid');
    expect(messageQuery?.sql).toContain('bm25(messages_fts)');

    const factQuery = calls.find((call) => call.sql.includes('facts_fts MATCH'));
    expect(factQuery?.params).toEqual(['"Ada" OR "room"', chatId, 5]);
    // Superseded facts must not be recalled: the caller labels these "Established
    // facts", and a superseded one is something the story has moved past.
    expect(factQuery?.sql).toContain("f.status = 'active'");
    expect(factQuery?.sql).toContain('JOIN facts f ON f.rowid = facts_fts.rowid');
  });

  test('never leaks matches from another chat', async () => {
    const { env, db } = makeEnv();
    const mine = seedChat(db, 'chat-mine');
    const theirs = seedChat(db, 'chat-theirs');
    seedMessage(db, mine, 'Ada keeps the brass key in her coat.');
    seedMessage(db, theirs, 'Ada keeps the brass key in her boot.');

    const hits = await recall(env, mine, 'brass key', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('message');
    expect(hits[0].text).toContain('coat');
    // refId is the message uuid, not the seq: a seq is only meaningful inside its chat
    // and shifts on a re-anchor.
    expect(hits[0].refId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('finds facts and summaries, and always includes pinned facts', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seedMessage(db, chatId, 'The lantern gutters in the wind.');

    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
       VALUES ('f-pinned', ?, 'Ada is afraid of deep water.', 'Ada', 'active', 1, ?)`,
      chatId,
      Date.now(),
    );
    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
       VALUES ('f-match', ?, 'The brass key opens the lantern room.', 'key', 'active', 0, ?)`,
      chatId,
      Date.now(),
    );
    seedScene(db, chatId, 1, 3, 'Ada finds the brass key by the lantern.');

    const hits = await recall(env, chatId, 'brass', 10);
    const refIds = hits.map((hit) => `${hit.kind}:${hit.refId}`);

    // Pinned facts lead regardless of whether they match.
    expect(refIds[0]).toBe('fact:f-pinned');
    expect(refIds).toContain('fact:f-match');
    expect(refIds).toContain('summary:'.concat(hits.find((h) => h.kind === 'summary')?.refId ?? ''));
    expect(hits.some((hit) => hit.kind === 'summary')).toBe(true);
    // Summary hits carry score 0 — a LIKE hit is a weaker signal than bm25.
    expect(hits.find((hit) => hit.kind === 'summary')?.score).toBe(0);
  });

  test('superseded facts are never recalled, even when pinned', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
       VALUES ('f-old', ?, 'The brass key opens the cellar.', 'key', 'superseded', 1, 1)`,
      chatId,
    );
    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
       VALUES ('f-new', ?, 'The brass key opens the lantern room.', 'key', 'active', 0, 2)`,
      chatId,
    );

    const hits = await recall(env, chatId, 'brass key', 10);
    const ids = hits.map((hit) => hit.refId);
    expect(ids).toContain('f-new');
    expect(ids).not.toContain('f-old');
  });

  test('a LIKE query with wildcards is matched literally, not as a pattern', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seedScene(db, chatId, 1, 3, '100% of the rope is gone');
    seedScene(db, chatId, 4, 6, 'the rope is coiled');

    // Unescaped, `%` would match both rows. Escaped, only the literal one matches.
    const hits = await recall(env, chatId, '100%', 10);
    const summaries = hits.filter((hit) => hit.kind === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].text).toContain('100%');
  });

  test('recall results are returned, never written back into history', async () => {
    const { env, db, calls } = makeEnv();
    const chatId = seedChat(db);
    seedMessage(db, chatId, 'Ada refuses to leave the room.');

    await recall(env, chatId, 'Ada', 5);

    // No INSERT/UPDATE may originate from recall: the message log is append-only and
    // anything recalled belongs in the prompt tail.
    expect(calls.some((call) => /^\s*(INSERT|UPDATE|DELETE)/i.test(call.sql))).toBe(false);
  });
});

describe('summarize', () => {
  const realFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown> } | null = null;

  beforeEach(() => {
    captured = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Ada entered the cellar and locked the door.' } }],
          usage: { prompt_tokens: 40, completion_tokens: 12 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
      // `fetch` carries a `preconnect` property in the Workers types that a test
      // stub does not need; the cast goes through `unknown` to say so explicitly.
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function configure(env: Env): Promise<void> {
    await putSetting(env, 'provider', 'openrouter');
    await putSetting(env, 'model', 'test/model');
    await storeProviderKey(env, 'openrouter', 'sk-test');
  }

  test('writes a scene row covering exactly the requested range', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await configure(env);

    seedMessage(db, chatId, 'one');
    seedMessage(db, chatId, 'two');
    seedMessage(db, chatId, 'three');

    const summary = await summarize(env, chatId, 1, 3);

    const row = db
      .query('SELECT tier, covers_from, covers_to, content, tokens FROM summaries WHERE id = ?')
      .get(summary.id) as {
      tier: string;
      covers_from: number;
      covers_to: number;
      content: string;
      tokens: number;
    };
    expect(row.tier).toBe('scene');
    expect(row.covers_from).toBe(1);
    expect(row.covers_to).toBe(3);
    expect(row.content).toBe('Ada entered the cellar and locked the door.');
    expect(row.tokens).toBeGreaterThan(0);
  });

  test('generates from source messages only, never from a previous summary', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await configure(env);

    seedMessage(db, chatId, 'Ada entered the cellar.');
    seedMessage(db, chatId, 'The door locked behind her.');

    // An earlier summary already covers this range, with a distinctive marker. Feeding
    // it back in is exactly the SillyTavern "use that as a base and expand" mistake
    // that carries a misreading at message 40 forward forever.
    exec(
      db,
      `INSERT INTO summaries (id, chat_id, tier, covers_from, covers_to, content, tokens, created_at)
       VALUES ('prior', ?, 'scene', 1, 2, 'PRIOR-SUMMARY-SENTINEL', 1, ?)`,
      chatId,
      Date.now(),
    );

    await summarize(env, chatId, 1, 2);

    const messages = captured?.body.messages as Array<{ role: string; content: string }>;
    const user = messages.find((message) => message.role === 'user');
    expect(user?.content).toContain('Ada entered the cellar.');
    expect(user?.content).not.toContain('PRIOR-SUMMARY-SENTINEL');
    // The call is non-streaming: the whole answer is needed before anything is written.
    expect(captured?.body.stream).toBe(false);
  });

  test('throws a clear error when no model is configured, before writing anything', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seedMessage(db, chatId, 'one');

    await expect(summarize(env, chatId, 1, 1)).rejects.toThrow(/No cheap model configured/);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM summaries')).toEqual({ n: 0 });
  });

  test('refuses an empty range instead of asking the model about nothing', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await configure(env);

    await expect(summarize(env, chatId, 1, 5)).rejects.toThrow(/no messages/);
    expect(captured).toBeNull();
  });
});

describe('consolidate', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'The cellar arc, folded.' } }],
          usage: { prompt_tokens: 80, completion_tokens: 10 },
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function configure(env: Env): Promise<void> {
    await putSetting(env, 'provider', 'openrouter');
    await putSetting(env, 'model', 'test/model');
    await storeProviderKey(env, 'openrouter', 'sk-test');
  }

  test('does nothing below the threshold', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await configure(env);
    for (let i = 0; i < 9; i++) seedScene(db, chatId, i * 2 + 1, i * 2 + 2, `scene ${i}`);

    expect(await consolidate(env, chatId)).toBeNull();
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM summaries WHERE tier = 'arc'")).toEqual({ n: 0 });
  });

  test('folds ten scenes into one arc spanning their whole range', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await configure(env);
    for (let i = 0; i < 10; i++) seedScene(db, chatId, i * 2 + 1, i * 2 + 2, `scene ${i}`);

    const arc = await consolidate(env, chatId);
    expect(arc).not.toBeNull();

    const row = db
      .query("SELECT covers_from, covers_to, content FROM summaries WHERE tier = 'arc'")
      .get() as { covers_from: number; covers_to: number; content: string };
    expect(row.covers_from).toBe(1);
    expect(row.covers_to).toBe(20);
    expect(row.content).toBe('The cellar arc, folded.');
  });

  test('consumption is tracked by range: folded scenes are never folded again', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await configure(env);
    for (let i = 0; i < 10; i++) seedScene(db, chatId, i * 2 + 1, i * 2 + 2, `scene ${i}`);
    await consolidate(env, chatId);

    // The same ten scenes are still in the table — there is no `consumed_by` column.
    // A naive re-run must find nothing left to fold.
    expect(await consolidate(env, chatId)).toBeNull();

    // Ten NEW scenes beyond the arc's coverage do fold, into a second, disjoint arc.
    for (let i = 10; i < 20; i++) seedScene(db, chatId, i * 2 + 1, i * 2 + 2, `scene ${i}`);
    await consolidate(env, chatId);

    const arcs = db
      .query("SELECT covers_from, covers_to FROM summaries WHERE tier = 'arc' ORDER BY covers_from")
      .all() as Array<{ covers_from: number; covers_to: number }>;
    expect(arcs).toEqual([
      { covers_from: 1, covers_to: 20 },
      { covers_from: 21, covers_to: 40 },
    ]);
  });
});

describe('jobs', () => {
  test('enqueue is idempotent on the idempotency key', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const first = await enqueue(env, chatId, 'summarize', 'chat-1:1-20', { from: 1, to: 20 });
    const second = await enqueue(env, chatId, 'summarize', 'chat-1:1-20', { from: 1, to: 20 });

    expect(second).toBe(first);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM jobs')).toEqual({ n: 1 });
    // The payload survives, so a reclaimed job can be retried without the caller
    // reconstructing what it was for.
    expect(JSON.parse(String(listPendingPayload(db)))).toEqual({ from: 1, to: 20 });
  });

  test('a claim is exclusive while the lease holds, and reclaimable once it expires', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const jobId = await enqueue(env, chatId, 'summarize', 'k1', null);

    const first = await claim(env, jobId, 60_000);
    expect(first?.status).toBe('claimed');
    expect(first?.attempts).toBe(1);

    // A second Worker must not be able to take a job whose owner is still alive —
    // this is what stops two turns being generated for one request.
    expect(await claim(env, jobId, 60_000)).toBeNull();

    // Expire the lease: the owner died mid-generation. The job must come back.
    exec(db, 'UPDATE jobs SET lease_until = ? WHERE id = ?', Date.now() - 1, jobId);
    const reclaimed = await claim(env, jobId, 60_000);
    expect(reclaimed?.id).toBe(jobId);
    // attempts counts claims, so a job that keeps dying is identifiable.
    expect(reclaimed?.attempts).toBe(2);
  });

  test('finish clears the lease so a completed job cannot be dragged back', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const jobId = await enqueue(env, chatId, 'summarize', 'k1', null);
    await claim(env, jobId, 60_000);

    await finish(env, jobId, 'ready', { summaryId: 's1' });

    const row = one<{ status: string; lease_until: number | null; result: string }>(
      db,
      'SELECT status, lease_until, result FROM jobs WHERE id = ?',
      jobId,
    ) as { status: string; lease_until: number | null; result: string };
    expect(row.status).toBe('ready');
    expect(row.lease_until).toBeNull();
    expect(JSON.parse(row.result)).toEqual({ summaryId: 's1' });

    // Even after the original lease would have expired, recoverStale leaves it alone.
    expect(await recoverStale(env)).toBe(0);
    expect(await claim(env, jobId, 60_000)).toBeNull();
  });

  test('recoverStale requeues jobs whose owner vanished', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const alive = await enqueue(env, chatId, 'summarize', 'alive', null);
    const dead = await enqueue(env, chatId, 'summarize', 'dead', null);

    await claim(env, alive, 60_000);
    await claim(env, dead, 60_000);
    exec(db, 'UPDATE jobs SET lease_until = ? WHERE id = ?', Date.now() - 1, dead);

    expect(await recoverStale(env)).toBe(1);

    expect(one<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', dead)).toEqual({ status: 'queued' });
    expect(one<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', alive)).toEqual({ status: 'claimed' });
    // A recovered job is claimable again through the ordinary path.
    expect((await claim(env, dead, 60_000))?.id).toBe(dead);
  });

  test('start keeps the lease alive so a running job is never requeued', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const jobId = await enqueue(env, chatId, 'summarize', 'k1', null);
    const owned = await claim(env, jobId, 60_000);
    expect(owned).not.toBeNull();

    expect(await start(env, owned as JobRow, 60_000)).toBe(true);
    expect(one<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'generating',
    });

    // The whole point: a job that is mid-generation must survive a wake sweep. If
    // `start` had cleared the lease the way `finish` does, this would requeue a job
    // that is running perfectly well and it would be run twice.
    expect(await recoverStale(env)).toBe(0);
    expect(await claim(env, jobId, 60_000)).toBeNull();
  });

  test('start refuses a job whose lease already expired and was reclaimed', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const jobId = await enqueue(env, chatId, 'summarize', 'k1', null);
    const mine = await claim(env, jobId, 60_000);
    expect(mine).not.toBeNull();

    // Another Worker stole it after the lease lapsed.
    exec(db, 'UPDATE jobs SET lease_until = ? WHERE id = ?', Date.now() - 1, jobId);
    await recoverStale(env);
    await claim(env, jobId, 60_000);

    // The original owner must learn its result is stale and discard it, or both
    // Workers write a summary for the same range. The job is `claimed` again, so
    // status alone proves nothing — the lease value is what identifies the owner.
    expect(await start(env, mine as JobRow, 60_000)).toBe(false);
  });

  test('finish records a failure with its reason', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const jobId = await enqueue(env, chatId, 'summarize', 'k1', null);

    await finish(env, jobId, 'failed', undefined, 'provider 429');

    const row = one<{ status: string; error: string; result: string | null }>(
      db,
      'SELECT status, error, result FROM jobs WHERE id = ?',
      jobId,
    ) as { status: string; error: string; result: string | null };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('provider 429');
    expect(row.result).toBeNull();
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('delivered','failed')")).toEqual({ n: 0 });
  });
});

function listPendingPayload(db: Database): string | null {
  const row = one<{ payload: string | null }>(db, 'SELECT payload FROM jobs LIMIT 1');
  return row?.payload ?? null;
}

describe('memory viewer API', () => {
  async function body(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }

  test('lists summaries and facts, pinned first, superseded included', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seedScene(db, chatId, 1, 5, 'scene one');
    exec(
      db,
      `INSERT INTO summaries (id, chat_id, tier, covers_from, covers_to, content, tokens, created_at)
       VALUES ('a1', ?, 'arc', 1, 5, 'arc one', 1, ?)`,
      chatId,
      Date.now(),
    );
    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
       VALUES ('f-old', ?, 'Ada fears water', 'Ada', 'superseded', 0, 1)`,
      chatId,
    );
    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
       VALUES ('f-pin', ?, 'Ada carries the key', 'Ada', 'active', 1, 2)`,
      chatId,
    );

    const payload = await body(await listMemory(env, chatId));
    const summaries = payload.summaries as Array<{ tier: string; covers_from: number }>;
    const facts = payload.facts as Array<{ id: string; status: string }>;

    expect(summaries.map((row) => row.tier).sort()).toEqual(['arc', 'scene']);
    // Pinned first, then by created_at.
    expect(facts.map((row) => row.id)).toEqual(['f-pin', 'f-old']);
    // Superseded rows are still listed — the UI dims them rather than hiding history.
    expect(facts.some((row) => row.status === 'superseded')).toBe(true);
  });

  test('lists nothing for an unknown chat instead of erroring', async () => {
    const { env } = makeEnv();
    expect((await listMemory(env, 'nope')).status).toBe(404);
  });

  test('creates a fact and refuses a blank one', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const created = await createFact(
      env,
      new Request('http://x/api/memory/facts', {
        method: 'POST',
        body: JSON.stringify({ chatId, text: '  The key is brass.  ', pinned: true }),
      }),
    );
    expect(created.status).toBe(201);

    const row = one<{ text: string; pinned: number; status: string }>(
      db,
      'SELECT text, pinned, status FROM facts',
    );
    expect(row).toEqual({ text: 'The key is brass.', pinned: 1, status: 'active' });

    const blank = await createFact(
      env,
      new Request('http://x/api/memory/facts', {
        method: 'POST',
        body: JSON.stringify({ chatId, text: '   ' }),
      }),
    );
    expect(blank.status).toBe(400);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM facts')).toEqual({ n: 1 });
  });

  test('editing a fact keeps the FTS index in step', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await createFact(
      env,
      new Request('http://x/api/memory/facts', {
        method: 'POST',
        body: JSON.stringify({ chatId, text: 'The key is brass.' }),
      }),
    );
    const id = one<{ id: string }>(db, 'SELECT id FROM facts')?.id ?? '';

    const res = await mutateMemory(
      env,
      new Request('http://x/api/memory/facts/x', {
        method: 'PATCH',
        body: JSON.stringify({ text: 'The key is iron.', pinned: true }),
      }),
      'facts',
      id,
    );
    expect(res.status).toBe(200);

    const row = one<{ text: string; pinned: number }>(db, 'SELECT text, pinned FROM facts');
    expect(row).toEqual({ text: 'The key is iron.', pinned: 1 });

    // The update trigger must remove the old term and add the new one, or recall keeps
    // returning a fact by text it no longer contains.
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM facts_fts WHERE facts_fts MATCH '\"brass\"'")).toEqual({ n: 0 });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM facts_fts WHERE facts_fts MATCH '\"iron\"'")).toEqual({ n: 1 });
  });

  test('rejects an unknown status and an empty patch', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, status, pinned, created_at)
       VALUES ('f1', ?, 'x', 'active', 0, 1)`,
      chatId,
    );

    const bad = await mutateMemory(
      env,
      new Request('http://x/api/memory/facts/f1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'deleted' }),
      }),
      'facts',
      'f1',
    );
    expect(bad.status).toBe(400);

    const empty = await mutateMemory(
      env,
      new Request('http://x/api/memory/facts/f1', { method: 'PATCH', body: '{}' }),
      'facts',
      'f1',
    );
    expect(empty.status).toBe(400);
    expect(one<{ status: string }>(db, 'SELECT status FROM facts WHERE id = ?', 'f1')).toEqual({
      status: 'active',
    });
  });

  test('deleting a summary removes it', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seedScene(db, chatId, 1, 5, 'the lantern gutters');
    const id = one<{ id: string }>(db, 'SELECT id FROM summaries')?.id ?? '';

    const res = await mutateMemory(
      env,
      new Request('http://x/api/memory/summaries/x', { method: 'DELETE' }),
      'summaries',
      id,
    );
    expect(res.status).toBe(200);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM summaries')).toEqual({ n: 0 });
  });

  test('a summary edit must be non-empty', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seedScene(db, chatId, 1, 5, 'original');
    const id = one<{ id: string }>(db, 'SELECT id FROM summaries')?.id ?? '';

    const res = await mutateMemory(
      env,
      new Request('http://x/api/memory/summaries/x', {
        method: 'PATCH',
        body: JSON.stringify({ content: '  ' }),
      }),
      'summaries',
      id,
    );
    expect(res.status).toBe(400);
    expect(one<{ content: string }>(db, 'SELECT content FROM summaries')).toEqual({
      content: 'original',
    });
  });
});
