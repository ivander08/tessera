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
  /**
   * Provider and model this preset is authored against.
   *
   * A preset is not only a prompt shape — sampler values are per-model, and a preset
   * tuned for one model produces different prose on another. Carrying the model with the
   * preset means "use this preset" is one choice rather than two the reader has to keep
   * in sync. Empty means "leave the chat's own provider/model alone", so a preset that
   * does not care about the model keeps working as a pure prompt overlay.
   */
  provider?: string;
  model?: string;
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
  /**
   * How long a reply should be.
   *
   * Deliberately NOT the same control as `maxTokens`. That is a hard ceiling the provider
   * enforces and the reader pays for; this is an instruction to the model, and the values
   * a reader actually wants — "one beat", "a full scene" — are not token counts and do
   * not behave the same way on every model.
   *
   * `auto` sends nothing, which is the honest default: a model already has an opinion
   * about how much to write, and a rule can only narrow it.
   */
  responseLength?: ResponseLength;
  /** Replaces the built-in rule when `responseLength` is `custom`. */
  responseLengthCustom?: string;
}

/**
 * The lengths a reader can ask for, and what each one means to the model.
 *
 * Written as instructions rather than as word counts on purpose. "Roughly 120 words"
 * produces prose that pads to reach the number and stops mid-beat when it hits it, while
 * "one beat, then stop" produces a reply that ends where the writing ends. The counts in
 * the descriptions are the reader-facing summary; the rule is what is actually sent.
 */
export type ResponseLength = 'auto' | 'brief' | 'short' | 'medium' | 'long' | 'custom';

export const RESPONSE_LENGTHS: Array<{
  value: ResponseLength;
  label: string;
  /** Shown under the control, so the reader knows what they are choosing. */
  description: string;
  /** Sent to the model. Empty means nothing is sent. */
  rule: string;
}> = [
  {
    value: 'auto',
    label: 'Let the model decide',
    description: 'No instruction. The reply is as long as the scene asks for.',
    rule: '',
  },
  {
    value: 'brief',
    label: 'Brief',
    description: 'One action, one line of dialogue. A beat, not a scene.',
    rule:
      'Write a brief reply: one beat, then stop. A single action or a single line of ' +
      'dialogue is enough. Do not summarise what came before and do not set up what ' +
      'comes next.',
  },
  {
    value: 'short',
    label: 'Short',
    description: 'A short paragraph — a few sentences.',
    rule:
      'Write a short reply: one short paragraph of a few sentences. Move the scene ' +
      'forward by one step and stop there.',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Two or three paragraphs.',
    rule:
      'Write a medium reply: two or three paragraphs. Give the scene room to breathe ' +
      'without padding, and end on a beat that invites a response.',
  },
  {
    value: 'long',
    label: 'Long',
    description: 'A full scene beat — four or more paragraphs.',
    rule:
      'Write a long reply: four or more paragraphs. Develop the moment in detail — ' +
      'sensory description, interiority, and dialogue — while keeping every sentence ' +
      'doing work. Do not pad or repeat.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Your own instruction, sent verbatim.',
    rule: '',
  },
];

/**
 * The rule for a length, or '' when nothing should be sent.
 *
 * One function rather than a lookup at the call site, because `custom` has to fall back
 * to nothing when it is empty — an empty instruction sent as a system line is noise the
 * model has to read and discard.
 */
export function responseLengthRule(
  length: ResponseLength | undefined,
  custom: string | undefined,
): string {
  if (!length || length === 'auto') return '';
  if (length === 'custom') return (custom ?? '').trim();
  return RESPONSE_LENGTHS.find((option) => option.value === length)?.rule ?? '';
}

/**
 * What a preset that specifies nothing means.
 *
 * The numeric defaults mirror `loadChatSettings` in `worker/src/db.ts` exactly. That is
 * the point: a preset with no opinion must not quietly narrow the context window or
 * halve the output budget for a chat that attaches it.
 */
export const DEFAULT_PRESET_CONFIG: PresetConfig = {
  provider: '',
  model: '',
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
  responseLength: 'auto',
  responseLengthCustom: '',
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
    provider: typeof record.provider === 'string' ? record.provider : '',
    model: typeof record.model === 'string' ? record.model : '',
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
    responseLength: isResponseLength(record.responseLength) ? record.responseLength : 'auto',
    responseLengthCustom:
      typeof record.responseLengthCustom === 'string' ? record.responseLengthCustom : '',
  };
}

function isResponseLength(value: unknown): value is ResponseLength {
  return RESPONSE_LENGTHS.some((option) => option.value === value);
}
