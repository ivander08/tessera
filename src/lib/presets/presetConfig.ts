import { asRecord } from '../json';

/**
 * The chub-shaped preset config — everything a preset carries that is NOT a sampler knob.
 *
 * Samplers are per-model and live in `knobs_json`: they are numbers a provider either
 * accepts or refuses, which is why knob support is decided per selected model. This is
 * the other half — prompt structure, stopping strings, assistant prefill, the behaviour
 * flags, and the lorebook scan settings. chub ships both halves inside one preset object
 * and SillyTavern splits them across two namespaces; the two columns exist so an ST
 * import can fill the sampler half and leave this one at defaults.
 *
 * Every field is optional on the wire. `parsePresetConfig` reads a stored record the way
 * `parseTheme` reads a stored theme: per field, clamped, and never throwing — a stale or
 * hand-edited record must not be able to put the editor into a state it cannot render,
 * nor leave a chat sending a nonsense `max_tokens` to a provider.
 *
 * A parsed config is COMPLETE: every field is present, absent ones carrying the default.
 * A preset's config is therefore a full overlay rather than a sparse patch, which is what
 * `loadEffectiveSettings` already assumes when it layers a preset over the global
 * settings. The defaults below are the app's own global defaults, so a preset that sets
 * none of them changes nothing for a chat that uses it.
 */
export interface PresetConfig {
  /** Replaces the global system prompt. A card's own prompt still wins over this. */
  systemPrompt?: string;
  /** Injected before the history. Part of the cached prefix, so it must be static. */
  preHistoryInstructions?: string;
  /** Replaces the card's post-history instructions when set. */
  postHistoryInstructions?: string;
  impersonationPrompt?: string;
  /** Prefix every history line with the speaker's name. */
  includeNames?: boolean;
  banEmojis?: boolean;
  /** Drop a trailing sentence the model did not finish. */
  trimIncompleteSentences?: boolean;
  /** Text the reply must begin with. Sent as a trailing assistant turn, not a request. */
  assistantPrefill?: string;
  stopStrings?: string[];
  maxTokens?: number;
  contextSize?: number;
  loreScanDepth?: number;
  loreTokenBudget?: number;
  loreRecursive?: boolean;
}

/**
 * What a preset that specifies nothing means.
 *
 * The numeric defaults mirror `loadChatSettings` in `worker/src/db.ts` exactly. That is
 * the point: a preset with no opinion must not quietly narrow the context window or
 * halve the output budget for a chat that attaches it.
 */
export const DEFAULT_PRESET_CONFIG: PresetConfig = {
  systemPrompt: '',
  preHistoryInstructions: '',
  postHistoryInstructions: '',
  impersonationPrompt: '',
  includeNames: false,
  banEmojis: false,
  trimIncompleteSentences: false,
  assistantPrefill: '',
  stopStrings: [],
  maxTokens: 1024,
  contextSize: 16384,
  loreScanDepth: 4,
  loreTokenBudget: 1024,
  loreRecursive: false,
};

/**
 * Hard bounds, inclusive.
 *
 * A preset may narrow these but never widen them: below the minimum the request is
 * meaningless (0 output tokens, a 12-token context), and above the maximum no model in
 * use accepts it — the provider would reject the turn outright, which is a worse
 * outcome than the value being clamped.
 *
 * Numeric strings are accepted on the way in, because hand-edited JSON and some
 * community presets quote their numbers. Anything that is not a finite number once
 * coerced falls back to the default — an unusable value must not become a bound by
 * accident.
 */
const BOUNDS = {
  maxTokens: [16, 65536],
  contextSize: [1024, 1048576],
  loreScanDepth: [0, 100],
  loreTokenBudget: [0, 65536],
} as const;

/** Providers accept a bounded stop list. A preset shipping 400 is a bug, not a wish. */
const MAX_STOP_STRINGS = 32;

function clampNumber(value: unknown, key: keyof typeof BOUNDS): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_PRESET_CONFIG[key] as number;
  const [min, max] = BOUNDS[key];
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/**
 * Reads a stored config.
 *
 * A missing record, unparseable JSON, or a document that is not an object all yield the
 * defaults rather than an error: none of those is something the reader can act on, and
 * the alternative — refusing to load — leaves the preset editor unreachable, which is
 * exactly the state a hand-edited row must not be able to produce.
 */
export function parsePresetConfig(raw: string | null | undefined): PresetConfig {
  if (!raw) return { ...DEFAULT_PRESET_CONFIG, stopStrings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PRESET_CONFIG, stopStrings: [] };
  }

  const record = asRecord(parsed);
  if (!record) return { ...DEFAULT_PRESET_CONFIG, stopStrings: [] };

  const stops = Array.isArray(record.stopStrings)
    ? record.stopStrings
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        .slice(0, MAX_STOP_STRINGS)
    : [];

  return {
    systemPrompt: typeof record.systemPrompt === 'string' ? record.systemPrompt : '',
    preHistoryInstructions:
      typeof record.preHistoryInstructions === 'string' ? record.preHistoryInstructions : '',
    postHistoryInstructions:
      typeof record.postHistoryInstructions === 'string' ? record.postHistoryInstructions : '',
    impersonationPrompt:
      typeof record.impersonationPrompt === 'string' ? record.impersonationPrompt : '',
    includeNames: record.includeNames === true,
    banEmojis: record.banEmojis === true,
    trimIncompleteSentences: record.trimIncompleteSentences === true,
    assistantPrefill: typeof record.assistantPrefill === 'string' ? record.assistantPrefill : '',
    stopStrings: stops,
    maxTokens: clampNumber(record.maxTokens, 'maxTokens'),
    contextSize: clampNumber(record.contextSize, 'contextSize'),
    loreScanDepth: clampNumber(record.loreScanDepth, 'loreScanDepth'),
    loreTokenBudget: clampNumber(record.loreTokenBudget, 'loreTokenBudget'),
    loreRecursive: record.loreRecursive === true,
  };
}
