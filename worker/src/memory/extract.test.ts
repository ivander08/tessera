import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import { exec, makeTestEnv } from '../test/harness';
import { extractFacts } from './extract';
import { encryptKey } from '../../../src/lib/crypto';

/**
 * Fact extraction.
 *
 * This is the pass that did not exist. Measured on a real 157-turn chat before it was
 * built: **zero** facts, including twelve turns phrased as direct instructions to
 * remember something, which meant the memory block's "Established facts" section could
 * never render and `facts_fts` was dead weight in the prompt path.
 *
 * What is worth pinning is not that a model returns facts — it is the two rules that keep
 * a wrong answer from becoming permanent:
 *
 *  - a supersede target that was not in the list is DROPPED, because retiring the wrong
 *    fact silently removes a true one from the prompt;
 *  - the retire and the insert commit together, so there is never a committed turn where
 *    two contradictory facts are both active — and `superseded_by` can name the
 *    replacement, which only has an id once it exists.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replies with a fixed JSON body, so the test asserts on the WRITE not the model. */
function stubProvider(reply: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: {} }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function makeEnv(): { env: Env; db: Database } {
  const settings: Record<string, string> = { provider: 'openrouter', model: 'test/model' };
  const { promise: keyPromise, resolve: resolveKey } = Promise.withResolvers<{
    key_enc: Uint8Array;
    iv: Uint8Array;
  }>();
  void encryptKey('sk-test', 'token').then(({ enc, iv }) =>
    resolveKey({ key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) }),
  );

  const { env, db } = makeTestEnv({
    extra: { TESSERA_TOKEN: 'token' },
    stub: (sql) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      if (trimmed.includes('FROM settings')) {
        return { rows: Object.entries(settings).map(([key, value]) => ({ key, value })) };
      }
      if (trimmed.includes('FROM provider_keys')) return { row: keyPromise };
      return undefined;
    },
  });

  const now = Date.now();
  exec(db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES ('chat-1', NULL, NULL, 't', NULL, 0, 's', ?, ?)`,
    now,
    now,
  );
  exec(db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
     VALUES ('m1', 'chat-1', NULL, 'user', 'I owe the innkeeper forty crowns.', ?)`,
    now,
  );

  return { env, db };
}

function seedFact(db: Database, id: string, text: string): void {
  exec(db,
    `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
     VALUES (?, 'chat-1', ?, NULL, 'active', 0, ?)`,
    id,
    text,
    Date.now(),
  );
}

const factsOf = (db: Database): Array<{ text: string; status: string }> =>
  db.query('SELECT text, status FROM facts ORDER BY created_at').all() as Array<{
    text: string;
    status: string;
  }>;

/** Every column the date work added, so a test can assert on what was actually written. */
const datedRows = (db: Database): Array<{ text: string; at: string | null; kind: string }> =>
  db.query('SELECT text, at, kind FROM facts ORDER BY created_at').all() as Array<{
    text: string;
    at: string | null;
    kind: string;
  }>;

/** `superseded_by` per fact, keyed by text, which is what the Memory viewer renders. */
const supersededBy = (db: Database): Record<string, string | null> => {
  const rows = db
    .query('SELECT text, superseded_by FROM facts')
    .all() as Array<{ text: string; superseded_by: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.text, row.superseded_by]));
};

describe('extractFacts', () => {
  test('writes the facts the model returns', async () => {
    const { env, db } = makeEnv();
    stubProvider(
      JSON.stringify({
        facts: [
          { text: 'The traveller owes the innkeeper forty crowns.', subject: 'innkeeper' },
          { text: 'The traveller is allergic to shellfish.', subject: 'traveller' },
        ],
        supersede: [],
      }),
    );

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result).toEqual({ added: 2, superseded: 0 });
    expect(factsOf(db)).toEqual([
      { text: 'The traveller owes the innkeeper forty crowns.', status: 'active' },
      { text: 'The traveller is allergic to shellfish.', status: 'active' },
    ]);
  });

  test('supersedes the fact the model points at by NUMBER', async () => {
    // Numbered rather than id'd: reproducing a 36-character UUID was unreliable once the
    // list grew, and a wrong id silently retires a true fact.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');

    stubProvider(
      JSON.stringify({
        facts: [{ text: 'The debt is sixty crowns.', subject: 'innkeeper' }],
        supersede: [{ id: 1, reason: 'amount changed' }],
      }),
    );

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result).toEqual({ added: 1, superseded: 1 });
    expect(factsOf(db)).toEqual([
      { text: 'The debt is forty crowns.', status: 'superseded' },
      { text: 'The debt is sixty crowns.', status: 'active' },
    ]);

    // The supersession carries the turn that did it, which is what makes the write
    // reversible: regenerating that turn away restores the fact it retired. Without this the
    // column is 0, read as a permanent supersession, and the fact can never come back.
    const retired = db
      .query(`SELECT superseded_at_seq FROM facts WHERE text = 'The debt is forty crowns.'`)
      .get() as { superseded_at_seq: number } | undefined;
    expect(retired?.superseded_at_seq).toBe(9999);
  });

  test('names the REPLACEMENT in superseded_by, never the superseded row itself', async () => {
    // The column is rendered as user-visible prose in the Memory viewer, so pointing it at
    // the superseded fact's own id showed the reader "superseded by <its own id>".
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'The debt is sixty crowns.' }],
        supersede: [{ id: 1 }],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    const replacement = db
      .query("SELECT id FROM facts WHERE text = 'The debt is sixty crowns.'")
      .get() as { id: string };

    const by = supersededBy(db);
    expect(by['The debt is forty crowns.']).toBe(replacement.id);
    expect(by['The debt is forty crowns.']).not.toBe('f1');
  });

  test('leaves superseded_by null when there is no single replacement', async () => {
    // Two new facts were extracted, so naming one of them as "the replacement" would be a
    // guess; zero facts means there is nothing to name at all.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'The debt is sixty crowns.' }, { text: 'The debt was paid.' }],
        supersede: [{ id: 1 }],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    expect(supersededBy(db)['The debt is forty crowns.']).toBeNull();
  });

  test('accepts a numeric string for the supersede target', async () => {
    // Models quote numbers. `"1"` and `1` mean the same thing.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: '1' }] }));

    expect((await extractFacts(env, 'chat-1', 0, 9999)).superseded).toBe(1);
    expect(factsOf(db)[0].status).toBe('superseded');
  });

  test('drops a supersede target that was not in the list', async () => {
    // The rule that matters most: an out-of-range number must not retire anything, or a
    // hallucination removes a true fact from the prompt.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: 99 }, { id: 0 }, { id: -1 }] }));

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result.superseded).toBe(0);
    expect(factsOf(db)[0].status).toBe('active');
  });

  test('deduplicates a fact that is already stored', async () => {
    // Compared ignoring case and punctuation, so a model that rephrases slightly does not
    // put the same sentence in the prompt twice.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The traveller is allergic to shellfish.');
    stubProvider(
      JSON.stringify({ facts: [{ text: 'the traveller is allergic to shellfish' }], supersede: [] }),
    );

    expect((await extractFacts(env, 'chat-1', 0, 9999)).added).toBe(0);
    expect(factsOf(db)).toHaveLength(1);
  });

  test('deduplicates within one reply', async () => {
    const { env, db } = makeEnv();
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'Ada carries the key.' }, { text: 'ada carries the key' }],
        supersede: [],
      }),
    );

    expect((await extractFacts(env, 'chat-1', 0, 9999)).added).toBe(1);
    expect(factsOf(db)).toHaveLength(1);
  });

  test('a malformed reply adds nothing and does not throw', async () => {
    const { env, db } = makeEnv();
    stubProvider('I could not find any facts.');

    expect(await extractFacts(env, 'chat-1', 0, 9999)).toEqual({ added: 0, superseded: 0 });
    expect(factsOf(db)).toHaveLength(0);
  });

  test('a reply with an empty facts array adds nothing', async () => {
    // A legitimate answer: most scenes establish nothing new.
    const { env, db } = makeEnv();
    stubProvider(JSON.stringify({ facts: [], supersede: [] }));

    expect(await extractFacts(env, 'chat-1', 0, 9999)).toEqual({ added: 0, superseded: 0 });
    expect(factsOf(db)).toHaveLength(0);
  });

  test('an entry with no text is skipped rather than stored empty', async () => {
    const { env, db } = makeEnv();
    stubProvider(JSON.stringify({ facts: [{ text: '   ' }, { subject: 'x' }], supersede: [] }));

    expect((await extractFacts(env, 'chat-1', 0, 9999)).added).toBe(0);
    expect(factsOf(db)).toHaveLength(0);
  });

  test('a range with no messages is a no-op', async () => {
    const { env, db } = makeEnv();
    stubProvider(JSON.stringify({ facts: [{ text: 'should not land' }], supersede: [] }));

    expect(await extractFacts(env, 'chat-1', 5000, 6000)).toEqual({ added: 0, superseded: 0 });
    expect(factsOf(db)).toHaveLength(0);
  });

  test('a superseded fact is not offered again on the next run', async () => {
    // Only ACTIVE facts are listed to the model, so a retired one cannot be re-retired or
    // re-added by a later extraction over the same text.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: 1 }] }));

    await extractFacts(env, 'chat-1', 0, 9999);
    const active = db.query("SELECT COUNT(*) n FROM facts WHERE status='active'").get() as { n: number };
    expect(active.n).toBe(0);

    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: 1 }] }));
    const second = await extractFacts(env, 'chat-1', 0, 9999);
    expect(second.superseded).toBe(0);
  });

  /**
   * A chat past the prompt's fact bound.
   *
   * The first version selected `ORDER BY created_at LIMIT 60` — the 60 OLDEST facts — so a
   * fact recorded after that point was never shown to the model. A transcript that
   * contradicted it produced no supersession, both versions stayed `active`, and recall
   * could return them side by side. These two tests are the boundary of that failure.
   */
  function seedManyFacts(db: Database, count: number, text: (index: number) => string): void {
    const base = Date.now();
    for (let index = 1; index <= count; index += 1) {
      exec(db,
        `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
         VALUES (?, 'chat-1', ?, NULL, 'active', 0, ?)`,
        `f${index}`,
        text(index),
        base + index,
      );
    }
  }

  /** Captures the prompt the model was sent, and answers with a fixed JSON body. */
  function captureProvider(reply: string): () => string {
    let seen = '';
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      seen = String(init?.body ?? '');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: reply } }], usage: {} }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return () => seen;
  }

  test('shows the model a matching fact older than the newest sixty', async () => {
    // 200 facts, and the debt is #100 — outside the OLD window (the 60 oldest, f1-f60) and
    // outside the new recency window (the 60 newest, f141-f200). Only relevance can surface
    // it, which is the whole point: a contradiction the block names must reach the model
    // no matter how old the fact is.
    const { env, db } = makeEnv();
    seedManyFacts(db, 200, (index) =>
      index === 100 ? 'The debt to the innkeeper is forty crowns.' : `Filler fact number ${index}.`,
    );
    exec(db,
      `UPDATE messages SET content = 'I tell the innkeeper the debt is sixty crowns now.' WHERE id = 'm1'`,
    );

    const seenPrompt = captureProvider(
      JSON.stringify({
        facts: [{ text: 'The debt to the innkeeper is sixty crowns.' }],
        supersede: [{ id: 1 }],
      }),
    );

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result).toEqual({ added: 1, superseded: 1 });

    expect(seenPrompt()).toContain('The debt to the innkeeper is forty crowns.');
    expect(db.query("SELECT status FROM facts WHERE id = 'f100'").get()).toEqual({
      status: 'superseded',
    });
  });

  test('deduplicates against every active fact, not just the ones shown', async () => {
    // 200 facts and a restated one at #100: not matched by the block, and in neither the old
    // window (f1-f60) nor the new one (f141-f200). Deduplication has to consult the whole
    // store, or every extraction over that text inserts the sentence again.
    const { env, db } = makeEnv();
    seedManyFacts(db, 200, (index) =>
      index === 100 ? 'Ada keeps her charts in a leather tube.' : `Filler fact number ${index}.`,
    );
    exec(db, `UPDATE messages SET content = 'The weather turns cold.' WHERE id = 'm1'`);

    const seenPrompt = captureProvider(
      JSON.stringify({ facts: [{ text: 'ada keeps her charts in a leather tube' }] }),
    );

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result.added).toBe(0);
    // The row was outside the prompt window, so the skip came from the full-store check
    // rather than from the model being told it already exists.
    expect(seenPrompt()).not.toContain('Ada keeps her charts in a leather tube.');
    expect(db.query('SELECT COUNT(*) n FROM facts').get()).toEqual({ n: 200 });
  });
});

describe('extractFacts — in-world dates', () => {
  /**
   * A turn with a clock reading, which is what the model needs to date anything.
   *
   * `state_json` is where the clock lives — BESIDE the message, not in its content — and
   * leaving it out of the extraction query is the defect this whole change exists to fix.
   */
  function seedDatedMessage(db: Database, id: string, seq: number, at: string, content: string): void {
    exec(db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, seq, state_json, created_at)
       VALUES (?, 'chat-1', NULL, 'user', ?, ?, ?, ?)`,
      id,
      content,
      seq,
      JSON.stringify({ time: at }),
      Date.now(),
    );
  }

  test('the in-world clock is put in front of the transcript the model reads', async () => {
    // The defect: extraction was handed `role: content` only, so the date on disk was never
    // in the prompt and every fact came back undated.
    const { env, db } = makeEnv();
    seedDatedMessage(db, 'm2', 2, 'Wednesday, 30 September 2026, 05:34', 'She waits by the rail.');

    let seen = '';
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      seen = String(init?.body ?? '');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"facts":[],"events":[],"supersede":[]}' } }], usage: {} }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await extractFacts(env, 'chat-1', 0, 9999);
    expect(seen).toContain('[Wednesday, 30 September 2026, 05:34] user: She waits by the rail.');
  });

  test('writes the date the model copied from the transcript prefix', async () => {
    const { env, db } = makeEnv();
    seedDatedMessage(db, 'm2', 2, 'Wednesday, 30 September 2026, 05:34', 'They meet at the docks.');
    stubProvider(
      JSON.stringify({
        facts: [
          { text: 'Ivander first met Sydney at the docks.', subject: 'Sydney', at: 'Wednesday, 30 September 2026, 05:34' },
        ],
        events: [],
        supersede: [],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    expect(datedRows(db)).toEqual([
      { text: 'Ivander first met Sydney at the docks.', at: 'Wednesday, 30 September 2026, 05:34', kind: 'fact' },
    ]);
  });

  test('an absent date is null rather than the range end', async () => {
    // "This fact has no date" and "this fact is true as of the last turn" are different
    // claims, and defaulting to the range end would silently assert the second.
    const { env, db } = makeEnv();
    stubProvider(
      JSON.stringify({ facts: [{ text: 'Ada keeps her charts in a leather tube.' }], events: [], supersede: [] }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    expect(datedRows(db)).toEqual([
      { text: 'Ada keeps her charts in a leather tube.', at: null, kind: 'fact' },
    ]);
  });

  test('events are written with their own kind and are never superseded', async () => {
    // A thing that happened cannot become false, so an event is exempt from the supersede
    // rule that governs a fact.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    // Both readings the reply quotes must exist in the transcript, or they are dropped as
    // invented — which is the point of the validation added after this test was written.
    // It previously asserted two dates that appeared in no message.
    exec(db,
      `UPDATE messages SET seq = 1, state_json = ? WHERE id = 'm1'`,
      JSON.stringify({ time: 'Friday, 2 October 2026, 10:00' }),
    );

    stubProvider(
      JSON.stringify({
        facts: [{ text: 'The debt is sixty crowns.', at: 'Friday, 2 October 2026, 10:00' }],
        events: [
          { text: 'Sydney found out about the affair on 14 April 2026.', at: 'Tuesday, 14 April 2026, 20:00' },
        ],
        supersede: [{ id: 1, reason: 'amount changed' }],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    const rows = datedRows(db);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({
      text: 'The debt is sixty crowns.',
      at: 'Friday, 2 October 2026, 10:00',
      kind: 'fact',
    });
    // The event's own date was never in the transcript, so it is stored undated rather than
    // with a claim nobody can verify.
    expect(rows[2]).toEqual({
      text: 'Sydney found out about the affair on 14 April 2026.',
      at: null,
      kind: 'event',
    });
  });

  test('the same sentence cannot land once as a fact and once as an event', async () => {
    const { env, db } = makeEnv();
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'They met at the docks.', at: 'Tuesday, 14 April 2026, 20:00' }],
        events: [{ text: 'They met at the docks.', at: 'Tuesday, 14 April 2026, 20:00' }],
        supersede: [],
      }),
    );

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result.added).toBe(1);
    expect(datedRows(db)).toHaveLength(1);
  });

  test('a date the transcript never recorded is dropped, not stored', async () => {
    // The instruction says "use only dates you read in the prefixes", and nothing enforced
    // it: the value was copied straight from the model's JSON into `facts.at`. A model that
    // reformats, guesses, or invents a date wrote it to the database, where the Memory panel
    // presents it as the recorded clock and the timeline sorts by it.
    //
    // The transcript here carries exactly ONE reading, and the reply claims a different one.
    const { env, db } = makeEnv();
    exec(db,
      `UPDATE messages SET seq = 1, state_json = ? WHERE id = 'm1'`,
      JSON.stringify({ time: 'Wednesday, 30 September 2026, 05:34' }),
    );
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'They met at the docks.', at: 'Tuesday, 14 April 2026, 20:00' }],
        events: [],
        supersede: [],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    // Stored, but undated: a fact with no date is honest, a fact with an invented one is not.
    expect(datedRows(db)).toEqual([
      { text: 'They met at the docks.', at: null, kind: 'fact' },
    ]);
  });

  test('a date copied from the transcript is kept even when the model reformats it', async () => {
    // The converse: normalisation must not throw away a real reading. Models drop the
    // weekday, change the comma, or use a different separator.
    const { env, db } = makeEnv();
    exec(db,
      `UPDATE messages SET seq = 1, state_json = ? WHERE id = 'm1'`,
      JSON.stringify({ time: 'Wednesday, 30 September 2026, 05:34' }),
    );
    stubProvider(
      JSON.stringify({
        facts: [
          { text: 'They met at the docks.', at: '30 September 2026 05:34' },
          { text: 'The docks are closed on Sundays.', at: 'Tuesday, 14 April 2026, 20:00' },
        ],
        events: [],
        supersede: [],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    const rows = datedRows(db);
    // The reformatted real reading survives; the invented one does not.
    expect(rows[0]).toEqual({ text: 'They met at the docks.', at: '30 September 2026 05:34', kind: 'fact' });
    expect(rows[1].at).toBeNull();
  });
});
