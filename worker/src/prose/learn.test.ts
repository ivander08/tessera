import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { exec, makeTestEnv } from '../test/harness';
import { editMessage } from '../messages';
import { loadSceneSetup } from '../scene';
import { learnProseBans } from './learn';
import { DEFAULT_SCENE_SETUP } from '../../../src/lib/scene/setup';

/**
 * The learning loop, against the real migrations.
 *
 * The two properties worth pinning: a hand edit teaches the guard only when the guard is
 * on, and the learned phrase is stored where the panel and the repair prompt read it —
 * not in some side table the detector never consults.
 */

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

function seedMessage(db: Database, chatId: string, id: string, content: string): string {
  exec(
    db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
     VALUES (?, ?, NULL, 'assistant', ?, 1, 1, ?)`,
    id,
    chatId,
    content,
    Date.now(),
  );
  return id;
}

function seedGuard(db: Database, chatId: string, guard: 'off' | 'button' | 'auto'): void {
  exec(
    db,
    'INSERT INTO chat_scene_setup (chat_id, json, updated_at) VALUES (?, ?, ?)',
    chatId,
    JSON.stringify({ ...DEFAULT_SCENE_SETUP, proseGuard: guard }),
    Date.now(),
  );
}

describe('learnProseBans', () => {
  test('learns a repeated phrase the edit removed', async () => {
    const { env, db } = makeTestEnv();
    const chatId = seedChat(db);
    seedGuard(db, chatId, 'button');

    const learned = await learnProseBans(
      env,
      chatId,
      'Her hips slam down on the mattress. Later, her hips slam down again.',
      'Her hips find the mattress. Later, she slows.',
    );

    expect(learned).toContain('her hips slam down');
    expect((await loadSceneSetup(env, chatId)).proseBans).toContain('her hips slam down');
  });

  test('does not learn while the guard is off', async () => {
    const { env, db } = makeTestEnv();
    const chatId = seedChat(db);
    seedGuard(db, chatId, 'off');

    expect(
      await learnProseBans(env, chatId, 'Her jaw works. "Okay."', 'She looks away. "Okay."'),
    ).toEqual([]);
    expect((await loadSceneSetup(env, chatId)).proseBans).toEqual([]);
  });
});

describe('editMessage learning hook', () => {
  test('a hand edit updates the row and the chat bans together', async () => {
    const { env, db } = makeTestEnv();
    const chatId = seedChat(db);
    seedGuard(db, chatId, 'button');
    const messageId = seedMessage(db, chatId, 'm1', 'Her jaw works. "Okay."');

    const req = new Request('http://tessera.test/api/message/edit', {
      method: 'POST',
      body: JSON.stringify({
        chatId,
        id: messageId,
        content: 'She looks at the door. "Okay."',
      }),
    });
    const res = await editMessage(env, req);
    expect(res.status).toBe(200);

    const row = db
      .query('SELECT content FROM messages WHERE id = ?')
      .get(messageId) as { content: string };
    expect(row.content).toBe('She looks at the door. "Okay."');
    expect((await loadSceneSetup(env, chatId)).proseBans).toContain('jaw works');
  });
});
