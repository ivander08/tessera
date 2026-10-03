import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { buildPrompt } from './prompt';
import { historyCutoffFor, stateSeqFor } from './turn';
import type { EffectiveSettings } from './effective';
import type { ChatRow } from './db';

/**
 * The four turn modes on a long, branching chat.
 *
 * Every other prompt test uses a short fixture, and that is exactly how two real bugs got
 * through: `loadPathTail` returns the NEWEST rows of the path, so applying a regenerate's
 * cutoff to those rows afterwards left a 200-turn chat's early re-roll with no history at
 * all — while a 9-turn fixture passed, because the whole chat fit inside the load either
 * way. The window floor had the same shape of bug: `computeWindowStart` treats its argument
 * as the oldest row to INCLUDE, so flooring at a cutoff (an exclusive UPPER bound) excluded
 * everything.
 *
 * So the fixture here is long enough to force the window to re-anchor and to make the load
 * bound real: 200 turns at 20 tokens each is 4,000 tokens, well past `MIN_HISTORY_BUDGET`.
 *
 * `historyTurns` reads only the HISTORY region. Memory and state blocks legitimately quote
 * turn text — recall returns "Relevant earlier moments" — so scanning the whole prompt
 * double-counts a turn and reports a duplicate that is not there.
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
  '0013_presets_authored.sql',
  '0014_provenance.sql',
  '0015_supersession_provenance.sql',
];

const CHAT_ID = 'chat-1';

function makeEnv(): { env: Env; db: Database } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const DB = {
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
          db.run(sql, ...(params as never[]));
          return { success: true, meta: {} };
        },
      };
      return statement;
    },
  };
  return { env: { DB, APP_NAME: 'Tessera' } as unknown as Env, db };
}

function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

function one<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  return (db.query(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function settings(contextBudget: number): EffectiveSettings {
  return {
    provider: 'openrouter',
    model: 'test/model',
    systemPrompt: 'You are a narrator.',
    authorsNote: '',
    maxTokens: 1024,
    contextBudget,
    cheapContextBudget: 0,
    knobs: {},
    idrPerUsd: null,
    loreScanDepth: 4,
    loreTokenBudget: 1024,
    loreRecursive: false,
    disableReasoning: true,
    stopStrings: [],
    assistantPrefill: '',
    includeNames: false,
    responseLengthRule: '',
    presetPostHistory: '',
    presetSystemPrompt: '',
    presetImpersonation: '',
    presetPreHistory: '',
  };
}

function seedChat(db: Database): ChatRow {
  const now = Date.now();
  exec(
    db,
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES ('char-1', 'Quill', NULL, ?, 'ccv2', 10, ?)`,
    JSON.stringify({
      name: 'Quill',
      nickname: 'Quill',
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
     VALUES (?, 'char-1', NULL, 't', NULL, 0, 'session-1', ?, ?)`,
    CHAT_ID,
    now,
    now,
  );
  return {
    id: CHAT_ID,
    character_id: 'char-1',
    persona_id: null,
    title: 't',
    preset_id: null,
    window_start_seq: 0,
    session_id: 'session-1',
    last_prefix_hash: null,
    last_prefix_head: null,
    created_at: now,
    updated_at: now,
  };
}

/** A linear trunk of `count` turns, each 20 tokens, oldest first. */
function seedTrunk(db: Database, count: number): Array<{ id: string; seq: number }> {
  const now = Date.now();
  let parent: string | null = null;
  const rows: Array<{ id: string; seq: number }> = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `m${index}`;
    exec(
      db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES (?, ?, ?, ?, ?, 20, 1, ?)`,
      id,
      CHAT_ID,
      parent,
      index % 2 === 1 ? 'assistant' : 'user',
      `TURN_${index}`,
      now,
    );
    const seq = one<{ seq: number }>(db, 'SELECT seq FROM messages WHERE id = ?', id)!.seq;
    rows.push({ id, seq });
    parent = id;
  }
  return rows;
}

function currentChat(db: Database): ChatRow {
  const row = one<{ window_start_seq: number }>(
    db,
    'SELECT window_start_seq FROM chats WHERE id = ?',
    CHAT_ID,
  )!;
  const now = Date.now();
  return {
    id: CHAT_ID,
    character_id: 'char-1',
    persona_id: null,
    title: 't',
    preset_id: null,
    window_start_seq: row.window_start_seq,
    session_id: 'session-1',
    last_prefix_hash: null,
    last_prefix_head: null,
    created_at: now,
    updated_at: now,
  };
}

/** The turns in the HISTORY region only, ignoring memory/state blocks that quote them. */
function historyTurns(prompt: { messages: Array<{ content: string }>; tailStart: number }): number[] {
  const history = prompt.messages.slice(0, prompt.tailStart).map((message) => message.content).join('\n');
  return [...history.matchAll(/TURN_(\d+)/g)].map((match) => Number(match[1]));
}

function promptText(prompt: { messages: Array<{ content: string }> }): string {
  return prompt.messages.map((message) => message.content).join('\n');
}

describe('the four turn modes on a long chat', () => {
  test('send reads the newest window, with no duplicated rows', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db);
    seedTrunk(db, 200);

    const prompt = await buildPrompt(env, chat, settings(8000), {
      mode: 'send',
      historyCutoff: null,
      stateSeq: null,
      userContent: 'next',
      tailExtra: '',
    });

    const turns = historyTurns(prompt);
    expect(turns).toContain(200);
    // The window is a contiguous tail of the path: no row appears twice, and the load bound
    // did not double-add anything.
    expect(new Set(turns).size).toBe(turns.length);
  });

  test('an early regenerate reads exactly its ancestry', async () => {
    // A TIGHT budget is load-bearing. At a generous one the load limit covers the whole
    // chat, so the load bound never bites and the empty-history bug stays invisible —
    // verified by reverting the bound and watching this test still pass at 8000.
    const { db, env } = makeEnv();
    const chat = seedChat(db);
    const trunk = seedTrunk(db, 200);

    const prompt = await buildPrompt(env, chat, settings(2500), {
      mode: 'regenerate',
      historyCutoff: historyCutoffFor('regenerate', trunk[2], false),
      stateSeq: stateSeqFor('regenerate', trunk[2]),
      userContent: '',
      tailExtra: '',
    });

    // Before the load was bounded, this was EMPTY: the newest rows were loaded and every one
    // was dropped for being past the target.
    expect(historyTurns(prompt)).toEqual([1, 2]);
    // And nothing from the turns being replaced, anywhere in the prompt.
    expect(promptText(prompt)).not.toContain('TURN_200');
  });

  test('a late regenerate still has its ancestry', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db);
    const trunk = seedTrunk(db, 200);

    const prompt = await buildPrompt(env, chat, settings(2500), {
      mode: 'regenerate',
      historyCutoff: historyCutoffFor('regenerate', trunk[150], false),
      stateSeq: stateSeqFor('regenerate', trunk[150]),
      userContent: '',
      tailExtra: '',
    });

    const turns = historyTurns(prompt);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns).not.toContain(151);
    expect(turns).not.toContain(200);
  });

  test('impersonate reads the whole visible path', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db);
    seedTrunk(db, 200);

    const prompt = await buildPrompt(env, chat, settings(8000), {
      mode: 'impersonate',
      historyCutoff: historyCutoffFor('impersonate', null, false),
      stateSeq: stateSeqFor('impersonate', null),
      userContent: '',
      tailExtra: '',
    });

    expect(historyTurns(prompt)).toContain(200);
  });

  test('a continue extending the tail still reads its target', async () => {
    const { db, env } = makeEnv();
    const chat = seedChat(db);
    const trunk = seedTrunk(db, 200);

    const prompt = await buildPrompt(env, chat, settings(8000), {
      mode: 'continue',
      historyCutoff: historyCutoffFor('continue', trunk[199], false),
      stateSeq: stateSeqFor('continue', trunk[199]),
      userContent: '',
      tailExtra: '',
    });

    expect(historyTurns(prompt)).toContain(200);
  });

  test('a recovery continue does not repeat the reader row it is answering', async () => {
    // The target is a USER row that already exists and is passed as the tail, so leaving it
    // in the history would send the reader's own line twice.
    const { db, env } = makeEnv();
    const chat = seedChat(db);
    const trunk = seedTrunk(db, 200);
    // TURN_198 is a user row (even index), which is the stopped-turn shape.
    const target = trunk[197];

    const prompt = await buildPrompt(env, chat, settings(8000), {
      mode: 'continue',
      historyCutoff: historyCutoffFor('continue', target, true),
      stateSeq: stateSeqFor('continue', target),
      userContent: 'RECOVERY_TAIL',
      tailExtra: '',
    });

    expect(historyTurns(prompt)).not.toContain(198);
    expect(promptText(prompt)).toContain('RECOVERY_TAIL');
  });

  test('no regenerate moves the persisted window start', async () => {
    // The window is computed from a truncated view, so writing it back would shrink the
    // chat's context for every later turn — permanently.
    const { db, env } = makeEnv();
    seedChat(db);
    const trunk = seedTrunk(db, 200);
    exec(db, 'UPDATE chats SET window_start_seq = ? WHERE id = ?', trunk[39].seq, CHAT_ID);

    const anchor = trunk[39].seq;
    for (const index of [2, 50, 150]) {
      await buildPrompt(env, currentChat(db), settings(8000), {
        mode: 'regenerate',
        historyCutoff: historyCutoffFor('regenerate', trunk[index], false),
        stateSeq: stateSeqFor('regenerate', trunk[index]),
        userContent: '',
        tailExtra: '',
      });
    }

    const stored = one<{ window_start_seq: number }>(
      db,
      'SELECT window_start_seq FROM chats WHERE id = ?',
      CHAT_ID,
    );
    expect(stored?.window_start_seq).toBe(anchor);
  });
});

describe('branching on a long chat', () => {
  test('regenerating an early turn replaces the continuation, and swiping back restores it', async () => {
    const { db, env } = makeEnv();
    seedChat(db);
    seedTrunk(db, 200);

    // A sibling of m3, so the new version takes that position and the trunk after it leaves
    // the transcript.
    exec(
      db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES ('b3', ?, 'm2', 'assistant', 'TURN_3b', 20, 1, ?)`,
      CHAT_ID,
      Date.now(),
    );
    exec(db, `UPDATE messages SET active = 0 WHERE id = 'm3'`);

    const branched = await buildPrompt(env, currentChat(db), settings(8000), {
      mode: 'send',
      historyCutoff: null,
      stateSeq: null,
      userContent: 'x',
      tailExtra: '',
    });
    const branchTurns = historyTurns(branched);
    expect(branchTurns).toContain(3);
    expect(branchTurns).not.toContain(4);
    expect(promptText(branched)).not.toContain('TURN_200');

    // Swipe back.
    exec(db, `UPDATE messages SET active = 1 WHERE id = 'm3'`);
    exec(db, `UPDATE messages SET active = 0 WHERE id = 'b3'`);

    const restored = await buildPrompt(env, currentChat(db), settings(8000), {
      mode: 'send',
      historyCutoff: null,
      stateSeq: null,
      userContent: 'x',
      tailExtra: '',
    });
    expect(historyTurns(restored)).toContain(200);
  });

  test('deleting a middle turn truncates there and keeps what came before', async () => {
    const { db, env } = makeEnv();
    seedChat(db);
    seedTrunk(db, 200);

    exec(db, `UPDATE messages SET deleted = 1, active = 0 WHERE id = 'm100'`);

    const prompt = await buildPrompt(env, currentChat(db), settings(8000), {
      mode: 'send',
      historyCutoff: null,
      stateSeq: null,
      userContent: 'x',
      tailExtra: '',
    });

    const turns = historyTurns(prompt);
    expect(turns).toContain(99);
    expect(turns).not.toContain(101);
    expect(promptText(prompt)).not.toContain('TURN_200');
  });
});
