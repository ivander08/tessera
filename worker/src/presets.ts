import { badRequest, json, notFound, readJson } from './http';
import { PresetParseError, parsePresetFile } from '../../src/lib/presets/importSt';
import { requiresRegexPack } from '../../src/lib/presets/ff5';

interface ImportBody {
  name?: string;
  json?: unknown;
}

/** Imports a SillyTavern sampler preset, normalized on the way in. */
export async function importPreset(env: Env, req: Request): Promise<Response> {
  const body = await readJson<ImportBody>(req);
  if (!body?.json || typeof body.name !== 'string') return badRequest('name and json required');

  let preset;
  try {
    preset = parsePresetFile({ name: body.name, json: body.json });
  } catch (error) {
    // A malformed preset is the user's file being wrong, not a server fault.
    if (error instanceof PresetParseError) return badRequest(error.message);
    throw error;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO presets (id, name, kind, knobs_json, regex_json, prompt_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      preset.name,
      preset.kind,
      JSON.stringify(preset.knobs),
      preset.regex.length > 0 ? JSON.stringify(preset.regex) : null,
      preset.prompts.length > 0 ? JSON.stringify(preset.prompts) : null,
      Date.now(),
    )
    .run();

  return json(
    {
      id,
      name: preset.name,
      kind: preset.kind,
      knobs: preset.knobs,
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
  const { results } = await env.DB.prepare(
    `SELECT id, name, kind, created_at,
            length(knobs_json) AS knobs_size,
            (regex_json IS NOT NULL) AS has_regex,
            (prompt_json IS NOT NULL) AS has_prompts
       FROM presets ORDER BY created_at DESC`,
  ).all();
  return json(results);
}

export async function getPreset(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, knobs_json, regex_json, prompt_json, created_at
       FROM presets WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      name: string;
      kind: string;
      knobs_json: string;
      regex_json: string | null;
      prompt_json: string | null;
      created_at: number;
    }>();
  if (!row) return notFound('preset not found');

  return json({
    id: row.id,
    name: row.name,
    kind: row.kind,
    knobs: JSON.parse(row.knobs_json) as Record<string, number | string | string[]>,
    regex: row.regex_json ? (JSON.parse(row.regex_json) as unknown[]) : [],
    prompts: row.prompt_json ? (JSON.parse(row.prompt_json) as unknown[]) : [],
    created_at: row.created_at,
  });
}

export async function deletePreset(env: Env, id: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM presets WHERE id = ?').bind(id).run();
  return json({ ok: true });
}
