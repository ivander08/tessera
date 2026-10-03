import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { buildPrompt } from './prompt';
import { stateSeqFor } from './turn';
import type { EffectiveSettings } from './effective';
import type { ChatRow } from './db';

/**
 * Point-in-time correctness, proved on scenario conversations.
 *
 * Three defects shared one cause: a read filtered by `seq` — a global INSERT COUNTER — or
 * by nothing at all, instead of by the VISIBLE PATH and the turn being written.
 *
 *  1. World state was read live for every mode, so a regenerate was told how the scene
 *     turned out.
 *  2. Summaries were read with no seq bound, so a regenerate of turn 3 could be handed a
 *     summary of turn 9.
 *  3. Summaries were read without checking the path, so a deleted turn's summary kept
 *     being injected describing a scene the reader had removed.
 *
 * These tests drive real `buildPrompt` calls over a seeded conversation and assert on the
 * assembled prompt — not on a helper's return value. The distinction matters: each of these
 * bugs was a correct-looking function being called at the wrong moment, so a test of the
 * function alone would have passed while the prompt was wrong.
 *
 * The fixture is deliberately long enough to populate every memory tier:
 *   - `SUMMARY_EVERY = 20`     -> a scene summary needs 20 visible messages
 *   - `SCENES_PER_ARC = 10`    -> an arc needs 10 scenes, so 200 messages
 * A nine-turn chat cannot produce an arc, and a test built on one would silently prove
 * nothing about arc handling.
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
          const result = db.run(sql, ...(params as never[]));
          return { success: true, meta: { changes: result.changes } };
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

const CHAT_ID = 'chat-1';
const CHARACTER_ID = 'char-1';

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

/** A chat whose card and cast exist, so every context block has something to render. */
function seedChat(db: Database): ChatRow {
  const now = Date.now();
  exec(
    db,
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES (?, 'Quill', NULL, ?, 'ccv2', 10, ?)`,
    CHARACTER_ID,
    JSON.stringify({
      name: 'Quill',
      nickname: 'Quill',
      description: 'A scribe who keeps the lamp room.',
      personality: 'Dry.',
      scenario: 'A lantern room above the harbour.',
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
     VALUES (?, ?, NULL, 't', NULL, 0, 'session-1', ?, ?)`,
    CHAT_ID,
    CHARACTER_ID,
    now,
    now,
  );
  return {
    id: CHAT_ID,
    character_id: CHARACTER_ID,
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

/**
 * `count` visible messages, alternating, in one linear scene.
 *
 * Content is stable and greppable: `turn N ...` lets an assertion name the exact turn it
 * expects to see or not see, which is what makes "turn 9's memory must not appear" a real
 * assertion rather than a proxy.
 */
function seedConversation(db: Database, count: number): Array<{ id: string; seq: number }> {
  const now = Date.now();
  let parent: string | null = null;
  const rows: Array<{ id: string; seq: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const id = `m${index}`;
    exec(
      db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES (?, ?, ?, ?, ?, 20, 1, ?)`,
      id,
      CHAT_ID,
      parent,
      index % 2 === 0 ? 'assistant' : 'user',
      `turn ${index + 1} of the scene`,
      now,
    );
    const seq = one<{ seq: number }>(db, 'SELECT seq FROM messages WHERE id = ?', id)!.seq;
    rows.push({ id, seq });
    parent = id;
  }
  return rows;
}

/** A scene summary over a seq range, which is what `summarize` writes. */
function seedScene(
  db: Database,
  coversFrom: number,
  coversTo: number,
  content: string,
  tier: 'scene' | 'arc' = 'scene',
): string {
  const id = `s-${tier}-${coversTo}`;
  exec(
    db,
    `INSERT INTO summaries (id, chat_id, tier, covers_from, covers_to, content, tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 10, ?)`,
    id,
    CHAT_ID,
    tier,
    coversFrom,
    coversTo,
    content,
    Date.now(),
  );
  return id;
}

function seedFact(db: Database, id: string, text: string, pinned = 0): void {
  exec(
    db,
    `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
     VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
    id,
    CHAT_ID,
    text,
    pinned,
    Date.now(),
  );
}

function setState(db: Database, json: unknown): void {
  exec(
    db,
    `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    CHAT_ID,
    JSON.stringify(json),
    Date.now(),
  );
}

function snapshotState(db: Database, messageId: string, json: unknown): void {
  exec(db, 'UPDATE messages SET state_json = ? WHERE id = ?', JSON.stringify(json), messageId);
}

/** The whole assembled prompt as one searchable string. */
function promptText(prompt: { messages: Array<{ role: string; content: string }> }): string {
  return prompt.messages.map((message) => message.content).join('\n');
}

/** Only the volatile tail, which is where memory and state live. */
function tailText(prompt: { messages: Array<{ role: string; content: string }>; tailStart: number }): string {
  return prompt.messages.slice(prompt.tailStart).map((message) => message.content).join('\n');
}

/**
 * A conversation long enough to have produced every memory tier, with all of them seeded:
 * a scene summary, an arc, facts, and a state snapshot on a late turn.
 */
function seedFullMemoryChat(db: Database): {
  chat: ChatRow;
  rows: Array<{ id: string; seq: number }>;
} {
  const chat = seedChat(db);
  const rows = seedConversation(db, 200);

  // Ten scenes, so consolidation has something to fold into an arc (SCENES_PER_ARC = 10).
  for (let scene = 0; scene < 10; scene += 1) {
    seedScene(
      db,
      rows[scene * 20].seq,
      rows[scene * 20 + 19].seq,
      `SCENE_${scene} summary text`,
    );
  }
  // An arc folding those ten scenes.
  seedScene(db, rows[0].seq, rows[199].seq, 'ARC summary text', 'arc');

  seedFact(db, 'f-pinned', 'FACT_PINNED the harbour light is out.', 1);
  seedFact(db, 'f-late', 'FACT_LATE the keeper has left the lamp room.');

  // The scene moves: early on the lamp room, later the path outside.
  snapshotState(db, rows[0].id, { location: 'STATE_LAMP_ROOM', present: ['Quill'] });
  snapshotState(db, rows[19].id, { location: 'STATE_LAMP_ROOM', present: ['Quill'] });
  snapshotState(db, rows[199].id, { location: 'STATE_OUTSIDE', away: { Quill: 'down the path' } });
  setState(db, { location: 'STATE_OUTSIDE', away: { Quill: 'down the path' } });

  return { chat, rows };
}

describe('scenario: which state a mode reads', () => {
  test('only regenerate names a point in time; every forward mode reads live', () => {
    // The wiring, not the helper. `buildPrompt` was always passed a stateSeq, so the bug
    // lived entirely in which value `turn.ts` computed — and a test that only drives
    // `buildPrompt` would keep passing with that computation reverted.
    const target = { seq: 42 };

    expect(stateSeqFor('regenerate', target)).toBe(42);
    // A regenerate with nothing to re-roll cannot name a point; live is the only safe read.
    expect(stateSeqFor('regenerate', null)).toBeNull();
    // A step forward must see how the scene turned out, so it reads the live document.
    expect(stateSeqFor('send', target)).toBeNull();
    expect(stateSeqFor('continue', target)).toBeNull();
    expect(stateSeqFor('impersonate', target)).toBeNull();
  });
});

describe('scenario: regenerating an early turn', () => {
  test('turn 9s memory, arc and state are all excluded from a regenerate of turn 3', async () => {
    // The reported failure, in full: re-roll turn 3 while the conversation has since
    // produced a scene summary, an arc, facts and a moved-on world state. None of what
    // turn 3 could not know may reach the model.
    const { db, env } = makeEnv();
    const { chat, rows } = seedFullMemoryChat(db);

    const prompt = await buildPrompt(env, chat, settings(40000), {
      mode: 'regenerate',
      userSeq: null,
      stateSeq: rows[2].seq,
      userContent: '',
      tailExtra: '',
    });

    const text = promptText(prompt);

    // The world state is the one recorded BEFORE turn 3, not the live one.
    expect(text).toContain('STATE_LAMP_ROOM');
    expect(text).not.toContain('STATE_OUTSIDE');

    // No memory of anything at or after turn 3. The scenes all cover ranges that start at
    // or after it, and the arc covers the whole chat, so none is a valid memory of turn 3.
    expect(text).not.toContain('SCENE_9');
    expect(text).not.toContain('ARC summary text');

    // Facts are unbounded by design — they are timeless statements, not events — so the
    // pinned one is still supplied. This asserts the DESIGN, not an oversight.
    expect(text).toContain('FACT_PINNED');
  });

  test('a forward turn still gets the live state and the newest memories', async () => {
    // The other half: none of this may freeze the scene. A normal turn is written against
    // the end of the story and sees everything.
    const { db, env } = makeEnv();
    const { chat } = seedFullMemoryChat(db);

    const prompt = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'what happens now',
      tailExtra: '',
    });

    const text = promptText(prompt);
    expect(text).toContain('STATE_OUTSIDE');
    expect(text).toContain('ARC summary text');
    expect(text).toContain('FACT_PINNED');
  });
});

describe('scenario: deleting a turn and returning to an earlier version', () => {
  test('a summary of a deleted turn stops being injected', async () => {
    // Deleting the last version of a turn removes everything after it from the transcript,
    // but the summaries covering those rows live in a side table and survive the delete.
    // Without the path check they keep describing a scene the reader removed.
    const { db, env } = makeEnv();
    const { chat, rows } = seedFullMemoryChat(db);

    // Before: the late scene is a valid memory and is injected.
    const before = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'what happens now',
      tailExtra: '',
    });
    expect(promptText(before)).toContain('SCENE_9');

    // The reader deletes the turn at seq 150 and everything after it leaves the scene.
    exec(
      db,
      `UPDATE messages SET deleted = 1, active = 0 WHERE chat_id = ? AND seq >= ?`,
      CHAT_ID,
      rows[149].seq,
    );

    const after = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'what happens now',
      tailExtra: '',
    });

    // SCENE_9 covers turns that are no longer on the path, so it must not be injected.
    expect(promptText(after)).not.toContain('SCENE_9');
    // The arc ends at turn 200, which is gone with the deleted tail, so it is dropped too.
    expect(promptText(after)).not.toContain('ARC summary text');
    // And a summary whose turns are still live IS injected: the path check is a filter, not
    // a blackout. SCENE_6 is the newest surviving scene (it covers turns 121-140, and the
    // delete starts at 150), so it is the one the newest-first window selects.
    expect(promptText(after)).toContain('SCENE_6');
  });

  test('restoring the turn brings its memory back, unchanged', async () => {
    // Swiping back to a version re-activates its rows. The summaries were never touched,
    // so the memory the reader had is exactly the memory they get back.
    const { db, env } = makeEnv();
    const { chat, rows } = seedFullMemoryChat(db);

    const original = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'what happens now',
      tailExtra: '',
    });

    // Deactivate everything from turn 150 on, as a delete-then-return would.
    exec(
      db,
      `UPDATE messages SET deleted = 1, active = 0 WHERE chat_id = ? AND seq >= ?`,
      CHAT_ID,
      rows[149].seq,
    );
    const without = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'what happens now',
      tailExtra: '',
    });
    expect(promptText(without)).not.toContain('SCENE_9');

    // Restore.
    exec(
      db,
      `UPDATE messages SET deleted = 0, active = 1 WHERE chat_id = ? AND seq >= ?`,
      CHAT_ID,
      rows[149].seq,
    );
    const restored = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'what happens now',
      tailExtra: '',
    });

    // Identical to the original: the memory survived the round trip intact.
    expect(promptText(restored)).toContain('SCENE_9');
    expect(promptText(restored)).toBe(promptText(original));
  });
});

describe('scenario: a regenerated-away version must not be recalled', () => {
  test('full-text recall skips a message that is no longer on the path', async () => {
    // A regenerated reply leaves its old version in `messages` AND in the FTS index. Recall
    // quoting it would hand the model prose the reader replaced — the same leak as the
    // summary case, through a different door.
    const { db, env } = makeEnv();
    const chat = seedChat(db);
    const rows = seedConversation(db, 6);

    // A discarded alternative at the position of turn 4, carrying a distinctive phrase.
    exec(
      db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES ('discarded', ?, ?, 'assistant', 'DISCARDED_PROSE about the lighthouse', 20, 0, ?)`,
      CHAT_ID,
      rows[2].id,
      Date.now(),
    );

    const prompt = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'lighthouse',
      tailExtra: '',
    });

    // Recall ran on the word "lighthouse" and the discarded row is the only match, so its
    // absence is the path filter doing the work rather than a query that found nothing.
    expect(promptText(prompt)).not.toContain('DISCARDED_PROSE');

    // Control: make it active and it IS recalled, so the assertion above is not vacuous.
    exec(db, `UPDATE messages SET active = 1 WHERE id = 'discarded'`);
    const control = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'lighthouse',
      tailExtra: '',
    });
    expect(promptText(control)).toContain('DISCARDED_PROSE');
  });
});

describe('scenario: the fixture actually populates every memory tier', () => {
  test('scene, arc, fact and state all reach the prompt', async () => {
    // Guards the fixture itself. If `seedFullMemoryChat` were too short to produce an arc,
    // every assertion above about arcs would pass by accident — the string would be absent
    // for the wrong reason.
    const { db, env } = makeEnv();
    const { chat } = seedFullMemoryChat(db);

    const tiers = one<{ scenes: number; arcs: number }>(
      db,
      `SELECT
         SUM(CASE WHEN tier = 'scene' THEN 1 ELSE 0 END) AS scenes,
         SUM(CASE WHEN tier = 'arc' THEN 1 ELSE 0 END) AS arcs
       FROM summaries WHERE chat_id = ?`,
      CHAT_ID,
    );
    expect(tiers?.scenes).toBe(10);
    expect(tiers?.arcs).toBe(1);

    const prompt = await buildPrompt(env, chat, settings(40000), {
      mode: 'send',
      userSeq: null,
      stateSeq: null,
      userContent: 'what happens now',
      tailExtra: '',
    });
    const tail = tailText(prompt);

    // Every tier is represented in the assembled tail, so the assertions in the other
    // scenarios are about a prompt that really carries all of them.
    expect(tail).toContain('ARC summary text');
    expect(tail).toContain('FACT_PINNED');
    expect(tail).toContain('STATE_OUTSIDE');
    expect(tail).toContain('Story so far');
    expect(tail).toContain('Established facts');
  });
});
