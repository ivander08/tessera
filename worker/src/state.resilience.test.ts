import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { loadStateAt, loadStateForTurn } from './state/update';
import { statePointFor } from './turn';
import { makeTestEnv } from './test/harness';

/**
 * Bonds/threads survive a regen or a delete the same way every other state field does.
 *
 * The claim under test is the one `loadStateAt` documents: state is read from the most
 * recent snapshot ON THE VISIBLE PATH, not from the live document. So a regenerate that
 * rewinds to turn N reads turn N's ancestor snapshot — a superseded branch's newer bonds
 * and threads are invisible, and the world state cannot advance past where the reader is
 * actually looking.
 *
 * This is what makes the relationship and plot-thread meters safe to trust: delete a
 * message and the meters move back with it; regenerate over a turn that raised a thread
 * and the thread is not raised until the new reply raises it again. The state-update tests
 * in `update.test.ts` already pin the clock under these modes; this file pins the two
 * state-tracking sections the meters read.
 */
const CHAT_ID = 'chat-state-resilience';

function makeEnv(): { env: Env; db: Database } {
  const { env, db } = makeTestEnv();
  db.exec(
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
       session_id, last_prefix_hash, last_prefix_head, created_at, updated_at)
     VALUES ('${CHAT_ID}', NULL, NULL, 't', NULL, 0, 's', NULL, NULL, 0, 0)`,
  );
  return { env, db };
}

function insert(
  db: Database,
  id: string,
  parent: string | null,
  state: unknown | null,
): { id: string; seq: number } {
  db.run(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, deleted, state_json, created_at)
     VALUES (?, ?, ?, 'assistant', 'x', 20, 1, 0, ?, 0)`,
    [id, CHAT_ID, parent, state === null ? null : JSON.stringify(state)],
  );
  const seq = (db.query('SELECT seq FROM messages WHERE id = ?').get(id) as { seq: number }).seq;
  return { id, seq };
}
/** A state document with the given threads and bonds, shaped as the schema wants. */
function stateWith(
  threads: string[],
  bonds: Array<[string, string, number]> = [],
): unknown {
  const bondMap: Record<string, { bond: number }> = {};
  for (const [a, b, value] of bonds) {
    bondMap[[a, b].sort().join('|')] = { bond: value };
  }
  return {
    time: 'Friday, April 11, 2025, 22:00',
    location: 'the scriptorium',
    weather: 'cold',
    present: ['Ada'],
    threads: threads.map((text) => ({ text, status: 'open' })),
    ...(Object.keys(bondMap).length > 0 ? { bonds: bondMap } : {}),
  };
}

describe('bond and thread state under regen and delete', () => {
  test('a regenerate reads the ancestry snapshot, not the reply being rewritten', async () => {
    const { env, db } = makeEnv();
    const a1 = insert(db, 'a1', null, stateWith(['thread-one']));
    const u1 = insert(db, 'u1', a1.id, null);
    // This turn's snapshot RAISED a bond and a second thread. Bond values clamp to ±20
    // (schema.ts:314), so stay inside that range.
    const a2 = insert(
      db,
      'a2',
      u1.id,
      stateWith(['thread-one', 'thread-two'], [['Ada', 'Marlow', 15]]),
    );

    // A regenerate of a2 must read the state as of BEFORE a2: no bond yet, one thread.
    const point = statePointFor('regenerate', a2, null, false);
    expect(point.inclusive).toBe(false);
    const state = await loadStateForTurn(env, CHAT_ID, point);
    expect(state.threads?.map((thread) => thread.text)).toEqual(['thread-one']);
    expect(state.bonds ?? {}).toEqual({});

    // A send after a2 (the normal case) reads a2's own snapshot: both present. The tail
    // seq for a send is the seq of the last row on the path — a2's row.
    const sendState = await loadStateForTurn(env, CHAT_ID, statePointFor('send', null, a2.seq, false));
    expect(sendState.threads?.map((thread) => thread.text)).toEqual(['thread-one', 'thread-two']);
    expect(sendState.bonds).toEqual({ 'Ada|Marlow': { bond: 15 } });
  });

  test('a superseded swipe snapshot is invisible to a later turn', async () => {
    const { env, db } = makeEnv();
    const a1 = insert(db, 'a1', null, stateWith(['thread-one']));
    const u1 = insert(db, 'u1', a1.id, null);

    // Swipe A raised a dead thread; the reader regenerated, which makes B the path.
    const a2 = insert(db, 'a2', u1.id, stateWith(['thread-one', 'thread-dead']));
    db.run('UPDATE messages SET active = 0 WHERE id = ?', [a2.id]);
    const a3 = insert(db, 'a3', u1.id, stateWith(['thread-one', 'thread-live']));

    // The path now runs a1 -> u1 -> a3. The newest path snapshot is a3's, and the
    // abandoned branch's thread is nowhere in it. `beforeSeq = null` would read the live
    // document (empty here), so read the path tail the way the viewer does.
    const tail = (db.query(
      "SELECT seq FROM messages WHERE id = 'a3'",
    ).get() as { seq: number }).seq;
    const state = await loadStateAt(env, CHAT_ID, tail + 1);
    expect(state.threads?.map((thread) => thread.text)).toEqual(['thread-one', 'thread-live']);

    // A regenerate of a3 reads the ancestor snapshot (a1): neither swipe's threads.
    const state2 = await loadStateForTurn(env, CHAT_ID, statePointFor('regenerate', a3, null, false));
    expect(state2.threads?.map((thread) => thread.text)).toEqual(['thread-one']);
  });

  test('a deleted leaf retracts the newest snapshot and falls back to the ancestor', async () => {
    const { env, db } = makeEnv();
    const a1 = insert(db, 'a1', null, stateWith(['thread-one'], [['Ada', 'Marlow', 20]]));
    const u1 = insert(db, 'u1', a1.id, null);
    const a2 = insert(
      db,
      'a2',
      u1.id,
      stateWith(['thread-one', 'thread-two'], [['Ada', 'Marlow', 60]]),
    );

    // The reader deletes a2's reply the way the UI does (soft delete).
    db.run('UPDATE messages SET deleted = 1 WHERE id = ?', [a2.id]);

    // The visible path ends at u1, so the newest visible snapshot is a1's: bond 20, one
    // thread. The 60-value bond and the second thread went away with the deleted turn.
    const state = await loadStateForTurn(env, CHAT_ID, { seq: a1.seq, inclusive: true });
    expect(state.threads?.map((thread) => thread.text)).toEqual(['thread-one']);
    expect(state.bonds).toEqual({ 'Ada|Marlow': { bond: 20 } });
  });
});
