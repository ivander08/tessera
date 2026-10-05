import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { searchChat } from './search';
import { exportChat } from './export';
import { exec, makeTestEnv } from './test/harness';

/**
 * Search and export, against the real migrations and the real FTS index.
 *
 * Both are read paths over data that already exists, so what is worth pinning is the
 * boundary rather than the happy case: an empty query must not reach SQL (FTS5 raises a
 * syntax error on `MATCH ''`, which would be a 500 for a search of punctuation), and an
 * export must walk the VISIBLE path rather than every active row.
 */

function makeEnv(): { env: Env; db: Database } {
  const { env, db } = makeTestEnv();
  return { env, db };
}

function seedChat(db: Database, id = 'chat-1'): string {
  const now = Date.now();
  exec(
    db,
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES (?, 'Quill 25/09/2026', NULL, ?, 'ccv3', 10, ?)`,
    `char-${id}`,
    JSON.stringify({ name: 'Quill 25/09/2026', nickname: 'Quill' }),
    now,
  );
  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'The lantern room', NULL, 0, ?, ?, ?)`,
    id,
    `char-${id}`,
    `session-${id}`,
    now,
    now,
  );
  return id;
}

function seed(
  db: Database,
  chatId: string,
  id: string,
  parent: string | null,
  content: string,
  active = 1,
  role: 'user' | 'assistant' = 'assistant',
): void {
  exec(
    db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    chatId,
    parent,
    role,
    content,
    active,
    Date.now(),
  );
}

const searchUrl = (q: string, limit?: number): URL =>
  new URL(`http://x/api/chats/chat-1/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`);

describe('searchChat', () => {
  test('finds a message and returns a snippet with the match marked', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'The brass key opens the lantern room at midnight.');
    seed(db, chatId, 'a2', 'a1', 'She set the ledger down and listened to the rain.');

    const payload = (await (await searchChat(env, chatId, searchUrl('brass key'))).json()) as {
      hits: Array<{ seq: number; id: string; snippet: string }>;
    };

    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].id).toBe('a1');
    // The `«`/`»` markers are what the SQL inserts, so their presence proves the snippet
    // came from the index rather than from a substring of the whole content.
    expect(payload.hits[0].snippet).toContain('«brass»');
    expect(payload.hits[0].snippet).toContain('«key»');
  });

  test('ranks the best match first', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'A long paragraph that mentions the key once among many other words and clauses.');
    seed(db, chatId, 'a2', 'a1', 'key key key');

    const payload = (await (await searchChat(env, chatId, searchUrl('key'))).json()) as {
      hits: Array<{ id: string }>;
    };
    expect(payload.hits[0].id).toBe('a2');
  });

  test('an empty query returns nothing rather than a 500', async () => {
    // `MATCH ''` is an fts5 syntax error, not an empty result. The guard is what makes
    // searching for punctuation safe.
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'text');

    for (const q of ['', '   ', '...', '!!!', '???', '--', '"']) {
      const res = await searchChat(env, chatId, searchUrl(q));
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { hits: unknown[] };
      expect(payload.hits).toEqual([]);
    }
  });

  test('a query with no match returns an empty list, not an error', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'nothing relevant here');

    const payload = (await (await searchChat(env, chatId, searchUrl('zeppelin'))).json()) as {
      hits: unknown[];
    };
    expect(payload.hits).toEqual([]);
  });

  test('results are scoped to one chat', async () => {
    // FTS5 stores only a rowid, so the join back to `messages` is what scopes this. A
    // missing chat filter would return every chat's matches.
    const { env, db } = makeEnv();
    const mine = seedChat(db, 'mine');
    const theirs = seedChat(db, 'theirs');
    seed(db, mine, 'a1', null, 'the brass key is here');
    seed(db, theirs, 'z1', null, 'the brass key is also here');

    const payload = (await (await searchChat(env, mine, new URL('http://x/api/chats/mine/search?q=brass'))).json()) as {
      hits: Array<{ id: string }>;
    };
    expect(payload.hits.map((hit) => hit.id)).toEqual(['a1']);
  });

  test('limit is honoured and clamped', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    let parent: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const id = `m${index}`;
      seed(db, chatId, id, parent, `message ${index} about the key`);
      parent = id;
    }

    const two = (await (await searchChat(env, chatId, searchUrl('key', 2))).json()) as { hits: unknown[] };
    expect(two.hits).toHaveLength(2);

    // A huge limit is clamped rather than passed through to SQL.
    const big = (await (await searchChat(env, chatId, searchUrl('key', 99999))).json()) as { hits: unknown[] };
    expect(big.hits).toHaveLength(8);

    // A malformed limit takes the default rather than throwing.
    const bad = await searchChat(env, chatId, new URL('http://x/api/chats/chat-1/search?q=key&limit=abc'));
    expect(bad.status).toBe(200);
  });

  test('an unknown chat is a 404', async () => {
    const { env } = makeEnv();
    expect((await searchChat(env, 'nope', searchUrl('key'))).status).toBe(404);
  });

  test('an FTS operator in the query is treated as text, not as an operator', async () => {
    // `buildMatchQuery` quotes every token, so `-` and `*` cannot inject. Without that,
    // `Ada - refuses` would silently become "Ada AND NOT refuses".
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'Ada refuses the offer');
    seed(db, chatId, 'a2', 'a1', 'Ada accepts the offer');

    const payload = (await (await searchChat(env, chatId, searchUrl('Ada - refuses'))).json()) as {
      hits: Array<{ id: string }>;
    };
    // Both rows mention Ada, and the `-` is a literal token rather than a NOT.
    expect(payload.hits.map((hit) => hit.id).sort()).toEqual(['a1', 'a2']);
  });
});

describe('exportChat', () => {
  test('markdown contains the visible path with speaker names', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'Quill looks up. You are late.');
    seed(db, chatId, 'u1', 'a1', 'Sorry.', 1, 'user');

    const res = await exportChat(env, chatId, new URL('http://x/api/chats/chat-1/export?format=md'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const body = await res.text();
    expect(body).toContain('# The lantern room');
    expect(body).toContain('Quill looks up. You are late.');
    expect(body).toContain('**Quill**');
    expect(body).toContain('**You**');
  });

  test('an off-path branch is never exported', async () => {
    // The property that matters: exporting rows the reader cannot see would produce a
    // transcript that disagrees with the app.
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'the visible opening', 1);
    seed(db, chatId, 'a1b', null, 'ABANDONED VARIANT', 0);
    seed(db, chatId, 'u1', 'a1', 'visible reply');

    const body = await (
      await exportChat(env, chatId, new URL('http://x/api/chats/chat-1/export?format=md'))
    ).text();

    expect(body).toContain('the visible opening');
    expect(body).not.toContain('ABANDONED VARIANT');
  });

  test('the scene line carries location and time from world state', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'text');
    exec(
      db,
      `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)`,
      chatId,
      JSON.stringify({ location: 'the lantern room', time: 'late evening', weather: 'raining' }),
      Date.now(),
    );

    const body = await (
      await exportChat(env, chatId, new URL('http://x/api/chats/chat-1/export?format=md'))
    ).text();
    expect(body).toContain('*the lantern room · late evening · raining*');
  });

  test('json export has the documented shape', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'text');
    exec(
      db,
      `INSERT INTO chat_cast (chat_id, id, character_id, name, color, is_primary, created_at)
       VALUES (?, 'c2', NULL, 'Olivia', '--voice-2', 0, ?)`,
      chatId,
      Date.now(),
    );

    const res = await exportChat(env, chatId, new URL('http://x/api/chats/chat-1/export?format=json'));
    expect(res.headers.get('content-type')).toContain('application/json');
    const payload = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(
      ['cast', 'character', 'chat', 'messages', 'persona', 'state'].sort(),
    );
    expect(payload.character).toEqual({ id: 'char-chat-1', name: 'Quill 25/09/2026', shownName: 'Quill' });
    const cast = payload.cast as Array<{ name: string }>;
    expect(cast.map((member) => member.name)).toEqual(['Quill', 'Olivia']);
    const messages = payload.messages as Array<{ speaker: string }>;
    expect(messages[0].speaker).toBe('Quill');
  });

  test('an unknown format is rejected rather than silently defaulting', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    expect(
      (await exportChat(env, chatId, new URL('http://x/api/chats/chat-1/export?format=pdf'))).status,
    ).toBe(400);
  });

  test('the default format is markdown', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    seed(db, chatId, 'a1', null, 'text');
    const res = await exportChat(env, chatId, new URL('http://x/api/chats/chat-1/export'));
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });

  test('an empty chat exports an empty transcript rather than failing', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const body = await (
      await exportChat(env, chatId, new URL('http://x/api/chats/chat-1/export?format=md'))
    ).text();
    expect(body).toContain('# The lantern room');
  });

  test('an unknown chat is a 404', async () => {
    const { env } = makeEnv();
    expect((await exportChat(env, 'nope', new URL('http://x/api/chats/nope/export'))).status).toBe(404);
  });
});
