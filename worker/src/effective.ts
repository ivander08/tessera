import { getSettings, loadChatSettings } from './db';
import type { ChatSettings } from './db';
import { responseLengthRule, type ResponseLength } from '../../src/lib/presets/presetConfig';

/**
 * Effective generation settings for one chat: the chat's preset layered over the global
 * settings.
 *
 * `chats.preset_id` existed from the first migration and was written as NULL and never
 * read — a preset you can import but not use. This is the read.
 *
 * The merge is preset-wins for anything the preset defines, global otherwise. That order
 * matters: a preset exists precisely to override the defaults, and a preset that loses to
 * the global value is not a preset.
 */
export interface EffectiveSettings extends ChatSettings {
  /** From the preset, when set. */
  stopStrings: string[];
  assistantPrefill: string;
  includeNames: boolean;
  /** The preset's reply-length instruction, resolved from its length setting. */
  responseLengthRule: string;
  /** Replaces the card's post-history instructions when the preset sets them. */
  presetPostHistory: string;
  presetSystemPrompt: string;
}

export async function loadEffectiveSettings(
  env: Env,
  presetId: string | null,
): Promise<EffectiveSettings> {
  const base = await loadChatSettings(env);

  const effective: EffectiveSettings = {
    ...base,
    stopStrings: [],
    assistantPrefill: '',
    includeNames: false,
    responseLengthRule: '',
    presetPostHistory: '',
    presetSystemPrompt: '',
  };

  if (!presetId) return effective;

  const row = await env.DB.prepare(
    'SELECT knobs_json, config_json FROM presets WHERE id = ?',
  )
    .bind(presetId)
    .first<{ knobs_json: string; config_json: string | null }>();
  if (!row) return effective;

  // Sampler knobs from the preset replace the global ones wholesale. Merging them
  // key-by-key would leave a stale global value in play for any knob the preset omits,
  // which is rarely what "use this preset" means.
  try {
    const knobs = JSON.parse(row.knobs_json) as Record<string, number | string | string[]>;
    if (knobs && typeof knobs === 'object') effective.knobs = knobs;
  } catch {
    // A malformed preset must not break the chat; the global knobs stand.
  }

  if (row.config_json) {
    try {
      const config = JSON.parse(row.config_json) as Record<string, unknown>;
      // The model is part of the preset, not a separate setting. Sampler values are
      // per-model, so a preset authored against one model produces different prose on
      // another — carrying the pair here is what makes "use this preset" a single choice.
      // Empty means the preset has no opinion, and the chat's own selection stands.
      if (typeof config.provider === 'string' && config.provider) effective.provider = config.provider;
      if (typeof config.model === 'string' && config.model) effective.model = config.model;
      if (typeof config.maxTokens === 'number') effective.maxTokens = config.maxTokens;
      if (typeof config.contextSize === 'number') effective.contextBudget = config.contextSize;
      if (typeof config.systemPrompt === 'string') effective.presetSystemPrompt = config.systemPrompt;
      if (typeof config.postHistoryInstructions === 'string') {
        effective.presetPostHistory = config.postHistoryInstructions;
      }
      if (typeof config.assistantPrefill === 'string') {
        effective.assistantPrefill = config.assistantPrefill;
      }
      if (config.includeNames === true) effective.includeNames = true;
      if (typeof config.responseLength === 'string') {
        effective.responseLengthRule = responseLengthRule(
          config.responseLength as ResponseLength,
          typeof config.responseLengthCustom === 'string' ? config.responseLengthCustom : '',
        );
      }
      if (Array.isArray(config.stopStrings)) {
        effective.stopStrings = config.stopStrings.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        );
      }
      if (typeof config.loreScanDepth === 'number') effective.loreScanDepth = config.loreScanDepth;
      if (typeof config.loreTokenBudget === 'number') effective.loreTokenBudget = config.loreTokenBudget;
      if (typeof config.loreRecursive === 'boolean') effective.loreRecursive = config.loreRecursive;
    } catch {
      // Same reasoning as the knobs above.
    }
  }

  return effective;
}

/** Re-exported so callers do not need two imports for the common case. */
export { getSettings };
