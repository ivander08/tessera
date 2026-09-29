import { badRequest, json, notFound, readJson } from './http';
import { PresetParseError, parsePresetFile } from '../../src/lib/presets/importSt';
import { parseFf5, requiresRegexPack } from '../../src/lib/presets/ff5';
import { asRecord } from '../../src/lib/json';
import { parsePresetConfig } from '../../src/lib/presets/presetConfig';

interface ImportBody {
  name?: string;
  json?: unknown;
  /**
   * The importing client says this file came from the Freaky Frankenstein archive.
   *
   * It has to be told, not detected: an FF5 file is byte-for-byte a chat-completion
   * preset, so no shape check can separate the two. Without the hint the file still
   * imports — it simply lands as `kind: 'chat'`, which is what it looks like, and loses
   * the badge that says its prompts and regex pack belong together.
   */
  kind?: string;
}

/** The stored row, as the reader sees it. */
interface PresetRow {
  id: string;
  name: string;
  kind: string;
  knobs_json: string;
  regex_json: string | null;
  prompt_json: string | null;
  config_json: string | null;
  created_at: number;
  updated_at: number | null;
}

async function selectPreset(env: Env, id: string): Promise<PresetRow | null> {
  return await env.DB.prepare(
    `SELECT id, name, kind, knobs_json, regex_json, prompt_json, config_json, created_at, updated_at
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
    kind: row.kind,
    knobs: JSON.parse(row.knobs_json) as Record<string, number | string | string[]>,
    config: parsePresetConfig(row.config_json),
    regex: row.regex_json ? (JSON.parse(row.regex_json) as unknown[]) : [],
    prompts: row.prompt_json ? (JSON.parse(row.prompt_json) as unknown[]) : [],
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  };
}

/** Imports a SillyTavern sampler preset, normalized on the way in. */
export async function importPreset(env: Env, req: Request): Promise<Response> {
  const body = await readJson<ImportBody>(req);
  if (!body?.json || typeof body.name !== 'string') return badRequest('name and json required');

  let preset;
  try {
    // The FF5 importer is the same normalizer with the kind forced: FF files carry no
    // sampler knobs and their regex pack is mandatory, which is a distinction only the
    // importer that knows the archive can make. `parseFf5` reads a flat record rather
    // than a `{ name, json }` envelope, so the envelope is unwrapped here — and rejected
    // here too, since a non-object would otherwise import as an empty preset.
    const root = asRecord(body.json);
    if (!root) throw new PresetParseError(`Preset "${body.name}" is not a JSON object.`);
    preset =
      body.kind === 'ff5'
        ? parseFf5({ ...root, name: body.name })
        : parsePresetFile({ name: body.name, json: body.json });
  } catch (error) {
    // A malformed preset is the user's file being wrong, not a server fault.
    if (error instanceof PresetParseError) return badRequest(error.message);
    throw error;
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO presets (id, name, kind, knobs_json, regex_json, prompt_json, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      id,
      preset.name,
      preset.kind,
      JSON.stringify(preset.knobs),
      preset.regex.length > 0 ? JSON.stringify(preset.regex) : null,
      preset.prompts.length > 0 ? JSON.stringify(preset.prompts) : null,
      now,
      now,
    )
    .run();

  return json(
    {
      id,
      name: preset.name,
      kind: preset.kind,
      knobs: preset.knobs,
      // A fresh import has no config yet; the editor creates one on first save. Sent
      // already complete so the client never has to guess the defaults.
      config: parsePresetConfig(null),
      // Surfaced rather than swallowed: a knob the preset declared but that could not
      // be carried over is the thing the user needs to know about.
      dropped: preset.dropped,
      regexCount: preset.regex.length,
      promptCount: preset.prompts.length,
      // An FF5-style preset without its regex pack does not run as designed.
      needsRegexPack: requiresRegexPack(preset),
    },
    201,
  );
}

export async function listPresets(env: Env): Promise<Response> {
  // The knob count is computed in SQL rather than by shipping `knobs_json` to the client
  // and parsing it there: the list only needs the number, and a preset's knob map is
  // read in full by the editor, which fetches the single preset anyway.
  const { results } = await env.DB.prepare(
    `SELECT id, name, kind, created_at, COALESCE(updated_at, created_at) AS updated_at,
            (SELECT COUNT(*) FROM json_each(presets.knobs_json)) AS knob_count,
            (regex_json IS NOT NULL) AS has_regex,
            (prompt_json IS NOT NULL) AS has_prompts,
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
 * The copy carries the knobs, config, regex scripts and prompts verbatim: duplicating is
 * how you try a variant without risking the preset a chat is already using, so a copy
 * that dropped half its source would be useless for that.
 */
export async function duplicatePreset(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ id?: string }>(req);
  if (!body?.id) return badRequest('id required');

  const source = await selectPreset(env, body.id);
  if (!source) return notFound('preset not found');

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO presets (id, name, kind, knobs_json, regex_json, prompt_json, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      `${source.name} (copy)`,
      source.kind,
      source.knobs_json,
      source.regex_json,
      source.prompt_json,
      source.config_json,
      now,
      now,
    )
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
