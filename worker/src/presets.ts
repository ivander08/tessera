import { badRequest, json, notFound, readJson } from './http';
import { DEFAULT_PRESET_CONFIG, parsePresetConfig } from '../../src/lib/presets/presetConfig';

/** The stored row, as the reader sees it. */
interface PresetRow {
  id: string;
  name: string;
  knobs_json: string;
  config_json: string | null;
  created_at: number;
  updated_at: number | null;
}

async function selectPreset(env: Env, id: string): Promise<PresetRow | null> {
  return await env.DB.prepare(
    `SELECT id, name, knobs_json, config_json, created_at, updated_at
       FROM presets WHERE id = ?`,
  )
    .bind(id)
    .first<PresetRow>();
}

/**
 * The wire shape of one preset.
 *
 * `config` goes out already parsed and clamped, so every reader — the editor, the chat
 * screen, anything added later — sees the same complete document rather than having to
 * remember to run `parsePresetConfig` itself.
 */
function presetPayload(row: PresetRow) {
  return {
    id: row.id,
    name: row.name,
    knobs: JSON.parse(row.knobs_json) as Record<string, number | string | string[]>,
    config: parsePresetConfig(row.config_json),
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  };
}

/**
 * A new, empty preset. The editor supplies every field on first save.
 *
 * Presets are authored documents now — system prompt, pre/post-history, assistant
 * prefill, knobs — so creating one is a row with defaults, not a normalization of
 * somebody else's file. The config is written rather than left NULL so the editor opens
 * on a complete document instead of relying on `parsePresetConfig`'s defaults agreeing
 * with what it renders.
 */
export async function createPreset(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ name?: string }>(req);
  const name =
    typeof body?.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : 'New preset';
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO presets (id, name, knobs_json, config_json, created_at, updated_at)
     VALUES (?, ?, '{}', ?, ?, ?)`,
  )
    .bind(id, name, JSON.stringify(DEFAULT_PRESET_CONFIG), now, now)
    .run();
  return json({ id, name }, 201);
}

export async function listPresets(env: Env): Promise<Response> {
  // The knob count is computed in SQL rather than by shipping `knobs_json` to the client
  // and parsing it there: the list only needs the number, and a preset's knob map is
  // read in full by the editor, which fetches the single preset anyway.
  const { results } = await env.DB.prepare(
    `SELECT id, name, created_at, COALESCE(updated_at, created_at) AS updated_at,
            (SELECT COUNT(*) FROM json_each(presets.knobs_json)) AS knob_count,
            (config_json IS NOT NULL) AS has_config
       FROM presets ORDER BY created_at DESC`,
  ).all();
  return json(results);
}

export async function getPreset(env: Env, id: string): Promise<Response> {
  const row = await selectPreset(env, id);
  if (!row) return notFound('preset not found');
  return json(presetPayload(row));
}

/**
 * A partial update of a preset's name, sampler knobs and config.
 *
 * Patch-style rather than a whole-row write: the editor saves the config and the knobs
 * from two different sections of one screen, and a whole-row write would mean the
 * section that was not touched has to send back everything it did not mean to change.
 *
 * The config is run through `parsePresetConfig` before it is stored, so the clamp is
 * applied at the one place a config can enter the database. Without that, a client that
 * skipped its own validation could persist `maxTokens: 99999999` and every turn on a
 * chat using the preset would be rejected by the provider.
 */
export async function updatePreset(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{
    id?: string;
    name?: string;
    knobs?: unknown;
    config?: unknown;
  }>(req);
  if (!body?.id) return badRequest('id required');

  const existing = await selectPreset(env, body.id);
  if (!existing) return notFound('preset not found');

  const sets: string[] = [];
  const values: Array<string | number> = [];

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return badRequest('name must not be empty');
    }
    sets.push('name = ?');
    values.push(body.name.trim());
  }

  if (body.knobs !== undefined) {
    const knobs = body.knobs;
    if (!knobs || typeof knobs !== 'object' || Array.isArray(knobs)) {
      return badRequest('knobs must be an object');
    }
    sets.push('knobs_json = ?');
    values.push(JSON.stringify(knobs));
  }

  if (body.config !== undefined) {
    // Round-tripped through the parser, so what lands in the column is exactly what a
    // reader will get back — never a shape that only the writer could interpret.
    sets.push('config_json = ?');
    values.push(JSON.stringify(parsePresetConfig(JSON.stringify(body.config))));
  }

  if (sets.length === 0) return badRequest('nothing to update');

  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(body.id);

  await env.DB.prepare(`UPDATE presets SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const row = await selectPreset(env, body.id);
  return json(row ? presetPayload(row) : { ok: true });
}

/**
 * Copies a preset under a new id.
 *
 * The copy carries the knobs and the config verbatim: duplicating is how you try a
 * variant without risking the preset a chat is already using, so a copy that dropped
 * half its source would be useless for that.
 */
export async function duplicatePreset(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ id?: string }>(req);
  if (!body?.id) return badRequest('id required');

  const source = await selectPreset(env, body.id);
  if (!source) return notFound('preset not found');

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO presets (id, name, knobs_json, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, `${source.name} (copy)`, source.knobs_json, source.config_json, now, now)
    .run();

  const row = await selectPreset(env, id);
  return json(row ? presetPayload(row) : { ok: true }, 201);
}

/**
 * Attaches a preset to a chat, or detaches it when `presetId` is null.
 *
 * Detaching is a real operation, not a missing one: a chat that has never had a preset
 * and a chat whose preset was removed both fall back to the global settings, and the UI
 * needs to express the second without deleting the preset.
 */
export async function applyPresetToChat(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ chatId?: string; presetId?: string | null }>(req);
  if (!body?.chatId) return badRequest('chatId required');

  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(body.chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  if (body.presetId) {
    const preset = await env.DB.prepare('SELECT id FROM presets WHERE id = ?')
      .bind(body.presetId)
      .first<{ id: string }>();
    if (!preset) return notFound('preset not found');
  }

  // `updated_at` is deliberately not touched: it orders the chat list by last activity,
  // and attaching a preset is not something the conversation did. `setChatPersona` takes
  // the same position for the same reason.
  await env.DB.prepare('UPDATE chats SET preset_id = ? WHERE id = ?')
    .bind(body.presetId ?? null, body.chatId)
    .run();

  return json({ ok: true, presetId: body.presetId ?? null });
}

/**
 * The preset attached to a chat, or null.
 *
 * Returns null rather than 404 when the chat exists but has no preset — "this chat uses
 * the defaults" is an answer, and making the caller distinguish it from an error would
 * push that judgement into every caller.
 */
export async function getChatPreset(env: Env, chatId: string): Promise<Response> {
  const chat = await env.DB.prepare('SELECT preset_id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ preset_id: string | null }>();
  if (!chat) return notFound('chat not found');
  if (!chat.preset_id) return json(null);

  const row = await selectPreset(env, chat.preset_id);
  // A preset deleted out from under the chat leaves a dangling id. The chat keeps
  // working — `loadEffectiveSettings` finds no row and uses the global settings — so the
  // honest answer here is null, not an error the UI has to explain.
  return json(row ? presetPayload(row) : null);
}

export async function deletePreset(env: Env, id: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM presets WHERE id = ?').bind(id).run();
  return json({ ok: true });
}
