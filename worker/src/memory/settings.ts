import { loadEffectiveSettings } from '../effective';
import type { EffectiveSettings } from '../effective';

/**
 * The generation settings for a chat's side-channel work.
 *
 * Background memory used to resolve its model from the DEFAULT preset, which is right for
 * work that belongs to no chat and wrong for work that does. Measured: a chat attached to a
 * preset naming deepseek-v4-pro kept summarising with the default preset's glm-5-3-flash,
 * so changing the model looked like it did nothing.
 *
 * One helper rather than a `preset_id` lookup at each call site: five callers need it, and
 * five copies is five places for the rule to drift.
 */
export async function settingsForChat(env: Env, chatId: string): Promise<EffectiveSettings> {
  const row = await env.DB.prepare('SELECT preset_id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ preset_id: string | null }>();
  return loadEffectiveSettings(env, row?.preset_id ?? null);
}
