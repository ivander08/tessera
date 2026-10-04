import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';

import { clearState, getState, patchState } from './api';

/**
 * The world-state viewer's two writes and one read, against a real (in-memory) database.
 *
 * The bug these defend: a hand edit from the panel changed the live document and nothing
 * on the visible path, so the transcript's scene line never moved and the next turn's
 * `loadStateForTurn` — which walks the path, never the live row — computed from a document
 * the reader had just corrected. And the panel itself read the live row, which after a
 * swipe describes a version that is no longer on screen.
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

function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

function makeEnv(): { env: Env; db: Database } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
  }

  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES ('chat-1', NULL, NULL, 't', NULL, 0, 's', 0, 0)`,
  );

  const DB = {
    prepare(sql: string) {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
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
          if (trimmed.includes('FROM chat_scene_setup')) return null;
          return db.query(sql).get(...(params as never[])) ?? null;
        },
        async run() {
          const result = db.run(sql, ...(params as never[]));
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };

  return { env: { DB, APP_NAME: 'Tessera', TESSERA_TOKEN: 'token' } as unknown as Env, db };
}

function row(db: Database, id: string, parentId: string | null, role: string, state: unknown, active = 1): void {
  exec(
    db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, active, deleted, state_json, created_at)
     VALUES (?, 'chat-1', ?, ?, 'x', ?, 0, ?, 0)`,
    id,
    parentId,
    role,
    active,
    state === null ? null : JSON.stringify(state),
  );
}

function liveState(db: Database, json: unknown): void {
  exec(
    db,
    `INSERT INTO state (chat_id, json, updated_at) VALUES ('chat-1', ?, 0)
     ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json`,
    JSON.stringify(json),
  );
}

function patchRequest(patch: unknown): Request {
  return new Request('http://tessera.test/api/state/chat-1', {
    method: 'PATCH',
    body: JSON.stringify({ chatId: 'chat-1', patch }),
  });
}

afterEach(() => {
  // Nothing global to restore; the harness is per-test.
});

describe('patchState targets the visible path', () => {
  test('the snapshot lands on the tail of the path, not on a higher-seq off-path row', async () => {
    // A swipe-away leaves the abandoned branch's subtree marked active. `ORDER BY seq DESC`
    // among active rows then picks a row the transcript never visits, so the correction
    // landed off-screen and the next turn (which walks the path) never saw it.
    const { env, db } = makeEnv();
    row(db, 'root', null, 'assistant', null);
    row(db, 'v1', 'root', 'assistant', null, 0); // swiped-away version of the first reply
    row(db, 'a1', 'root', 'assistant', { time: 'Friday, April 11, 2025, 22:38' });
    // Its child, still marked active and inserted LATER — so `ORDER BY seq DESC` among
    // active rows picks it over the real tail.
    row(db, 'v1c', 'v1', 'assistant', null);

    await patchState(env, patchRequest({ time: 'Friday, April 11, 2025, 23:38' }));

    const onPath = db.query('SELECT state_json FROM messages WHERE id = ?').get('a1') as { state_json: string };
    expect(JSON.parse(onPath.state_json).time).toBe('Friday, April 11, 2025, 23:38');
    const offPath = db.query('SELECT state_json FROM messages WHERE id = ?').get('v1c') as { state_json: string | null };
    expect(offPath.state_json).toBeNull();
  });

  test('a chat whose tail is a reader row still corrects the newest scene line', async () => {
    // After the reader sends, the tail is their own row. The scene line lives on the last
    // assistant row, so the correction is written there — the state the next turn reads
    // (tail-inclusive) is the same document either way.
    const { env, db } = makeEnv();
    row(db, 'root', null, 'assistant', { time: 'Friday, April 11, 2025, 22:38' });
    row(db, 'u1', 'root', 'user', null);
    row(db, 'a1', 'u1', 'assistant', { time: 'Friday, April 11, 2025, 22:39' });
    row(db, 'u2', 'a1', 'user', null);

    await patchState(env, patchRequest({ time: 'Friday, April 11, 2025, 23:38' }));

    const onPath = db.query('SELECT state_json FROM messages WHERE id = ?').get('a1') as { state_json: string };
    expect(JSON.parse(onPath.state_json).time).toBe('Friday, April 11, 2025, 23:38');
  });

  test('the patch merges over the path state, not over a stale live row', async () => {
    // The live row is overwritten every turn and is NOT what the next turn reads. Merging a
    // hand edit over it resurrected values from a branch that had left the screen.
    const { env, db } = makeEnv();
    row(db, 'root', null, 'assistant', { time: 'Friday, April 11, 2025, 22:38', location: 'the dorm' });
    liveState(db, { time: 'Thursday, April 10, 2025, 19:00', location: 'the gym' });

    await patchState(env, patchRequest({ weather: 'cool night' }));

    const onPath = db.query('SELECT state_json FROM messages WHERE id = ?').get('root') as { state_json: string };
    const stored = JSON.parse(onPath.state_json) as Record<string, unknown>;
    expect(stored.time).toBe('Friday, April 11, 2025, 22:38');
    expect(stored.location).toBe('the dorm');
    expect(stored.weather).toBe('cool night');
  });
});

describe('getState reads what the next turn will read', () => {
  test('returns the state as of the visible path tail', async () => {
    const { env, db } = makeEnv();
    row(db, 'root', null, 'assistant', { time: 'Friday, April 11, 2025, 22:38' });
    row(db, 'u1', 'root', 'user', null);
    liveState(db, { time: 'Thursday, April 10, 2025, 19:00' });

    const payload = (await (await getState(env, 'chat-1')).json()) as { state: { time?: string } };
    expect(payload.state.time).toBe('Friday, April 11, 2025, 22:38');
  });

  test('falls back to the live document when the path records no snapshot', async () => {
    // A chat whose rows predate snapshots (or whose newest snapshot was deleted) has no path
    // state to show; the live row is the only document that exists, so it is shown rather
    // than an empty panel over a real one.
    const { env, db } = makeEnv();
    row(db, 'root', null, 'assistant', null);
    liveState(db, { time: 'Friday, April 11, 2025, 22:38' });

    const payload = (await (await getState(env, 'chat-1')).json()) as { state: { time?: string } };
    expect(payload.state.time).toBe('Friday, April 11, 2025, 22:38');
  });
});

describe('clearState', () => {
  test('clears the path snapshot too, so the scene line goes with it', async () => {
    const { env, db } = makeEnv();
    row(db, 'root', null, 'assistant', { time: 'Friday, April 11, 2025, 22:38' });
    liveState(db, { time: 'Friday, April 11, 2025, 22:38' });

    await clearState(env, 'chat-1');

    const onPath = db.query('SELECT state_json FROM messages WHERE id = ?').get('root') as { state_json: string | null };
    expect(onPath.state_json).toBeNull();
  });
});
