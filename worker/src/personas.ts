import { badRequest, json, notFound, readJson } from './http';
import type { PersonaRow } from './db';

/**
 * Personas: the reader's own identity in a chat.
 *
 * Exists because `{{user}}` needs a real name. Without one, the placeholder is left
 * visible rather than filled with a pronoun, which is honest but useless — the card
 * reads "She calls {{user}} by name" and the model has nothing to work with.
 */

interface PersonaBody {
  id?: string;
  name?: string;
  description?: string;
  avatar?: string | null;
}

export async function listPersonas(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.avatar, p.created_at,
            (SELECT COUNT(*) FROM chats WHERE persona_id = p.id) AS chat_count
       FROM personas p ORDER BY p.created_at DESC`,
  ).all();
  return json(results);
}

export async function createPersona(env: Env, req: Request): Promise<Response> {
  const body = await readJson<PersonaBody>(req);
  if (!body?.name || body.name.trim().length === 0) return badRequest('name required');

  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO personas (id, name, description, avatar, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, body.name.trim(), body.description ?? null, body.avatar ?? null, Date.now())
    .run();

  return json({ id, name: body.name.trim() }, 201);
}

/**
 * Renames or re-describes a persona.
 *
 * Note what this costs: a persona's name is substituted into `{{user}}`, which appears
 * in the cached head. Changing it rewrites the prefix for every chat using this persona,
 * so the next turn in each of them is a full cache miss. That is inherent — the model
 * genuinely saw a different name — but it is worth knowing before renaming a persona
 * mid-scene.
 */
export async function updatePersona(env: Env, req: Request): Promise<Response> {
  const body = await readJson<PersonaBody>(req);
  if (!body?.id) return badRequest('id required');

  const sets: string[] = [];
  const values: Array<string | null> = [];

  if (body.name !== undefined) {
    if (body.name.trim().length === 0) return badRequest('name must not be empty');
    sets.push('name = ?');
    values.push(body.name.trim());
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    values.push(body.description);
  }
  if (body.avatar !== undefined) {
    sets.push('avatar = ?');
    values.push(body.avatar);
  }

  if (sets.length === 0) return badRequest('nothing to update');

  values.push(body.id);
  await env.DB.prepare(`UPDATE personas SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return json({ ok: true });
}

export async function deletePersona(env: Env, id: string): Promise<Response> {
  // Chats keep their `persona_id` until this runs; the foreign key has no ON DELETE, so
  // the row must be detached first or the delete fails.
  await env.DB.prepare('UPDATE chats SET persona_id = NULL WHERE persona_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM personas WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/** Attaches a persona to a chat, or detaches it when `personaId` is null. */
export async function setChatPersona(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ chatId?: string; personaId?: string | null }>(req);
  if (!body?.chatId) return badRequest('chatId required');

  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(body.chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  if (body.personaId) {
    const persona = await env.DB.prepare('SELECT id FROM personas WHERE id = ?')
      .bind(body.personaId)
      .first<PersonaRow>();
    if (!persona) return notFound('persona not found');
  }

  await env.DB.prepare('UPDATE chats SET persona_id = ? WHERE id = ?')
    .bind(body.personaId ?? null, body.chatId)
    .run();

  return json({ ok: true });
}
