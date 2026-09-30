import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import {
  addCastMember,
  castNames,
  loadCast,
  promoteCastMember,
  recordSpeakers,
  removeCastMember,
} from './cast';
import { VOICE_SLOTS } from '../../src/lib/theme';

/**
 * The cast, against the real migrations.
 *
 * Two properties carry the design. A chat with no rows still HAS a cast — its own
 * character — and reading must not create one, or "has the reader configured this?" stops
 * being answerable and a `GET` becomes a mutation. And adding a name must be
 * case-insensitive and idempotent, because the narrator writes `olivia` and `Olivia` and
 * they are the same person.
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
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      const out = [];
      for (const statement of statements) out.push(await statement.all());
      return out;
    },
  };

  return { env: { DB, APP_NAME: 'Tessera' } as unknown as Env, db };
}

/** `bun-types` types the variadic form too narrowly; one seam keeps the cast out of call sites. */
function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

function one<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  return (db.query(sql).get(...(params as never[])) as T | undefined) ?? null;
}

/**
 * A chat whose character has a CCv3 nickname, so the shown name and the card title differ
 * and the test can prove which one the cast uses.
 */
function seedChat(db: Database, id = 'chat-1', nickname: string | null = 'Quill'): string {
  const now = Date.now();
  exec(
    db,
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES (?, ?, NULL, ?, 'ccv3', 10, ?)`,
    `char-${id}`,
    'Quill 25/09/2026',
    JSON.stringify({ name: 'Quill 25/09/2026', ...(nickname ? { nickname } : {}) }),
    now,
  );
  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES (?, ?, NULL, 't', NULL, 0, ?, ?, ?)`,
    id,
    `char-${id}`,
    `session-${id}`,
    now,
    now,
  );
  return id;
}

const count = (db: Database): number =>
  one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM chat_cast')?.n ?? 0;

describe('loadCast', () => {
  test('a chat with no rows still has a cast: its own character', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const cast = await loadCast(env, chatId);
    expect(cast).toHaveLength(1);
    expect(cast[0].is_primary).toBe(1);
    expect(cast[0].character_id).toBe('char-chat-1');
    // The SHOWN name — the nickname — not the card's dated title.
    expect(cast[0].name).toBe('Quill');
  });

  test('reading writes nothing', async () => {
    // A GET that created a row would make every read a mutation, and would make it
    // impossible to tell "the reader configured a cast" from "someone read this chat".
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    await loadCast(env, chatId);
    await castNames(env, chatId);
    await loadCast(env, chatId);

    expect(count(db)).toBe(0);
  });

  test('a chat with no character has an empty cast rather than throwing', async () => {
    const { env, db } = makeEnv();
    const now = Date.now();
    exec(
      db,
      `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                          session_id, created_at, updated_at)
       VALUES ('bare', NULL, NULL, 't', NULL, 0, 's', ?, ?)`,
      now,
      now,
    );
    expect(await loadCast(env, 'bare')).toEqual([]);
  });

  test('the primary is first, then the rest by creation', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await addCastMember(env, chatId, 'Olivia');
    await addCastMember(env, chatId, 'Ada');

    expect((await loadCast(env, chatId)).map((row) => row.name)).toEqual(['Quill', 'Olivia', 'Ada']);
  });

  test('the primary stays in the cast once other members exist', async () => {
    // The bug this pins: returning only the stored rows dropped the chat's character from
    // the cast the moment anyone else spoke, which re-added them as a SUPPORTING member on
    // the next reply and took them out of the prompt's cast block.
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await addCastMember(env, chatId, 'Olivia');

    const cast = await loadCast(env, chatId);
    expect(cast[0].is_primary).toBe(1);
    expect(cast[0].name).toBe('Quill');
    expect(cast.filter((row) => row.name === 'Quill')).toHaveLength(1);
  });
});

describe('addCastMember', () => {
  test('adds a name and returns it', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const row = await addCastMember(env, chatId, 'Olivia');
    expect(row.name).toBe('Olivia');
    expect(row.character_id).toBeNull();
    expect(row.is_primary).toBe(0);
    expect(count(db)).toBe(1);
  });

  test('matching is case-insensitive on the trimmed name', async () => {
    // The narrator writes `olivia` and `Olivia` and they are the same person. A cast with
    // both would render as two speakers with two colours.
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const first = await addCastMember(env, chatId, 'olivia');
    const second = await addCastMember(env, chatId, '  Olivia  ');
    expect(second.id).toBe(first.id);
    expect(count(db)).toBe(1);
  });

  test('a name already in the cast is not added again', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await addCastMember(env, chatId, 'Olivia');
    await addCastMember(env, chatId, 'Olivia');
    expect(count(db)).toBe(1);
  });

  test('colours are distinct for the first palette slots', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const colours = new Set<string>();
    for (let index = 0; index < VOICE_SLOTS; index += 1) {
      const row = await addCastMember(env, chatId, `Speaker${index}`);
      expect(row.color).not.toBeNull();
      colours.add(row.color!);
    }
    // Every slot used exactly once, so no two speakers share a colour while slots remain.
    expect(colours.size).toBe(VOICE_SLOTS);
  });

  test('colours wrap once the palette is exhausted, and are still distinct within a wrap', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const colours: string[] = [];
    for (let index = 0; index < VOICE_SLOTS + 2; index += 1) {
      colours.push((await addCastMember(env, chatId, `Speaker${index}`)).color!);
    }

    // The first palette's worth are all different.
    expect(new Set(colours.slice(0, VOICE_SLOTS)).size).toBe(VOICE_SLOTS);
    // Past that the slots repeat, which is the documented behaviour rather than a bug:
    // seven distinct speakers is a crowd, not a scene.
    for (const colour of colours.slice(VOICE_SLOTS)) {
      expect(colours.slice(0, VOICE_SLOTS)).toContain(colour);
    }
  });

  test('a new speaker takes the slot the primary never claimed', async () => {
    // The primary has no stored colour, so the first added member must not be handed a
    // slot that is already visibly in use.
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const row = await addCastMember(env, chatId, 'Olivia');
    expect(row.color).toBe('--voice-2');
  });
});

describe('promoteCastMember', () => {
  test('attaches the card and renames to the shown name', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const member = await addCastMember(env, chatId, 'olivia');

    // A second character to promote to, with its own nickname.
    const now = Date.now();
    exec(
      db,
      `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
       VALUES ('other', 'Olivia 01/01/2026', NULL, ?, 'ccv3', 10, ?)`,
      JSON.stringify({ name: 'Olivia 01/01/2026', nickname: 'Olivia' }),
      now,
    );

    const promoted = await promoteCastMember(env, chatId, member.id, 'other');
    expect(promoted?.character_id).toBe('other');
    expect(promoted?.name).toBe('Olivia');
    expect(promoted?.id).toBe(member.id);
  });

  test('an unknown member or character returns null rather than throwing', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const member = await addCastMember(env, chatId, 'olivia');

    expect(await promoteCastMember(env, chatId, 'nope', 'other')).toBeNull();
    expect(await promoteCastMember(env, chatId, member.id, 'nope')).toBeNull();
  });
});

describe('removeCastMember', () => {
  test('removes an introduced member', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const member = await addCastMember(env, chatId, 'Olivia');

    await removeCastMember(env, chatId, member.id);
    expect(count(db)).toBe(0);
  });

  test('refuses to remove the primary, so a scene always has a narrator', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    // A stored primary row, which is what a promoted chat has.
    exec(
      db,
      `INSERT INTO chat_cast (chat_id, id, character_id, name, color, is_primary, created_at)
       VALUES (?, 'primary', 'char-chat-1', 'Quill', '--voice-1', 1, ?)`,
      chatId,
      Date.now(),
    );

    await removeCastMember(env, chatId, 'primary');
    expect(count(db)).toBe(1);
  });
});

describe('recordSpeakers', () => {
  test('adds the names a reply introduced', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const added = await recordSpeakers(
      env,
      chatId,
      'Quill: *looks up*\n\nOlivia: "You\'re late."',
    );
    // Quill is the primary and already known; Olivia is new.
    expect(added).toEqual(['Olivia']);
    expect((await castNames(env, chatId)).sort()).toEqual(['Olivia', 'Quill']);
  });

  test('does not add the reader, even when the narrator writes their line', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    exec(
      db,
      `INSERT INTO personas (id, name, description, avatar, created_at)
       VALUES ('p1', 'Ivander', NULL, NULL, ?)`,
      Date.now(),
    );
    exec(db, 'UPDATE chats SET persona_id = ? WHERE id = ?', 'p1', chatId);

    const added = await recordSpeakers(env, chatId, 'Quill: hi\nIvander: hello\nAda: "hm"');
    expect(added).toEqual(['Ada']);
  });

  test('a second call adds nothing, so a name is recorded once', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const reply = 'Quill: one\n\nOlivia: two';

    await recordSpeakers(env, chatId, reply);
    expect(await recordSpeakers(env, chatId, reply)).toEqual([]);
    expect(count(db)).toBe(1);
  });

  test('prose with no script lines adds nothing', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    expect(await recordSpeakers(env, chatId, 'Quill looks up. You are late.')).toEqual([]);
    expect(count(db)).toBe(0);
  });

  test('a chat with no character records nothing', async () => {
    const { env, db } = makeEnv();
    const now = Date.now();
    exec(
      db,
      `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                          session_id, created_at, updated_at)
       VALUES ('bare', NULL, NULL, 't', NULL, 0, 's', ?, ?)`,
      now,
      now,
    );
    expect(await recordSpeakers(env, 'bare', 'Olivia: hello')).toEqual([]);
  });
});
