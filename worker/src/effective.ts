import { DEFAULT_SYSTEM_PROMPT, getSettings, loadChatSettings, parseKnobs } from './db';
import type { ChatSettings } from './db';
import { parsePresetConfig, responseLengthRule } from '../../src/lib/presets/presetConfig';

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
  /**
   * The preset's own impersonation instruction, used when the turn is written as the
   * reader. Empty means the built-in instruction stands.
   */
  presetImpersonation: string;
  /**
   * Preset text injected before the history. Part of the cached prefix, so it is static
   * for the chat's life — changing it costs one cache miss, which is correct for a
   * deliberate act.
   */
  presetPreHistory: string;
}

/**
 * The generation settings for one chat.
 *
 * ONE owner per fact: a preset carries every generation setting, and `settings` supplies
 * only what is not generation (the IDR rate used to price a turn). The chat's preset wins
 * when it has one; otherwise the DEFAULT preset is used; and an install that has never
 * created a preset still reads its legacy `settings` row, so nothing breaks before the
 * one-click migration in the settings screen has run.
 *
 * The old layering — a preset over a global that was itself half a preset — is what made
 * "where do I change the system prompt?" unanswerable: both screens had one, and the
 * global was missing the fields the preset had.
 */
export async function loadEffectiveSettings(
  env: Env,
  presetId: string | null,
): Promise<EffectiveSettings> {
  const raw = await getSettings(env);
  const defaultId = (raw.default_preset_id ?? '').trim();
  const id = (presetId ?? '').trim() || defaultId;

  const row = id
    ? await env.DB.prepare('SELECT knobs_json, config_json FROM presets WHERE id = ?')
        .bind(id)
        .first<{ knobs_json: string; config_json: string | null }>()
    : null;

  const config = row ? parsePresetConfig(row.config_json) : null;

  // Provider and model fall back to the legacy row rather than to null: a preset authored
  // before these fields existed (or one that only shapes prompts) must not leave the chat
  // with no model at all.
  const base: ChatSettings = config
    ? {
        provider: config.provider || raw.provider || null,
        model: config.model || raw.model || null,
        // The side channel defaults to the pair right above it — a preset that names one
        // model should not have to name it twice.
        cheapProvider: config.cheapProvider || config.provider || raw.cheapProvider || raw.provider || null,
        cheapModel: config.cheapModel || config.model || raw.cheapModel || raw.model || null,
        // A preset authored before these two moved into it must not silently drop the
        // reader's own prompt text. Once the preset sets one, the preset wins.
        systemPrompt: config.systemPrompt || raw.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        authorsNote: config.authorsNote || raw.authorsNote || '',
        maxTokens: config.maxTokens ?? 1024,
        contextBudget: config.contextSize ?? 16384,
        cheapContextBudget: config.cheapContextBudget ?? 0,
        knobs: parseKnobs(row?.knobs_json),
        idrPerUsd: raw.idrPerUsd ? Number(raw.idrPerUsd) : null,
        loreScanDepth: config.loreScanDepth ?? 4,
        loreTokenBudget: config.loreTokenBudget ?? 1024,
        loreRecursive: config.loreRecursive === true,
        disableReasoning: config.reasoning !== true,
      }
    : await loadChatSettings(env);

  return {
    ...base,
    stopStrings: config?.stopStrings ?? [],
    assistantPrefill: config?.assistantPrefill ?? '',
    includeNames: config?.includeNames === true,
    responseLengthRule: config
      ? responseLengthRule(config.responseLength, config.responseLengthCustom)
      : '',
    presetPostHistory: config?.postHistoryInstructions ?? '',
    presetSystemPrompt: config?.systemPrompt ?? '',
    presetImpersonation: config?.impersonationPrompt ?? '',
    presetPreHistory: config?.preHistoryInstructions ?? '',
  };
}

/** Re-exported so callers do not need two imports for the common case. */
export { getSettings };
