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
}

export interface NormalizedPreset {
  name: string;
  kind: PresetKind;
  /** Tessera/OpenAI knob names, never ST names. Values keep their source type. */
  knobs: Record<string, number | string | string[]>;
  regex: RegexScript[];
  prompts: PromptEntry[];
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
