import { asRecord, asString } from '../json';
import { parsePromptEntries, resolveRegexScripts } from './importSt';
import type { NormalizedPreset } from './types';

/**
 * Freaky Frankenstein import (rentry.co/freaky-frankenstein-presets).
 *
 * FF is a chat-completion preset family, so it shares ST's prompt/regex shapes but
 * carries no sampler knobs at all: FF 5.4's twelve top-level keys are the prompt
 * manager fields plus `extensions`, and none of them is a sampler.
 *
 * FF 5.4 is 63 prompt entries and 25 embedded regex scripts, and the regex pack is
 * REQUIRED — the archive says so in as many words ("FF5 Regex 3.0 … ABSOLUTELY
 * REQUIRED - but shipped with presets"). FF carries its live state as HTML `<details>`
 * markup inside `<!-- GFX_START -->…<!-- GFX_END -->` appended to every assistant
 * reply, and strips it for the reader (and partly for the prompt) with those regexes.
 *
 * Importing the prompts WITHOUT the regex scripts therefore does not import the preset
 * as designed: the state markup would reach the reader unstripped and, worse, would
 * stay in the prompt on every subsequent turn. The regex pack is part of the preset,
 * not an optional extra — hence `requiresRegexPack`.
 */
export function parseFf5(entry: { prompts?: unknown; regex?: unknown; name?: string }): NormalizedPreset {
  // The raw FF file keeps its scripts at `extensions.regex_scripts`, and the standalone
  // "FF5 Regex Suite" download is a flat array. `resolveRegexScripts` accepts every
  // shape, so the caller can hand over whichever file it has.
  const regex = resolveRegexScripts(asRecord(entry));

  return {
    name: asString(entry.name).trim() || 'Freaky Frankenstein',
    kind: 'ff5',
    // FF presets carry no sampler knobs; their configuration is the prompt toggles.
    knobs: {},
    regex,
    prompts: parsePromptEntries(entry.prompts),
    dropped: [],
  };
}

/**
 * True when a preset ships prompts but no regex scripts.
 *
 * This is the FF failure mode: the prompt half of the preset imports cleanly and looks
 * fine, while the missing regex half means its own output is never cleaned up.
 */
export function requiresRegexPack(preset: NormalizedPreset): boolean {
  return preset.prompts.length > 0 && preset.regex.length === 0;
}
