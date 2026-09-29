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
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are a skilled collaborative fiction writer. Write in the present tense, ' +
  'in prose, staying in character. Never speak or act for {{user}}.';

export async function loadChatSettings(env: Env): Promise<ChatSettings> {
  const raw = await getSettings(env);
  return {
    provider: raw.provider ?? null,
    model: raw.model ?? null,
    systemPrompt: raw.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    authorsNote: raw.authorsNote ?? '',
    maxTokens: Number(raw.maxTokens ?? 1024) || 1024,
    contextBudget: Number(raw.contextBudget ?? 16384) || 16384,
    knobs: raw.knobs ? (JSON.parse(raw.knobs) as Record<string, number | string | string[]>) : {},
    idrPerUsd: raw.idrPerUsd ? Number(raw.idrPerUsd) : null,
    loreScanDepth: Number(raw.loreScanDepth ?? 4) || 4,
    loreTokenBudget: Number(raw.loreTokenBudget ?? 1024) || 1024,
    loreRecursive: raw.loreRecursive === 'true',
  };
}
