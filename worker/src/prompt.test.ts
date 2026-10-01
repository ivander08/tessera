import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { buildPrompt } from './prompt';
import type { EffectiveSettings } from './effective';
import type { ChatRow } from './db';

/**
 * The prompt's history read.
 *
 * `buildPrompt` used to walk the WHOLE conversation and then discard everything before
 * `window_start_seq` — on the hottest path in the app, billed per row read. The bound is
 * now derived from the context budget, and this file pins both halves of that: the read
 * is bounded, and bounding it did not change the prompt.
 *
 * The second half is the one that matters most. A cheaper read that assembles a different
 * prompt is not an optimisation, it is a bug — and the prefix hash is where it would show
 * up, because a window computed differently changes the cached prefix and every turn
 * after it loses its cache.
 */

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

interface Recorded {
  sql: string;
  params: unknown[];
  rows: number;
}

function makeEnv(): { env: Env; db: Database; calls: Recorded[] } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }

  const calls: Recorded[] = [];
  const record = (sql: string, params: unknown[], rows: number): void => {
    calls.push({ sql, params, rows });
  };

  const DB = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all() {
          const results = db.query(sql).all(...(params as never[]));
          record(sql, params, results.length);
          return { results, success: true, meta: {} };
        },
        async first() {
          const row = db.query(sql).get(...(params as never[])) ?? null;
          record(sql, params, row ? 1 : 0);
          return row;
        },
        async run() {
          record(sql, params, 0);
          const result = db.run(sql, ...(params as never[]));
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      const out = [];
      for (const statement of statements) out.push(await statement.all());
      return out;
    },
  };

  return { env: { DB, APP_NAME: 'Tessera' } as unknown as Env, db, calls };
}

/** `bun-types` types the variadic form too narrowly; one seam keeps the cast out of call sites. */
function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

const CHAT_ID = 'chat-1';
const CHARACTER_ID = 'char-1';

function seedChat(db: Database, windowStartSeq: number): ChatRow {
  const now = Date.now();
  exec(
    db,
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES (?, 'Quill', NULL, ?, 'ccv2', 10, ?)`,
    CHARACTER_ID,
    JSON.stringify({
      name: 'Quill',
      description: 'A scribe.',
      personality: 'Dry.',
      scenario: 'A lantern room.',
      firstMes: '',
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      alternateGreetings: [],
      characterBook: null,
    }),
    now,
  );
  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES (?, ?, NULL, 't', NULL, ?, 'session-1', ?, ?)`,
    CHAT_ID,
    CHARACTER_ID,
    windowStartSeq,
    now,
    now,
  );

  return {
    id: CHAT_ID,
    character_id: CHARACTER_ID,
    persona_id: null,
    title: 't',
    preset_id: null,
    window_start_seq: windowStartSeq,
    session_id: 'session-1',
    last_prefix_hash: null,
    last_prefix_head: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * A linear chat of `count` messages, alternating user and assistant.
 *
 * `tokens` is written into `content_tokens` so the budget arithmetic in the test is
 * exact rather than dependent on the estimator's opinion of the seeded prose.
 */
function seedChain(db: Database, count: number, tokens = 20): number[] {
  const now = Date.now();
  let parent: string | null = null;
  const seqs: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `m${index}`;
    const role = index % 2 === 0 ? 'assistant' : 'user';
    exec(
      db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      id,
      CHAT_ID,
      parent,
      role,
      `line ${index} of the scene`,
      tokens,
      now,
    );
    seqs.push(
      (db.query('SELECT seq FROM messages WHERE id = ?').get(id) as { seq: number }).seq,
    );
    parent = id;
  }
  return seqs;
}

function settings(contextBudget: number): EffectiveSettings {
  return {
    provider: 'openrouter',
    model: 'test/model',
    systemPrompt: 'You are a narrator.',
    authorsNote: '',
    maxTokens: 1024,
    contextBudget,
    knobs: {},
    idrPerUsd: null,
    loreScanDepth: 4,
    loreTokenBudget: 1024,
    loreRecursive: false,
    stopStrings: [],
    assistantPrefill: '',
    includeNames: false,
    responseLengthRule: '',
    presetPostHistory: '',
    presetSystemPrompt: '',
  };
}

/** The history rows of an assembled prompt, in order. */
function bodyOf(prompt: { messages: Array<{ role: string; content: string }>; tailStart: number }): string[] {
  // The head is everything the assembler emitted before the history; the body runs up to
  // `tailStart`. Recovering it by content is the only way to read it without reaching
  // into `assemble`'s internals.
  return prompt.messages
    .slice(0, prompt.tailStart)
    .filter((message) => /^line \d+ of the scene$/.test(message.content))
    .map((message) => message.content);
}

describe('buildPrompt reads a bounded window', () => {
  test('a 500-message chat reads the tail, not the chat', async () => {
    const { db, env, calls } = makeEnv();
    // Budget 2,000 tokens at a floor of 40 tokens per row is a 50-row read.
    const chat = seedChat(db, 0);
    const seqs = seedChain(db, 500);
    // A stable window whose start IS the oldest row the read returns — which is what a
    // stable window means: the persisted start is held fixed while the window grows, so
    // it sits inside the loaded tail rather than below it.
    exec(db, 'UPDATE chats SET window_start_seq = ? WHERE id = ?', seqs[450], CHAT_ID);
    chat.window_start_seq = seqs[450];

    const prompt = await buildPrompt(env, chat, settings(2000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    // The bound is real: the walk is capped and no query returned more than the cap.
    //
    // The exact count is derived rather than hardcoded, because it now depends on the
    // history budget — the context window minus the measured head and the reserved tail —
    // and a test that pins the arithmetic would fail every time that reservation is
    // retuned. What matters is that the read is BOUNDED and that its bound is the walk's
    // own parameter.
    const tail = calls.find((call) => call.sql.includes('WITH RECURSIVE up'));
    expect(tail).toBeDefined();
    const limit = tail!.params[2] as number;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(400);
    expect(tail!.rows).toBe(limit);
    for (const call of calls) expect(call.rows).toBeLessThanOrEqual(limit);

    // And the read is a TAIL: the history is the newest rows, ending at the tail of the
    // chat. It is at most the read, because the window start was already inside it.
    const body = bodyOf(prompt);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(limit);
    expect(body[body.length - 1]).toBe('line 499 of the scene');
    // Contiguous and in order, with no gap between the window start and the tail.
    expect(body).toEqual(
      Array.from({ length: body.length }, (_, index) => `line ${500 - body.length + index} of the scene`),
    );
  });

  test('the history is exactly the rows the window covers', async () => {
    // This is the property that matters: the bound must not change WHAT is assembled.
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    const seqs = seedChain(db, 500);
    const windowStart = seqs[440];
    exec(db, 'UPDATE chats SET window_start_seq = ? WHERE id = ?', windowStart, CHAT_ID);
    chat.window_start_seq = windowStart;

    const prompt = await buildPrompt(env, chat, settings(2000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    // Everything from the window start forward, and nothing before it.
    const expected = Array.from(
      { length: 500 - 440 },
      (_, index) => `line ${440 + index} of the scene`,
    );
    expect(bodyOf(prompt)).toEqual(expected);
  });

  test('a short chat is read whole', async () => {
    const { db, env, calls } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 12);

    const prompt = await buildPrompt(env, chat, settings(2000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    // The floor keeps a short chat whole: there is nothing below the tail to miss.
    expect(bodyOf(prompt)).toHaveLength(12);
    const tail = calls.find((call) => call.sql.includes('WITH RECURSIVE up'));
    expect(tail!.rows).toBe(12);
  });

  test('a window start older than the read widens it once, and then stops', async () => {
    // The window start is older than the first 50 rows, so the tail was too small. The
    // read doubles once — and must not keep doubling, or a wrong budget becomes the
    // unbounded read this whole change removes.
    const { db, env, calls } = makeEnv();
    const chat = seedChat(db, 0);
    const seqs = seedChain(db, 500);
    const windowStart = seqs[0];
    exec(db, 'UPDATE chats SET window_start_seq = ? WHERE id = ?', windowStart, CHAT_ID);
    chat.window_start_seq = windowStart;

    const prompt = await buildPrompt(env, chat, settings(2000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    const tails = calls.filter((call) => call.sql.includes('WITH RECURSIVE up'));
    // Two reads: the first, then one doubled retry. Not a loop.
    expect(tails).toHaveLength(2);
    const first = tails[0].params[2] as number;
    expect(tails[1].params[2]).toBe(first * 2);

    // The window re-anchored to the newest rows that FIT the history budget — which is
    // at most what the second read returned, and reaches the tail. It is not the whole
    // read: the point of the re-anchor is to drop what does not fit.
    const body = bodyOf(prompt);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(first * 2);
    expect(body[body.length - 1]).toBe('line 499 of the scene');
  });

  test('the same input assembles the same prefix hash', async () => {
    // Determinism is the cache's whole guarantee, and it is what a differently-computed
    // window would break.
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    const seqs = seedChain(db, 200);
    exec(db, 'UPDATE chats SET window_start_seq = ? WHERE id = ?', seqs[100], CHAT_ID);
    chat.window_start_seq = seqs[100];

    const options = { mode: 'send' as const, userSeq: null, userContent: 'hello', tailExtra: '' };
    const first = await buildPrompt(env, chat, settings(4000), options);
    const second = await buildPrompt(env, chat, settings(4000), options);

    expect(first.prefixHash).toBe(second.prefixHash);
    expect(first.messages).toEqual(second.messages);
  });

  test('the tail read is bounded even when the chat is enormous', async () => {
    const { db, env, calls } = makeEnv();
    const chat = seedChat(db, 0);
    // A large budget against a chat of small messages would ask for thousands of rows,
    // which is what the ceiling exists to refuse.
    const seqs = seedChain(db, 1500, 5);
    exec(db, 'UPDATE chats SET window_start_seq = ? WHERE id = ?', seqs[1100], CHAT_ID);
    chat.window_start_seq = seqs[1100];

    await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    // 1,500 messages must not mean 1,500 rows read: the walk is capped at 400 and the
    // stable window start sits inside that, so one read answers the turn.
    const tails = calls.filter((call) => call.sql.includes('WITH RECURSIVE up'));
    expect(tails).toHaveLength(1);
    expect(tails[0].params[2]).toBe(400);
    expect(tails[0].rows).toBe(400);
    for (const call of calls) expect(call.rows).toBeLessThanOrEqual(400);
  });
});

/**
 * The cast, and the `includeNames` lever.
 *
 * `includeNames` was parsed, plumbed through `EffectiveSettings` and exposed in the preset
 * editor long before anything consumed it — so these tests are the first proof that
 * setting it changes what is sent.
 *
 * The property that matters most here is CACHE SAFETY. A history row's prefix has to
 * render the same text on every turn, or the cached prefix changes and the cache is lost —
 * which is why the speaker is read from the row rather than inferred from the current
 * cast. The cast grows; a stored name does not.
 */
describe('buildPrompt: the cast and includeNames', () => {
  /** The tail messages, which is where the cast block lives. */
  function tailOf(prompt: { messages: Array<{ role: string; content: string }>; tailStart: number }) {
    return prompt.messages.slice(prompt.tailStart).map((message) => message.content);
  }

  /** A chat with `extra` introduced speakers, and rows carrying stored speakers. */
  function seedCast(db: Database, names: string[]): void {
    const now = Date.now();
    for (const name of names) {
      exec(
        db,
        `INSERT INTO chat_cast (chat_id, id, character_id, name, color, is_primary, created_at)
         VALUES (?, ?, NULL, ?, '--voice-2', 0, ?)`,
        CHAT_ID,
        `cast-${name}`,
        name,
        now,
      );
    }
  }

  test('a single-member cast sends no cast block, so existing scenes are unchanged', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 4);

    const prompt = await buildPrompt(env, chat, settings(4000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    expect(tailOf(prompt).some((text) => text.includes('Speakers in this scene'))).toBe(false);
  });

  test('a multi-member cast names every speaker, the reader last', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 4);
    seedCast(db, ['Olivia', 'Ada']);

    const prompt = await buildPrompt(env, chat, settings(4000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    const block = tailOf(prompt).find((text) => text.includes('Speakers in this scene'));
    expect(block).toBeDefined();
    expect(block).toContain('Quill (the character you write)');
    expect(block).toContain('Olivia (a supporting character)');
    expect(block).toContain('Ada (a supporting character)');
    expect(block).toContain('(the reader)');
    // The script form is the contract the parser reads, so the instruction has to say so.
    expect(block).toContain('each speaker\'s name on its own line');
  });

  test('the cast block is in the TAIL, never the cached prefix', async () => {
    // A cast grows during a scene. A block in the head would rewrite the cached prefix
    // every time a character was introduced.
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 4);
    seedCast(db, ['Olivia']);

    const prompt = await buildPrompt(env, chat, settings(4000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    const prefix = prompt.messages.slice(0, prompt.tailStart);
    expect(prefix.some((message) => message.content.includes('Speakers in this scene'))).toBe(false);
  });

  test('adding a cast member does not change the prefix hash', async () => {
    // The property the whole design protects: the cast is per-turn state, so growing it
    // must not cost the cache.
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 4);

    const options = { mode: 'send' as const, userSeq: null, userContent: 'hello', tailExtra: '' };
    const before = await buildPrompt(env, chat, settings(4000), options);

    seedCast(db, ['Olivia']);
    const after = await buildPrompt(env, chat, settings(4000), options);

    expect(after.prefixHash).toBe(before.prefixHash);
    // And the tail DID change, so the equality above is not vacuous.
    expect(after.messages).not.toEqual(before.messages);
  });

  test('includeNames prefixes each history row with its speaker', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 4);
    // A row that recorded who wrote it.
    exec(db, "UPDATE messages SET speaker = 'Olivia' WHERE id = 'm2'");

    const prompt = await buildPrompt(env, chat, { ...settings(4000), includeNames: true }, {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    const body = prompt.messages.slice(0, prompt.tailStart).map((message) => message.content);
    // The assistant row with a stored speaker is prefixed with it.
    expect(body).toContain('Olivia: line 2 of the scene');
    // A row with no speaker is the chat's own character.
    expect(body).toContain('Quill: line 0 of the scene');
    // The reader's rows carry the persona fallback, not the character's name.
    expect(body).toContain('User: line 1 of the scene');
  });

  test('without includeNames the rows are sent verbatim', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 4);
    exec(db, "UPDATE messages SET speaker = 'Olivia' WHERE id = 'm2'");

    const prompt = await buildPrompt(env, chat, settings(4000), {
      mode: 'send',
      userSeq: null,
      userContent: 'hello',
      tailExtra: '',
    });

    const body = prompt.messages.slice(0, prompt.tailStart).map((message) => message.content);
    expect(body).toContain('line 2 of the scene');
    expect(body).not.toContain('Olivia: line 2 of the scene');
  });

  test('a stored speaker keeps its own prefix when the cast grows', async () => {
    // The cache-safety property: the prefix for a given row must not change because a new
    // speaker was introduced later. Inferring the speaker from the current cast would
    // re-label old turns.
    const { db, env } = makeEnv();
    const chat = seedChat(db, 0);
    seedChain(db, 4);
    exec(db, "UPDATE messages SET speaker = 'Olivia' WHERE id = 'm2'");

    const withNames = { ...settings(4000), includeNames: true };
    const options = { mode: 'send' as const, userSeq: null, userContent: 'hello', tailExtra: '' };

    const before = await buildPrompt(env, chat, withNames, options);
    const beforeRow = before.messages.find((m) => m.content === 'Olivia: line 2 of the scene');
    expect(beforeRow).toBeDefined();

    seedCast(db, ['Ada', 'Bram']);
    const after = await buildPrompt(env, chat, withNames, options);

    // The same row, prefixed identically, and the prefix hash is unchanged with it.
    expect(after.messages.find((m) => m.content === 'Olivia: line 2 of the scene')).toEqual(beforeRow);
    expect(after.prefixHash).toBe(before.prefixHash);
  });
});
