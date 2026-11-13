import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { exec, makeTestEnv } from './test/harness';
import { deletePreset } from './presets';

/**
 * Preset lifecycle, at the level where a pointer can be left dangling.
 *
 * Deleting a preset is the one preset operation with consequences outside the presets
 * table: two other rows name a preset, and neither is a foreign key, so nothing in the
 * database stops them pointing at a row that no longer exists.
 */

function makeEnv(): { env: Env; db: Database } {
  const { env, db } = makeTestEnv();
  return { env, db };
}

function seedPreset(db: Database, id: string): void {
  exec(
    db,
    `INSERT INTO presets (id, name, knobs_json, config_json, created_at, updated_at)
     VALUES (?, ?, '{}', NULL, 0, 0)`,
    id,
    id,
  );
}


describe('deletePreset clears the pointers at it', () => {
  // A bare DELETE leaves dangling references that fail silently in two different ways: a
  // chat falls back to the DEFAULT preset rather than to what it had, and a
  // `default_preset_id` pointing at nothing reads as "no default", so an install that had
  // one quietly loses it. Measured on prod: the default preset id answered 404 and nothing
  // said so.
  test('a deleted default preset is unset, and chats pointing at it are cleared', async () => {
    const { env, db } = makeEnv();
    seedPreset(db, 'p1');
    exec(db, "INSERT INTO settings (key, value, updated_at) VALUES ('default_preset_id', 'p1', 0)");
    exec(
      db,
      `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                          session_id, created_at, updated_at)
       VALUES ('chat-1', NULL, NULL, 't', 'p1', 0, 's', 0, 0)`,
    );

    await deletePreset(env, 'p1');

    const chat = db.query("SELECT preset_id FROM chats WHERE id = 'chat-1'").get() as {
      preset_id: string | null;
    };
    expect(chat.preset_id).toBeNull();

    const row = db
      .query("SELECT value FROM settings WHERE key = 'default_preset_id'")
      .get() as { value: string };
    expect(row.value).toBe('');
  });

  test('deleting a preset nothing points at changes no other row', async () => {
    const { env, db } = makeEnv();
    seedPreset(db, 'p1');
    seedPreset(db, 'p2');
    exec(db, "INSERT INTO settings (key, value, updated_at) VALUES ('default_preset_id', 'p2', 0)");

    await deletePreset(env, 'p1');

    const row = db
      .query("SELECT value FROM settings WHERE key = 'default_preset_id'")
      .get() as { value: string };
    expect(row.value).toBe('p2');
  });
});
