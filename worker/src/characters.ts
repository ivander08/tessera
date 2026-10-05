import { badRequest, json, notFound, readJson } from './http';
import { getCharacter as loadCharacter } from './db';
import { forkCard } from '../../src/lib/cards/fork';
import { asRecord, asString, asStringArray } from '../../src/lib/json';
import type { CharacterCardJson, GreetingState, ParsedCard } from '../../src/lib/cards/types';
import { estimateTokens } from '../../src/lib/tokenEstimate';
import type { DbStatement } from './db/driver';

/**
 * Characters: import, read, edit, fork, delete.
 *
 * The permanent fields — name, description, personality, scenario — are re-sent in the
 * prompt head on every turn forever, so the row stores their token count. That number is
 * what the editor shows the user while they type, which is the only way the cost of a
 * 900-token description is visible before it has been paid a hundred times.
 */

/** The fields the editor groups as "paid on every turn". */
const PERMANENT_FIELDS = ['name', 'description', 'personality', 'scenario'] as const;

/** Card fields that are plain strings. */
const STRING_FIELDS = [
  'description',
  'personality',
  'scenario',
  'firstMes',
  'mesExample',
  'systemPrompt',
  'postHistoryInstructions',
  'creatorNotes',
] as const;

/** Card fields that are lists of strings. */
const LIST_FIELDS = ['alternateGreetings', 'tags'] as const;

/** Card fields that are a list of `{ time?, location?, weather? }`. */
const GREETING_STATE_FIELDS = ['time', 'location', 'weather'] as const;

export interface CharacterDetail {
  id: string;
  name: string;
  avatar: string | null;
  sourceFormat: string;
  tokens: number | null;
  createdAt: number;
  /** Null when the stored JSON will not parse; `cardJson` is then the only copy left. */
  card: CharacterCardJson | null;
  cardJson: string;
}

interface CreateCharacterBody {
  card?: ParsedCard;
  avatar?: { contentType?: string; dataBase64?: string };
}

export async function createCharacter(env: Env, req: Request): Promise<Response> {
  const body = await readJson<CreateCharacterBody>(req);
  const card = body?.card;
  if (!card || typeof card.name !== 'string' || card.name.length === 0) {
    return badRequest('card with a name required');
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  // `card_json` holds the mapped `CharacterCardJson` and nothing else. Three fields of
  // a `ParsedCard` do not belong in it:
  //   `raw`         — anything the source format allowed, and nothing reads it;
  //   `sourceFormat`— a column on the row already, so a copy here would be a second
  //                   source of truth that a rename could desynchronise;
  //   `avatarHint`  — the card's own avatar, which is a `data:` URL on cards that
  //                   embed one. That is the exact 2 MB-row hazard the assets table
  //                   exists to avoid, and the bytes are already in `character_assets`.
  const stored: Record<string, unknown> = { ...card };
  delete stored.raw;
  delete stored.sourceFormat;
  delete stored.avatarHint;

  const hasAvatar = Boolean(body.avatar?.dataBase64);

  await env.DB.prepare(
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      card.name,
      hasAvatar ? avatarPath(id, now) : null,
      JSON.stringify(stored),
      card.sourceFormat,
      permanentTokens(card),
      now,
    )
    .run();

  if (hasAvatar) {
    const bytes = base64ToBytes(body.avatar?.dataBase64 ?? '');
    if (bytes) {
      await env.DB.prepare(
        `INSERT INTO character_assets (character_id, content_type, bytes, created_at)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(id, body.avatar?.contentType ?? 'image/png', bytes, now)
        .run();
    }
  }

  return json({ id, name: card.name, tokens: permanentTokens(card) }, 201);
}

export async function listCharacters(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.avatar, c.source_format, c.tokens, c.created_at,
            (SELECT COUNT(*) FROM chats WHERE character_id = c.id) AS chat_count
       FROM characters c ORDER BY c.created_at DESC`,
  ).all();
  return json(results);
}

/**
 * One character, card included.
 *
 * `cardJson` is returned alongside the parsed card so a row whose JSON will not parse
 * can be read rather than silently lost: the editor refuses to save over it and shows
 * the raw text instead.
 */
export async function getCharacterDetail(env: Env, id: string): Promise<Response> {
  const detail = await characterDetail(env, id);
  if (!detail) return notFound('character not found');
  return json(detail);
}

interface UpdateCharacterBody {
  id?: string;
  /** Renames the character. Ignored when `card` carries its own name. */
  name?: string;
  card?: unknown;
  avatar?: { contentType?: string; dataBase64?: string };
}

/**
 * Edits a character in place.
 *
 * `characters.name` and `card_json.name` are kept equal, because they are two views of
 * one value and a fork, an import, and a rename must all leave them agreeing.
 *
 * Replacing the avatar goes through a batch with the row update so the two cannot
 * diverge: a card renamed but pointing at the previous avatar's bytes would be a lie
 * the UI has no way to detect.
 */
export async function updateCharacter(env: Env, req: Request): Promise<Response> {
  const body = await readJson<UpdateCharacterBody>(req);
  if (!body?.id) return badRequest('id required');

  const row = await loadCharacter(env, body.id);
  if (!row) return notFound('character not found');

  // A stored card that will not parse is not a reason to refuse the write: the client
  // sends the whole card, so saving repairs it. The GET hands back the raw JSON, so
  // nothing is lost unread in the meantime.
  const current = parseStoredCard(row.card_json) ?? { ...EMPTY_CARD, name: row.name };

  let card = current;
  if (body.card !== undefined) {
    const next = readCard(body.card, current);
    if (!next) return badRequest('card.name must be a non-empty string');
    card = next;
  } else if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length === 0) return badRequest('name must not be empty');
    card = { ...card, name };
  }

  // Decoded before anything is written, so a malformed avatar cannot leave the row
  // updated and the asset missing.
  let avatarBytes: Uint8Array | null = null;
  if (body.avatar !== undefined) {
    const dataBase64 = body.avatar?.dataBase64;
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      return badRequest('avatar must be { contentType, dataBase64 }');
    }
    avatarBytes = base64ToBytes(dataBase64);
    if (!avatarBytes) return badRequest('avatar is not valid base64');
  }

  const now = Date.now();
  const statements: DbStatement[] = [
    env.DB.prepare('UPDATE characters SET name = ?, card_json = ?, tokens = ? WHERE id = ?').bind(
      card.name,
      JSON.stringify(card),
      permanentTokens(card),
      row.id,
    ),
  ];

  if (avatarBytes) {
    statements.push(
      env.DB.prepare('DELETE FROM character_assets WHERE character_id = ?').bind(row.id),
      env.DB.prepare(
        `INSERT INTO character_assets (character_id, content_type, bytes, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(row.id, body.avatar?.contentType ?? 'image/png', avatarBytes, now),
      env.DB.prepare('UPDATE characters SET avatar = ? WHERE id = ?').bind(
        avatarPath(row.id, now),
        row.id,
      ),
    );
  }

  await env.DB.batch(statements);

  return json(await characterDetail(env, row.id));
}

interface ForkCharacterBody {
  id?: string;
  /** Defaults to "<name> (copy)" so the list can fork in one tap and rename after. */
  name?: string;
}

/**
 * Copies a character into a new row.
 *
 * The card is cloned structurally by `forkCard` — a shallow copy would leave both rows
 * sharing `characterBook`, and editing one character's world info would silently edit
 * the other's.
 *
 * The avatar is copied as bytes rather than as a reference: an avatar belongs to the
 * character, so deleting one fork must not blank the other's picture.
 */
export async function forkCharacter(env: Env, req: Request): Promise<Response> {
  const body = await readJson<ForkCharacterBody>(req);
  if (!body?.id) return badRequest('id required');

  const row = await loadCharacter(env, body.id);
  if (!row) return notFound('character not found');

  const source = parseStoredCard(row.card_json) ?? { ...EMPTY_CARD, name: row.name };
  const name = (body.name ?? `${source.name} (copy)`).trim();
  if (name.length === 0) return badRequest('name must not be empty');

  const card = forkCard(source, { name });
  const id = crypto.randomUUID();
  const now = Date.now();

  const statements: DbStatement[] = [
    env.DB.prepare(
      `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      card.name,
      row.avatar ? avatarPath(id, now) : null,
      JSON.stringify(card),
      row.source_format,
      permanentTokens(card),
      now,
    ),
  ];

  if (row.avatar) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO character_assets (character_id, content_type, bytes, created_at)
         SELECT ?, content_type, bytes, ? FROM character_assets WHERE character_id = ?`,
      ).bind(id, now, row.id),
    );
  }

  await env.DB.batch(statements);

  return json({ id, name: card.name, tokens: permanentTokens(card) }, 201);
}

export async function getAvatar(env: Env, characterId: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT content_type, bytes FROM character_assets WHERE character_id = ?',
  )
    .bind(characterId)
    .first<{ content_type: string; bytes: unknown }>();
  // A row with no bytes is a row that cannot be served: answering 200 with an empty body
  // hands the browser a broken image and hides the fault behind a success code.
  if (!row) return notFound('no avatar');
  const bytes = asBytes(row.bytes);
  if (!bytes || bytes.byteLength === 0) return notFound('no avatar');

  return new Response(bytes, {
    headers: {
      'content-type': row.content_type,
      'content-length': String(bytes.byteLength),
      // The URL carries a `?v=` stamp that changes whenever the image does, so this can
      // be immutable without ever serving a replaced avatar from a stale cache.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

/**
 * Coerces a BLOB column into bytes the `Response` constructor will actually accept.
 *
 * D1 does not hand back an `ArrayBuffer` for a BLOB. Depending on the path the value
 * took it arrives as a plain array of byte numbers, and `new Response(numberArray)` is
 * not a `BodyInit` — it serializes to nothing at all, producing a `200` with an empty
 * body and an image that never renders. Typing the column as `ArrayBuffer` does not
 * make it one; only reading it defensively does.
 */
function asBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    // Copied rather than viewed: a view onto a SharedArrayBuffer or a pooled buffer is
    // not a `BodyInit`, and the copy is one allocation against a request that already
    // moved these bytes over the wire.
    const view = value;
    const out = new Uint8Array(view.byteLength);
    out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return out;
  }
  if (Array.isArray(value)) {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const byte = value[i];
      out[i] = typeof byte === 'number' ? byte & 0xff : 0;
    }
    return out;
  }
  return null;
}

/** Removes the stored bytes and the path that pointed at them. */
export async function deleteCharacterAvatar(env: Env, characterId: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT id FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ id: string }>();
  if (!row) return notFound('character not found');

  await env.DB.batch([
    env.DB.prepare('DELETE FROM character_assets WHERE character_id = ?').bind(characterId),
    env.DB.prepare('UPDATE characters SET avatar = NULL WHERE id = ?').bind(characterId),
  ]);

  return json({ ok: true });
}

/**
 * Deletes a character and its conversations.
 *
 * `chats.character_id` has no ON DELETE rule, so a character with chats cannot be
 * deleted while they exist — the foreign key rejects it. Leaving them would be worse
 * than deleting them: a chat whose character is gone renders as "Untitled" and fails
 * when the next turn tries to load a card that no longer exists. `messages` and the
 * memory tables cascade from `chats`, and `character_assets` cascades from `characters`.
 */
export async function deleteCharacter(env: Env, characterId: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chats WHERE character_id = ?').bind(characterId),
    env.DB.prepare('DELETE FROM characters WHERE id = ?').bind(characterId),
  ]);
  return json({ ok: true });
}

async function characterDetail(env: Env, id: string): Promise<CharacterDetail | null> {
  const row = await loadCharacter(env, id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    sourceFormat: row.source_format,
    tokens: row.tokens,
    createdAt: row.created_at,
    card: parseStoredCard(row.card_json),
    cardJson: row.card_json,
  };
}

/** The four fields paid on every turn. Stored on the row and shown in the editor. */
function permanentTokens(card: CharacterCardJson): number {
  let total = 0;
  for (const field of PERMANENT_FIELDS) total += estimateTokens(card[field]);
  return total;
}

/**
 * The avatar path carries a version query.
 *
 * `getAvatar` serves the bytes `immutable, max-age=1y`, so replacing an avatar at a
 * fixed URL would leave every browser showing the old picture for a year. Bumping the
 * version on each write keeps the long cache for an avatar that has not changed and
 * invalidates it exactly when the bytes do.
 */
function avatarPath(id: string, version: number): string {
  return `/api/characters/${id}/avatar?v=${version}`;
}

function parseStoredCard(json: string): CharacterCardJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return readCard(parsed);
}

/**
 * Every card field, empty. `name` is the caller's, because a card with no name cannot be
 * filed — it is an error, never a default.
 */
const EMPTY_CARD: Omit<CharacterCardJson, 'name'> = {
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  alternateGreetings: [],
  creatorNotes: '',
  tags: [],
  characterBook: null,
  greetingStates: [],
};

/**
 * `greetingStates`, or null when the value is not an array of objects.
 *
 * A malformed entry becomes `{}` rather than failing the whole save: the field is
 * optional decoration on a card whose prose is the part that matters, and refusing the
 * write would lose the edit the reader actually made.
 */
function greetingStates(value: unknown): GreetingState[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) return {};
    const out: GreetingState = {};
    for (const field of GREETING_STATE_FIELDS) {
      if (field in record) out[field] = asString(record[field]);
    }
    return out;
  });
}

/**
 * Type-checks a card as it crosses the HTTP boundary, or as it comes back out of the
 * database.
 *
 * With a `base`, a field the payload omits keeps its existing value — so a patch that
 * touches one field does not blank the eleven it did not mention. `name` is required
 * either way: a card with no name cannot be filed, so it is an error rather than a
 * default.
 */
function readCard(value: unknown, base: CharacterCardJson | null = null): CharacterCardJson | null {
  const record = asRecord(value);
  if (!record) return null;

  const name = asString(record.name).trim();
  if (name.length === 0) return null;

  const out: CharacterCardJson = base ? { ...base, name } : { ...EMPTY_CARD, name };

  for (const field of STRING_FIELDS) {
    if (field in record) out[field] = asString(record[field]);
  }
  for (const field of LIST_FIELDS) {
    if (field in record) out[field] = asStringArray(record[field]);
  }
  if ('characterBook' in record) out.characterBook = asRecord(record.characterBook) ?? null;
  if ('nickname' in record) out.nickname = asString(record.nickname);
  if ('creatorNotesMultilingual' in record) {
    out.creatorNotesMultilingual = record.creatorNotesMultilingual;
  }
  if ('greetingStates' in record) {
    out.greetingStates = greetingStates(record.greetingStates) ?? out.greetingStates;
  }

  return out;
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    // `atob` ignores ASCII whitespace, so `atob(' ')` is `''` rather than an error.
    // Returning that empty array as "valid" is how a zero-byte asset row gets written:
    // the character ends up pointing at an avatar whose bytes are nothing, and every
    // reader gets a broken image with a 200 in the log.
    const binary = atob(base64);
    if (binary.length === 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
