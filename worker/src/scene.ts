import { badRequest, json, notFound, readJson } from './http';
import { updateState } from './state/update';
import {
  DEFAULT_SCENE_SETUP,
  parseSceneSetup,
  type SceneSetup,
} from '../../src/lib/scene/setup';

/**
 * The per-chat scene setup: how fast time moves, who maintains the world state, and
 * whether the opening seeds it.
 *
 * A missing row is the DEFAULT, not an error. Every chat created before this existed has
 * no row, and so does a chat created without going through the wizard — both are ordinary
 * scenes that must work. So the read never writes: making a `GET` create a row would turn
 * every read of an unconfigured chat into a mutation, and the rest of this codebase keeps
 * read paths read-only.
 */

/** The stored document, or the defaults when the chat has never been configured. */
export async function loadSceneSetup(env: Env, chatId: string): Promise<SceneSetup> {
  const row = await env.DB.prepare('SELECT json FROM chat_scene_setup WHERE chat_id = ?')
    .bind(chatId)
    .first<{ json: string }>();
  if (!row) return { ...DEFAULT_SCENE_SETUP };

  try {
    return parseSceneSetup(JSON.parse(row.json));
  } catch {
    // A hand-edited or truncated row is "unconfigured", which is a working scene.
    return { ...DEFAULT_SCENE_SETUP };
  }
}

export async function getSceneSetup(env: Env, chatId: string): Promise<Response> {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const row = await env.DB.prepare('SELECT updated_at FROM chat_scene_setup WHERE chat_id = ?')
    .bind(chatId)
    .first<{ updated_at: number }>();

  return json({ setup: await loadSceneSetup(env, chatId), updatedAt: row?.updated_at ?? 0 });
}

/**
 * Merges a partial setup over what is stored.
 *
 * A merge rather than a replacement so the wizard can save one answer at a time, and so a
 * client that does not know about a field added later cannot erase it by omitting it.
 * Values pass through `parseSceneSetup`, so an unknown enum member falls back to the
 * default for that field instead of being stored.
 */
export async function patchSceneSetup(env: Env, chatId: string, req: Request): Promise<Response> {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('a JSON object of setup fields is required');
  }

  const current = await loadSceneSetup(env, chatId);
  // The stored value is both the base and the fallback: a field the body does not mention
  // is left alone, and so is one the body supplies an invalid value for. Resetting either
  // to the built-in default would let a client that does not know about a field — or a
  // typo in an enum — silently undo a choice the reader made.
  const merged = parseSceneSetup({ ...current, ...body }, current);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO chat_scene_setup (chat_id, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  )
    .bind(chatId, JSON.stringify(merged), now)
    .run();

  return json({ setup: merged, updatedAt: now });
}

/**
 * Runs the per-turn state update, unless the reader turned it off.
 *
 * The gate lives here rather than at the call site because it is policy about the setting,
 * and because it is the thing worth testing: `off` must mean no call at all, not a call
 * whose result is discarded. `manual` deliberately still runs — it maintains time and
 * place, and the reader corrects anything wrong in the panel — so there is no third branch.
 */
export async function maybeUpdateState(
  env: Env,
  chatId: string,
  lastExchange: { user: string; assistant: string },
  messageId?: string | null,
): Promise<{ applied: boolean; reason?: string }> {
  const setup = await loadSceneSetup(env, chatId);
  if (setup.stateMode === 'off') return { applied: false, reason: 'state mode is off' };
  return updateState(env, chatId, lastExchange, setup, messageId);
}
