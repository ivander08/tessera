import { getSettings, loadChatSettings } from './db';
import type { ChatSettings } from './db';
import { responseLengthRule, type ResponseLength } from '../../src/lib/presets/presetConfig';
import { parseRegexScripts, parseStoredPrompts } from '../../src/lib/presets/importSt';
import type { PromptEntry, PromptOrderEntry, RegexScript } from '../../src/lib/presets/types';

/**
 * The stored regex scripts, read back.
 *
 * Accepts the raw column text as well as an array, for the same reason
 * `parseStoredPrompts` does: handing a string to an array reader yields `[]`, which here
 * would mean "this preset has no cleanup" — silently, and with the preset's output
 * leaking into every reply.
 */
function parseStoredRegex(raw: string | null): RegexScript[] {
  if (!raw) return [];
  try {
    return parseRegexScripts(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

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
   * The preset's imported prompt list and its toggle state, when it has one.
   *
   * Carried together because they are meaningless apart: the list is what CAN be
   * emitted, the order is what IS. Null for a preset with no prompt list, which is every
   * preset that only ever carried sampler values — those assemble exactly as Tessera did
   * before this existed.
   */
  presetPrompts: {
    entries: PromptEntry[];
    order: PromptOrderEntry[];
  } | null;
  /**
   * The preset's regex scripts, applied to text entering and leaving the model.
   *
   * A preset's prompt half tells the model what to write; this half cleans up what it
   * wrote. Shipping only the first is why an imported Frankenstein preset leaks its own
   * `Scene: … Done` chain-of-thought to the reader — the script that strips it exists in
   * the file and nothing runs it.
   *
   * Empty for a preset with none, which is every preset that only carries sampler values.
   */
  presetRegex: RegexScript[];
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
    presetPrompts: null,
    presetRegex: [],
  };

  if (!presetId) return effective;

  const row = await env.DB.prepare(
    'SELECT knobs_json, config_json, prompt_json, regex_json FROM presets WHERE id = ?',
  )
    .bind(presetId)
    .first<{
      knobs_json: string;
      config_json: string | null;
      prompt_json: string | null;
      regex_json: string | null;
    }>();
  if (!row) return effective;

  // The scripts are read before the config block, because they do not depend on it and a
  // preset whose config is malformed should still get its cleanup.
  effective.presetRegex = parseStoredRegex(row.regex_json);

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

      // The prompt list is only meaningful when the preset actually carries one. A
      // preset with toggles but no list (or a list but no toggles) is left null so the
      // prompt assembles the way it always has, rather than emitting nothing.
      //
      // `prompt_json` is a stored STRING and is parsed first. Passing the raw string to
      // `parsePromptEntries` yields `[]` — `asArray` of a string is `[]` — which fails
      // this very check silently, leaving the preset inert while everything looks right.
      const entries = parseStoredPrompts(row.prompt_json);
      if (entries.length > 0) {
        const order = Array.isArray(config.promptOrder)
          ? (config.promptOrder as PromptOrderEntry[]).filter(
              (row): row is PromptOrderEntry =>
                !!row && typeof row === 'object' && typeof row.identifier === 'string',
            )
          : [];
        effective.presetPrompts = { entries, order };
      }
    } catch {
      // Same reasoning as the knobs above.
    }
  }

  return effective;
}

/** Re-exported so callers do not need two imports for the common case. */
export { getSettings };
