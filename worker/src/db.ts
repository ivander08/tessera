import type { Role } from '../../src/lib/prompt/types';

export interface CharacterRow {
  id: string;
  name: string;
  avatar: string | null;
  card_json: string;
  source_format: string;
  tokens: number | null;
  created_at: number;
}

export interface PersonaRow {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  created_at: number;
}

export interface ChatRow {
  id: string;
  character_id: string | null;
  persona_id: string | null;
  title: string | null;
  preset_id: string | null;
  window_start_seq: number;
  session_id: string;
  last_prefix_hash: string | null;
  last_prefix_head: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  seq: number;
  id: string;
  chat_id: string;
  parent_id: string | null;
  role: Role;
  content: string;
  tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  /** Who wrote this assistant row; null means the chat's own character. */
  speaker: string | null;
  created_at: number;
}

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{
    key: string;
    value: string;
  }>();
  const out: Record<string, string> = {};
  for (const row of results) out[row.key] = row.value;
  return out;
}

export async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, Date.now())
    .run();
}

/**
 * Write many settings in one round trip.
 *
 * The settings screen saves eleven keys at once, and one `PUT` per key meant eleven
 * sequential requests — each one its own network round trip, its own D1 write, and its own
 * chance to fail halfway and leave the form half-saved. `batch` is D1's own primitive for
 * exactly this: the statements go in one request and run in one transaction, so a save
 * either lands or does not.
 *
 * `updated_at` is computed once rather than per row, so every key written by one save
 * carries the same timestamp — which is what makes "what did that save touch" answerable
 * from the table alone.
 */
export async function putSettings(
  env: Env,
  entries: Array<{ key: string; value: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  const now = Date.now();
  await env.DB.batch(
    entries.map((entry) =>
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(entry.key, entry.value, now),
    ),
  );
}

export async function getChat(env: Env, chatId: string): Promise<ChatRow | null> {
  return await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(chatId).first<ChatRow>();
}

export async function getCharacter(env: Env, id: string): Promise<CharacterRow | null> {
  return await env.DB.prepare('SELECT * FROM characters WHERE id = ?').bind(id).first<CharacterRow>();
}

export async function getPersona(env: Env, id: string): Promise<PersonaRow | null> {
  return await env.DB.prepare('SELECT * FROM personas WHERE id = ?').bind(id).first<PersonaRow>();
}

export interface ChatSettings {
  provider: string | null;
  model: string | null;
  systemPrompt: string;
  authorsNote: string;
  maxTokens: number;
  contextBudget: number;
  knobs: Record<string, number | string | string[]>;
  /** Configured IDR-per-USD rate; when absent Kenari costs stay in micro-IDR. */
  idrPerUsd: number | null;
  /** How many messages back keyword lorebook entries are matched against. */
  loreScanDepth: number;
  /** Token ceiling for matched lorebook content in the tail. */
  loreTokenBudget: number;
  /** Let a matched entry's own text trigger further entries. */
  loreRecursive: boolean;
  /**
   * Whether to ask the provider to skip reasoning on the narrator's turn.
   *
   * Defaults to ON. The narrator has no UI for a reasoning trace, so thinking is latency
   * and output tokens the reader never sees; measured on the cheap model, reasoning ran
   * 16,366 characters with `content` empty and `finish_reason: length`, which reaches the
   * user as a turn that produced nothing.
   *
   * A reader who wants the model to think can turn it off, and a model that does not
   * support the flag is never sent it — the request would be rejected under
   * `require_parameters` on OpenRouter.
   */
  disableReasoning: boolean;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are a skilled collaborative fiction writer. Write in the present tense, ' +
  'in prose, staying in character. Never speak or act for {{user}}.';

/**
 * Sampler defaults for an install that has never set any.
 *
 * The value is not arbitrary. A model driven at an unset temperature follows its own
 * distribution rather than the prompt, and the preset family this app's craft rules are
 * tuned against ships `temperature 0.7 / top_p 0.8`. Every install starts with an empty
 * `knobs` row, so the unset case is the common case and the default has to be the good
 * one. An install that HAS set knobs keeps them verbatim — only the empty case changes.
 *
 * Without this, `worker/src/providers/kenari.ts` spread `...req.knobs` over nothing and
 * no `temperature` or `top_p` reached the provider at all.
 */
export const DEFAULT_KNOBS: Record<string, number> = { temperature: 0.7, top_p: 0.8 };

/**
 * The stored knob map, with the empty one replaced by `DEFAULT_KNOBS`.
 *
 * The emptiness test is on the PARSED map, not on the column text. The settings row for an
 * install that has never touched the knob editor holds the two characters `{}` — a truthy
 * string that parses to an empty object — so a truthiness check on `raw.knobs` would hand
 * an empty map to the provider and leave the defaults unreachable, which is exactly the
 * defect they exist to fix.
 *
 * A map with anything in it is used verbatim: an install that set `temperature` to 0.2
 * meant 0.2, and quietly adding `top_p` beside it would be a second opinion nobody asked
 * for. A malformed value falls back rather than throwing, on the same principle as the
 * rest of this reader — a corrupt settings row must not break every turn.
 */
function parseKnobs(raw: string | undefined): Record<string, number | string | string[]> {
  if (!raw) return DEFAULT_KNOBS;
  try {
    const parsed = JSON.parse(raw) as Record<string, number | string | string[]>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_KNOBS;
    return Object.keys(parsed).length > 0 ? parsed : DEFAULT_KNOBS;
  } catch {
    return DEFAULT_KNOBS;
  }
}

export async function loadChatSettings(env: Env): Promise<ChatSettings> {
  const raw = await getSettings(env);
  return {
    provider: raw.provider ?? null,
    model: raw.model ?? null,
    systemPrompt: raw.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    authorsNote: raw.authorsNote ?? '',
    maxTokens: Number(raw.maxTokens ?? 1024) || 1024,
    contextBudget: Number(raw.contextBudget ?? 16384) || 16384,
    knobs: parseKnobs(raw.knobs),
    idrPerUsd: raw.idrPerUsd ? Number(raw.idrPerUsd) : null,
    loreScanDepth: Number(raw.loreScanDepth ?? 4) || 4,
    loreTokenBudget: Number(raw.loreTokenBudget ?? 1024) || 1024,
    loreRecursive: raw.loreRecursive === 'true',
    // The stored value names the state of reasoning itself: `on` keeps it, anything else
    // (including a row that has never been written) suppresses it. Only an explicit `on`
    // lets the model reason, so an unrecognized value can never silently re-enable the
    // latency this setting exists to remove.
    disableReasoning: raw.reasoning !== 'on',
  };
}
