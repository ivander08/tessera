import { badRequest, json, notFound, readJson } from './http';
import {
  addCastMember,
  loadCast,
  promoteCastMember,
  removeCastMember,
  type CastRow,
} from './cast';

/**
 * The cast endpoints.
 *
 * The primary member is the chat's own character and has no row until something writes
 * one, so `GET` on a chat that has never been edited returns a one-member cast rather
 * than an empty list. That is what keeps a single-character scene working with no rows.
 */

export async function listCast(env: Env, chatId: string): Promise<Response> {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const cast = await loadCast(env, chatId);
  return json({ cast: cast.map(publicCast) });
}

export async function addCast(env: Env, chatId: string, req: Request): Promise<Response> {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const body = await readJson<{ name?: string }>(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length === 0) return badRequest('name required');

  const row = await addCastMember(env, chatId, name);
  return json({ member: publicCast(row) }, 201);
}

export async function promoteCast(env: Env, chatId: string, id: string, req: Request): Promise<Response> {
  const body = await readJson<{ characterId?: string }>(req);
  if (!body?.characterId) return badRequest('characterId required');

  const row = await promoteCastMember(env, chatId, id, body.characterId);
  if (!row) return notFound('cast member or character not found');

  return json({ member: publicCast(row) });
}

export async function removeCast(env: Env, chatId: string, id: string): Promise<Response> {
  const before = await loadCast(env, chatId);
  const target = before.find((row) => row.id === id);
  if (!target) return notFound('cast member not found');
  // The chat's own character is not removable: it would leave the scene with no narrator.
  // The UI hides the control, but the rule belongs here, where it cannot be bypassed.
  if (target.is_primary === 1) return badRequest('the primary character cannot be removed');

  await removeCastMember(env, chatId, id);
  return json({ ok: true });
}

/**
 * A cast member as the client sees it.
 *
 * `color` is a `--voice-N` token NAME rather than a hex value, so the client can resolve
 * it against whichever palette is active. A stored hex would be unreadable in the other
 * theme — the dark and light sets are chosen independently for contrast.
 */
function publicCast(row: CastRow): {
  id: string;
  character_id: string | null;
  name: string;
  color: string | null;
  isPrimary: boolean;
} {
  return {
    id: row.id,
    character_id: row.character_id,
    name: row.name,
    color: row.color,
    isPrimary: row.is_primary === 1,
  };
}
