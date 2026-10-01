import { asArray, asRecord, asString } from '../json';
import type { NormalizedPreset, PromptEntry, PromptOrderEntry, RegexScript } from './types';

/** A file that is not a recognisable preset is an error, not an empty preset. */
export class PresetParseError extends Error {}

type Namespace = 'textgen' | 'chat';

/**
 * ST sampler name -> Tessera/OpenAI parameter name.
 *
 * Tessera sends `knobs` straight into the provider request body, so these are the names
 * OpenRouter and Kenari actually accept — never ST's.
 */
const KNOB_MAP: Record<string, string> = {
  temp: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  rep_pen: 'repetition_penalty',
  freq_pen: 'frequency_penalty',
  presence_pen: 'presence_penalty',
  dry_multiplier: 'dry_multiplier',
  xtc_probability: 'xtc_probability',
  seed: 'seed',
};

/** Text-completion (`textgenerationwebui_settings`) sampler keys. DRY and XTC are real
 * sampler stages on this side only. */
const TEXTGEN_KNOBS: Record<string, string> = { ...KNOB_MAP };

/**
 * Chat-completion (`oai_settings`) sampler keys.
 *
 * DRY and XTC are deliberately absent: this namespace has NEITHER. ST never constructs
 * them for chat completion, and its own outbound allowlist (`OPENAI_KEYS` in
 * `src/constants.js`) has no `dry_*` or `xtc_*` entry, so a chat-completion preset that
 * happens to carry `dry_multiplier` is a file ST would itself have ignored. Importing it
 * anyway would activate a knob the preset's own namespace never defined.
 *
 * Community chat-completion presets (Sinatra, Nemo Engine) write the OpenAI spellings
 * directly, so both spellings are accepted here.
 */
const CHAT_KNOBS: Record<string, string> = {
  temp: 'temperature',
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  rep_pen: 'repetition_penalty',
  repetition_penalty: 'repetition_penalty',
  freq_pen: 'frequency_penalty',
  frequency_penalty: 'frequency_penalty',
  presence_pen: 'presence_penalty',
  presence_penalty: 'presence_penalty',
  seed: 'seed',
};

/** Every ST sampler key either namespace claims to understand. */
const KNOWN_ST_KNOB_NAMES = new Set([...Object.keys(TEXTGEN_KNOBS), ...Object.keys(CHAT_KNOBS)]);

/**
 * llama.cpp's canonical sampler names, from `common_sampler_type_to_str` in
 * `common/sampling.cpp`, plus the aliases `common_sampler_types_from_names` generates
 * from them (kebab-case, no-dash) and its three misc aliases.
 *
 * `typical_p` and `tfs_z` are NOT here — see `normalizeSamplers`.
 */
const LLAMACPP_SAMPLERS: Record<string, true> = {
  dry: true,
  top_k: true,
  top_p: true,
  top_n_sigma: true,
  typ_p: true,
  min_p: true,
  temperature: true,
  xtc: true,
  infill: true,
  penalties: true,
  adaptive_p: true,
  // Generated aliases.
  'top-k': true,
  topk: true,
  'top-p': true,
  topp: true,
  'top-n-sigma': true,
  topnsigma: true,
  'typ-p': true,
  typp: true,
  'min-p': true,
  minp: true,
  'adaptive-p': true,
  adaptivep: true,
  // Misc aliases.
  nucleus: true,
  temp: true,
  typ: true,
};

/** Reasons a knob was refused, surfaced verbatim to the user doing the import. */
const REASON_INVALID_SAMPLER =
  'not a valid llama.cpp sampler — llama.cpp silently drops it with only a log warning';
const REASON_SAMPLER_CHAIN =
  'the llama.cpp sampler chain is not portable — OpenRouter and Kenari do not accept it';

/**
 * Import a SillyTavern preset.
 *
 * Two disjoint namespaces, handled separately: the namespace is detected first and the
 * knob map follows from it. Getting this wrong imports knobs the preset's own namespace
 * does not define.
 *
 * FF5 archives are NOT routed here — an FF5 file is byte-for-byte a chat-completion
 * preset, so nothing in its shape distinguishes it. `parseFf5` is called explicitly by
 * the FF5 importer.
 */
export function parsePresetFile(file: { name: string; json: unknown }): NormalizedPreset {
  const root = asRecord(file.json);
  if (!root) throw new PresetParseError(`Preset "${file.name}" is not a JSON object.`);

  const textgen = asRecord(root.textgenerationwebui_settings);
  const chat = asRecord(root.oai_settings);
  const namespace: Namespace = textgen ? 'textgen' : chat ? 'chat' : sniffNamespace(root, file.name);
  const source = textgen ?? chat ?? root;

  const dropped: string[] = [];
  const knobs = extractKnobs(source, namespace, dropped);
  normalizeSamplers(source, dropped);

  return {
    name: presetName(root, file.name),
    kind: namespace,
    knobs,
    regex: resolveRegexScripts(source, root),
    prompts: parsePromptEntries(source.prompts ?? root.prompts),
    order: parsePromptOrder(source.prompt_order ?? root.prompt_order),
    dropped,
  };
}

/**
 * Detect the namespace of a file that is not wrapped in a settings key.
 *
 * ST's own sniffing (`preset-manager.js`) identifies text-completion data by its
 * sampler quartet and does not catch chat-completion presets at all. Here the
 * chat-completion side is recognised by its Prompt Manager list, which every
 * chat-completion preset has and no text-completion preset does.
 */
function sniffNamespace(root: Record<string, unknown>, filename: string): Namespace {
  const samplerQuartet = ['temp', 'top_k', 'top_p', 'rep_pen'].filter((key) => key in root);
  if (samplerQuartet.length >= 3) return 'textgen';
  if (Array.isArray(root.prompts) || Array.isArray(root.prompt_order)) return 'chat';
  if (Object.keys(root).some((key) => key in CHAT_KNOBS)) return 'chat';
  throw new PresetParseError(
    `Preset "${filename}" is neither a text-completion nor a chat-completion SillyTavern preset.`,
  );
}

function presetName(root: Record<string, unknown>, filename: string): string {
  const declared = asString(root.name).trim();
  if (declared) return declared;
  // ST falls back to the filename for presets that carry no `name` — its shipped
  // text-completion presets and every community FF preset are in that group.
  return filename.replace(/\.(json|settings)$/i, '') || 'Untitled preset';
}

/**
 * Rename the namespace's sampler keys and record everything refused.
 *
 * The map is the claim: a key outside it was never going to be sent, so it is not
 * "dropped". A key inside it that this namespace does not define is a different thing —
 * the user expects it to be active, and it is not.
 */
function extractKnobs(
  source: Record<string, unknown>,
  namespace: Namespace,
  dropped: string[],
): Record<string, number | string | string[]> {
  const map = namespace === 'textgen' ? TEXTGEN_KNOBS : CHAT_KNOBS;
  const knobs: Record<string, number | string | string[]> = {};

  for (const [key, raw] of Object.entries(source)) {
    const target = map[key];
    if (target === undefined) {
      if (KNOWN_ST_KNOB_NAMES.has(key)) {
        dropped.push(
          `${key}: not defined by the ${namespace === 'textgen' ? 'text-completion' : 'chat-completion'} namespace`,
        );
      }
      continue;
    }

    const value = coerceKnob(raw);
    if (value === null) {
      dropped.push(`${key}: value ${JSON.stringify(raw)} is not a number, string or string list`);
      continue;
    }
    knobs[target] = value;
  }

  return knobs;
}

function coerceKnob(raw: unknown): number | string | string[] | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    // Some presets quote their numerics.
    const numeric = Number(raw);
    return raw.trim() !== '' && Number.isFinite(numeric) ? numeric : raw;
  }
  const list = asArray(raw).filter((entry): entry is string => typeof entry === 'string');
  return list.length > 0 ? list : null;
}

/**
 * Normalize the sampler chain on import.
 *
 * ST's own shipped `default/content/presets/textgen/Default.json` lists `tfs_z` and
 * `typical_p` in its `samplers` array. Neither is a valid llama.cpp sampler name —
 * llama.cpp logs a warning and silently drops them — so they are removed here and
 * reported, rather than carried into a preset that claims to use them.
 *
 * The chain itself is not a knob Tessera can send: it is a llama.cpp sampler ORDER, and
 * both of Tessera's providers are OpenAI-compatible endpoints with no such parameter.
 * Sending it would also be actively harmful under `provider.require_parameters: true`,
 * which refuses any provider that cannot honour every parameter sent.
 */
function normalizeSamplers(source: Record<string, unknown>, dropped: string[]): void {
  const chain = asArray(source.samplers).filter((entry): entry is string => typeof entry === 'string');
  if (chain.length === 0) return;

  for (const name of chain) {
    if (LLAMACPP_SAMPLERS[name] !== true) dropped.push(`samplers: ${name} — ${REASON_INVALID_SAMPLER}`);
  }
  dropped.push(`samplers: ${REASON_SAMPLER_CHAIN}`);
}

/**
 * Find regex scripts in whichever shape the file uses.
 *
 * ST nests them at `extensions.regex_scripts`; the standalone FF5 regex suite is a flat
 * array passed as `regex`; older presets put a bare `regex_scripts` at the top level.
 * Records are tried in order, so a caller can prefer the inner settings object.
 */
export function resolveRegexScripts(...records: Array<Record<string, unknown> | null>): RegexScript[] {
  for (const record of records) {
    if (!record) continue;
    if (Array.isArray(record.regex)) return parseRegexScripts(record.regex);
    if (Array.isArray(record.regex_scripts)) return parseRegexScripts(record.regex_scripts);
    const extensions = asRecord(record.extensions);
    if (extensions && Array.isArray(extensions.regex_scripts)) return parseRegexScripts(extensions.regex_scripts);
  }
  return [];
}

/** ST's regex-script shape, as carried by `extensions.regex_scripts`. */
export function parseRegexScripts(value: unknown): RegexScript[] {
  return asArray(value)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => {
      // ST also carries `placement`, `promptOnly` and `minDepth`; the pinned
      // `RegexScript` shape does not, so they are not carried.
      const script: RegexScript = {
        scriptName: asString(entry.scriptName),
        findRegex: asString(entry.findRegex),
        replaceString: asString(entry.replaceString),
      };
      if (typeof entry.disabled === 'boolean') script.disabled = entry.disabled;
      return script;
    });
}

/**
 * ST's Prompt Manager entry shape, as carried by `prompts` in an imported FILE.
 *
 * For a list coming back OUT of the database, use `parseStoredPrompts` — the stored shape
 * is already normalized, and running this over it drops the injection fields.
 */
export function parsePromptEntries(value: unknown): PromptEntry[] {
  return asArray(value)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => {
      const prompt: PromptEntry = {
        identifier: asString(entry.identifier),
        name: asString(entry.name),
        // ST's pinned marker prompts (`worldInfoBefore`, `chatHistory`, …) carry no
        // `content` at all; they are kept so the prompt list stays complete.
        content: asString(entry.content),
      };
      const role = asString(entry.role);
      if (role) prompt.role = role;
      if (typeof entry.enabled === 'boolean') prompt.enabled = entry.enabled;
      // The injection fields decide WHERE a prompt goes, which is the difference between
      // a prompt that behaves as its author intended and one that lands in the wrong
      // place. `0` is "relative to the end of the chat" and `1` is "at a fixed index".
      if (typeof entry.injection_position === 'number') {
        prompt.injectionPosition = entry.injection_position;
      }
      if (typeof entry.injection_depth === 'number') {
        prompt.injectionDepth = entry.injection_depth;
      }
      if (entry.marker === true) prompt.marker = true;
      return prompt;
    });
}

/**
 * The stored prompt list, read back out of `presets.prompt_json`.
 *
 * A shape check rather than a re-parse: the column already holds the normalized
 * `PromptEntry[]` the importer wrote, so ST's reader would drop fields it does not know
 * the names of. A malformed row yields `[]` rather than throwing — a hand-edited preset
 * must not be able to break the editor or the prompt.
 */
export function parseStoredPrompts(value: unknown): PromptEntry[] {
  // Accepts the raw column text as well as an already-parsed array. Every caller so far
  // had the string, and handing a string to `asArray` yields `[]` — a silent empty that
  // looks like "this preset has no prompts" rather than "this call was wrong".
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return asArray(raw)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => {
      const prompt: PromptEntry = {
        identifier: asString(entry.identifier),
        name: asString(entry.name),
        content: asString(entry.content),
      };
      const role = asString(entry.role);
      if (role) prompt.role = role;
      if (typeof entry.enabled === 'boolean') prompt.enabled = entry.enabled;
      // The normalized names, which is what is stored. ST's snake_case belongs to the
      // import path above and would read as `undefined` here.
      if (typeof entry.injectionPosition === 'number') {
        prompt.injectionPosition = entry.injectionPosition;
      }
      if (typeof entry.injectionDepth === 'number') prompt.injectionDepth = entry.injectionDepth;
      if (entry.marker === true) prompt.marker = true;
      return prompt;
    })
    .filter((entry) => entry.identifier.length > 0);
}

/**
 * ST's `prompt_order`, flattened to one list.
 *
 * The file stores it as an array of `{ character_id, order }` — one block per character,
 * plus a block keyed by a sentinel for the global order. Tessera has one order per
 * preset and no per-character prompt overrides, so the FIRST block is taken: it is the
 * one ST applies when the preset is used without a character-specific override, which is
 * how these presets ship.
 */
export function parsePromptOrder(value: unknown): PromptOrderEntry[] {
  const blocks = asArray(value);
  const first = blocks.map((entry) => asRecord(entry)).find((entry) => entry !== null);
  if (!first) return [];
  return asArray(first.order)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      identifier: asString(entry.identifier),
      enabled: entry.enabled === true,
    }))
    .filter((entry) => entry.identifier.length > 0);
}
