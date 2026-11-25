import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { exec, makeTestEnv } from '../test/harness';
import { encryptKey } from '../../../src/lib/crypto';
import { repairReply } from './repair';
import { DEFAULT_CRAFT, DEFAULT_SCENE_SETUP } from '../../../src/lib/scene/setup';

/**
 * The repair pass, end to end against the real migrations and a stubbed provider.
 *
 * The two contracts that matter: a good repair is added as an INACTIVE version for auto
 * mode, and a repair that paraphrases the dialogue is rejected rather than written. The
 * second is the one that protects what the reader already liked.
 */

const TOKEN = 'test-token';

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

async function configured(): Promise<{ env: Env; db: Database }> {
  const { env, db } = makeTestEnv({ extra: { TESSERA_TOKEN: TOKEN } });
  const now = Date.now();
  for (const [key, value] of [
    ['provider', 'kenari'],
    ['model', 'glm-5.3-flash'],
    ['cheapProvider', 'kenari'],
    ['cheapModel', 'glm-5.3-flash'],
  ]) {
    exec(
      db,
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
      key,
      value,
      now,
    );
  }
  const { enc, iv } = await encryptKey('sk-test', TOKEN);
  exec(
    db,
    'INSERT INTO provider_keys (provider, key_enc, iv, updated_at) VALUES (?, ?, ?, ?)',
    'kenari',
    new Uint8Array(enc),
    new Uint8Array(iv),
    now,
  );
  return { env, db };
}

/** Runs `body` with `fetch` replaced by one buffered answer, returning what was sent. */
async function withReply<T>(
  content: string,
  body: (sent: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

describe('repairReply', () => {
  test('adds the corrected narration as an inactive version and leaves the dialogue alone', async () => {
    const { env, db } = await configured();
    const chatId = seedChat(db);
    exec(
      db,
      'INSERT INTO chat_scene_setup (chat_id, json, updated_at) VALUES (?, ?, ?)',
      chatId,
      JSON.stringify({
        ...DEFAULT_SCENE_SETUP,
        proseGuard: 'button',
        craft: { ...DEFAULT_CRAFT, responseLength: 'short' },
      }),
      Date.now(),
    );
    const messageId = seedMessage(db, chatId, 'm1', 'Her jaw works. "You asked." She waits.');

    await withReply('She looks at the door. "You asked." The room is quiet.', async (sent) => {
      const result = await repairReply(env, chatId, messageId, { activate: false });
      expect(result.violations.some((violation) => violation.kind === 'banned')).toBe(true);
      expect(result.id).toBeString();

      const body = sent[0] as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0].content).toContain('Rewrite ONLY the narration');
      expect(body.messages[1].content).toContain('Her jaw works. "You asked."');
    });

    const rows = db
      .query(
        `SELECT content, source, active FROM messages
          WHERE chat_id = ? AND id != ? ORDER BY created_at`,
      )
      .all(chatId, messageId) as Array<{ content: string; source: string | null; active: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('She looks at the door. "You asked." The room is quiet.');
    expect(rows[0].source).toBe('prose');
    expect(rows[0].active).toBe(0);
  });

  test('accepts a short reply repaired into a paragraph', async () => {
    const { env, db } = await configured();
    const chatId = seedChat(db);
    exec(
      db,
      'INSERT INTO chat_scene_setup (chat_id, json, updated_at) VALUES (?, ?, ?)',
      chatId,
      JSON.stringify({ ...DEFAULT_SCENE_SETUP, proseGuard: 'button' }),
      Date.now(),
    );
    const messageId = seedMessage(db, chatId, 'm4', 'Her jaw works. "Okay."');
    // 34 chars in, ~400 out: over the ratio, under the floor. The correction is longer
    // because the input was a fragment; that is not the expansion the ratio is for.
    const repaired = 'She looks at the door. ' + 'The room stays quiet. '.repeat(16) + '"Okay."';

    await withReply(repaired, async () => {
      const result = await repairReply(env, chatId, messageId, { activate: false });
      expect(result.id).toBeString();
    });
  });

  test('rejects a repair that paraphrases the dialogue', async () => {
    const { env, db } = await configured();
    const chatId = seedChat(db);
    exec(
      db,
      'INSERT INTO chat_scene_setup (chat_id, json, updated_at) VALUES (?, ?, ?)',
      chatId,
      JSON.stringify({ ...DEFAULT_SCENE_SETUP, proseGuard: 'button' }),
      Date.now(),
    );
    const messageId = seedMessage(db, chatId, 'm2', 'Her jaw works. "You asked."');

    await withReply('She looks away. "You wanted this."', async () => {
      await expect(
        repairReply(env, chatId, messageId, { activate: false }),
      ).rejects.toThrow('dialogue');
    });

    const count = db
      .query('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
      .get(chatId) as { n: number };
    expect(count.n).toBe(1);
  });

  test('does nothing when the reply has no violations', async () => {
    const { env, db } = await configured();
    const chatId = seedChat(db);
    exec(
      db,
      'INSERT INTO chat_scene_setup (chat_id, json, updated_at) VALUES (?, ?, ?)',
      chatId,
      JSON.stringify({ ...DEFAULT_SCENE_SETUP, proseGuard: 'button' }),
      Date.now(),
    );
    const messageId = seedMessage(db, chatId, 'm3', 'She sets the mug down. "You asked."');

    const result = await repairReply(env, chatId, messageId, { activate: false });
    expect(result.violations).toEqual([]);
    expect(result.id).toBeUndefined();
  });
});
