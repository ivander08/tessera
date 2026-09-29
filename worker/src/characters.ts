import { badRequest, json, notFound, readJson } from './http';
import type { ParsedCard } from '../../src/lib/cards/types';
import { estimateTokens } from '../../src/lib/tokenEstimate';

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

  // The permanent fields are the ones paid on every turn, so that is the number
  // worth storing on the row.
  const tokens =
    estimateTokens(card.name) +
    estimateTokens(card.description) +
    estimateTokens(card.personality) +
    estimateTokens(card.scenario);

  // `card_json` stores the mapped card, not `raw`: `raw` can hold anything the
  // source format allowed, and the mapped shape is what every reader consumes.
  const stored = { ...card };
  delete (stored as { raw?: unknown }).raw;

  const avatar = body.avatar?.dataBase64 ? `data:${body.avatar.contentType ?? 'image/png'}` : null;

  await env.DB.prepare(
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      card.name,
      avatar ? `/api/characters/${id}/avatar` : null,
      JSON.stringify(stored),
      card.sourceFormat,
      tokens,
      now,
    )
    .run();

  if (body.avatar?.dataBase64) {
    const bytes = base64ToBytes(body.avatar.dataBase64);
    if (bytes) {
      await env.DB.prepare(
        `INSERT INTO character_assets (character_id, content_type, bytes, created_at)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(id, body.avatar.contentType ?? 'image/png', bytes, now)
        .run();
    }
  }

  return json({ id, name: card.name, tokens }, 201);
}

export async function listCharacters(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.avatar, c.source_format, c.tokens, c.created_at,
            (SELECT COUNT(*) FROM chats WHERE character_id = c.id) AS chat_count
       FROM characters c ORDER BY c.created_at DESC`,
  ).all();
  return json(results);
}

export async function getAvatar(env: Env, characterId: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT content_type, bytes FROM character_assets WHERE character_id = ?',
  )
    .bind(characterId)
    .first<{ content_type: string; bytes: ArrayBuffer }>();
  if (!row) return notFound('no avatar');
  return new Response(row.bytes, {
    headers: {
      'content-type': row.content_type,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

export async function deleteCharacter(env: Env, characterId: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM characters WHERE id = ?').bind(characterId).run();
  return json({ ok: true });
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
