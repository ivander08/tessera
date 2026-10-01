/**
 * M7 — SillyTavern sampler preset import.
 *
 * `NormalizedPreset` is the single shape every importer produces, so nothing downstream
 * (the store, the prompt assembler, the settings screen) ever sees an ST file layout.
 */

export type PresetKind = 'textgen' | 'chat' | 'ff5';

export interface RegexScript {
  scriptName: string;
  findRegex: string;
  replaceString: string;
  disabled?: boolean;
}

export interface PromptEntry {
  identifier: string;
  name: string;
  content: string;
  role?: string;
  enabled?: boolean;
  /**
   * ST's `injection_position`: 0 means "relative to the end of the chat", 1 means "at a
   * fixed index". Absent on entries that sit in the normal prompt order.
   */
  injectionPosition?: number;
  /** How many messages from the end a relative injection lands. */
  injectionDepth?: number;
  /**
   * One of ST's pinned markers (`chatHistory`, `charDescription`, …).
   *
   * A marker carries no content of its own — it names the position where ST substitutes
   * something it built. Tessera builds those blocks itself, so markers are dropped at
   * resolve time and kept only so the stored list matches what the reader saw in ST.
   */
  marker?: boolean;
}

/** One row of ST's `prompt_order`: which entry, and whether the reader has it on. */
export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

export interface NormalizedPreset {
  name: string;
  kind: PresetKind;
  /** Tessera/OpenAI knob names, never ST names. Values keep their source type. */
  knobs: Record<string, number | string | string[]>;
  regex: RegexScript[];
  prompts: PromptEntry[];
  /**
   * ST's `prompt_order[].order`, which is the AUTHORITY on which prompts are on.
   *
   * `prompts[].enabled` is a stale duplicate — measured on the Douyin preset, the two
   * disagree for 13 of 43 entries. ST renders the Prompt Manager from `prompt_order`, so
   * that is what the reader saw when they ticked the boxes, and that is what decides.
   * Empty for presets that carry no order, in which case `prompts[].enabled` is the only
   * signal available.
   */
  order: PromptOrderEntry[];
  /**
   * Every knob the importer refused, each entry naming the knob and why. Surfaced to
   * the user at import time: a knob dropped without a word is a knob the user believes
   * is active.
   */
  dropped: string[];
}

/**
 * Dispatch a dropped preset file to the importer for its namespace.
 *
 * ST's two sampler namespaces are disjoint — text-completion
 * (`textgenerationwebui_settings`) is where DRY and XTC live, chat-completion
 * (`oai_settings`) has neither — so the namespace is detected first and the knob map
 * follows from it. See `./importSt` for the detection rules and the knob maps.
 *
 * FF5 archives are NOT detected here. An FF5 preset file is byte-for-byte a
 * chat-completion preset, so no shape check can separate the two; the caller that knows
 * it is importing from the FF5 archive calls `parseFf5` instead.
 */
export { PresetParseError, parsePresetFile } from './importSt';
