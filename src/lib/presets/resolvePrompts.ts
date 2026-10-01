import type { PromptEntry, PromptOrderEntry } from './types';

/**
 * Turning a SillyTavern Prompt Manager list into an ordered set of prompt segments.
 *
 * ## Why this is a module of its own
 *
 * The list is a list of PROMPTS, and the order they are emitted in is the list order.
 * That is the whole mechanism, and it is deceptively easy to get wrong in three ways
 * that this module exists to get right:
 *
 *  1. **`prompt_order` is the authority, not `prompts[].enabled`.** ST stores the enabled
 *     flag twice. Measured on the Douyin preset: 43 entries in `prompt_order`, 46 in
 *     `prompts`, and the two disagree for 13 of them. ST's Prompt Manager renders from
 *     `prompt_order`, so that is what the reader ticked. Reading `prompts[].enabled`
 *     instead would silently enable prompts the reader turned off.
 *
 *  2. **Markers are positions, not content.** `chatHistory`, `charDescription` and the
 *     rest carry no text — they name the slot where ST substitutes a block it built
 *     itself. Tessera builds those blocks from the card, so a marker is a place to
 *     insert Tessera's OWN rendering, not something to emit. Emitting a marker's (empty)
 *     content would drop the card out of the prompt entirely.
 *
 *  3. **Injection depth is a different axis.** A prompt with `injection_position: 0` is
 *     injected a fixed number of messages from the END of the conversation, every turn.
 *     Those are not part of the static head; they interleave with history, and putting
 *     them in the head would both change their meaning and rewrite the cached prefix on
 *     every turn.
 *
 * This module is pure and takes the blocks to substitute, so the whole resolution is
 * testable without a database, a card, or a provider.
 */

/** The blocks Tessera builds itself, keyed by the ST marker that names their position. */
export interface MarkerBlocks {
  worldInfoBefore: string;
  personaDescription: string;
  charDescription: string;
  charPersonality: string;
  scenario: string;
  worldInfoAfter: string;
  dialogueExamples: string;
  chatHistory: string;
}

/** One resolved segment, in the order it should be emitted. */
export interface ResolvedSegment {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** The prompt entry's name, for the editor and for debugging a prompt. */
  name: string;
}

export interface ResolvedPrompts {
  /** Segments emitted before the history. */
  head: ResolvedSegment[];
  /** Segments emitted after the history and before Tessera's own tail blocks. */
  afterHistory: ResolvedSegment[];
  /**
   * Entries injected at a depth from the end of the conversation.
   *
   * `depth` counts messages back from the newest; 0 is "after everything", which is how
   * ST treats the last line of the conversation. Negative depths are clamped to 0.
   */
  injected: Array<{ depth: number; segment: ResolvedSegment }>;
  /** How many entries were considered, so the editor can say "12 of 46 on". */
  total: number;
  enabledCount: number;
}

const MARKER_NAMES: Record<string, keyof MarkerBlocks> = {
  worldInfoBefore: 'worldInfoBefore',
  personaDescription: 'personaDescription',
  charDescription: 'charDescription',
  charPersonality: 'charPersonality',
  scenario: 'scenario',
  worldInfoAfter: 'worldInfoAfter',
  dialogueExamples: 'dialogueExamples',
  chatHistory: 'chatHistory',
};

/** ST's roles, narrowed to the three the wire format accepts. */
function wireRole(role: string | undefined): 'system' | 'user' | 'assistant' {
  return role === 'user' || role === 'assistant' ? role : 'system';
}

/**
 * Which entries are on, and in what order.
 *
 * `order` wins whenever it is non-empty. The fallback to `prompts[].enabled` exists for
 * presets that carry a prompt list but no order — a shape the FF5 importer produces —
 * and for those the list order is the emission order.
 */
export function resolveOrder(
  prompts: PromptEntry[],
  order: PromptOrderEntry[],
): Array<{ prompt: PromptEntry; enabled: boolean }> {
  const byIdentifier = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));

  if (order.length > 0) {
    const seen = new Set<string>();
    const out: Array<{ prompt: PromptEntry; enabled: boolean }> = [];
    for (const row of order) {
      const prompt = byIdentifier.get(row.identifier);
      // An order row naming an entry the file does not carry is skipped rather than
      // faked: ST itself tolerates this (a prompt deleted from the list but still
      // referenced), and inventing an empty entry would emit a blank system message.
      if (!prompt) continue;
      seen.add(row.identifier);
      out.push({ prompt, enabled: row.enabled });
    }
    // Entries present but absent from the order still exist in ST — they are appended to
    // the end of the Prompt Manager. Keeping them means an import cannot lose a prompt
    // the reader can see in ST, and their `enabled` flag is the only signal there is.
    for (const prompt of prompts) {
      if (seen.has(prompt.identifier)) continue;
      out.push({ prompt, enabled: prompt.enabled === true });
    }
    return out;
  }

  return prompts.map((prompt) => ({ prompt, enabled: prompt.enabled === true }));
}

/**
 * Resolve the enabled prompts into segments, substituting the blocks Tessera built.
 *
 * `markerBlocks` is passed in rather than read from a card so this stays pure and so the
 * caller decides what each marker renders to. A marker whose block is empty is skipped
 * entirely — an empty segment is not emitted as a bare label.
 */
export function resolvePrompts(
  prompts: PromptEntry[],
  order: PromptOrderEntry[],
  markerBlocks: MarkerBlocks,
): ResolvedPrompts {
  const resolved = resolveOrder(prompts, order);
  const enabled = resolved.filter((row) => row.enabled);

  const head: ResolvedSegment[] = [];
  const afterHistory: ResolvedSegment[] = [];
  const injected: Array<{ depth: number; segment: ResolvedSegment }> = [];

  // Everything after `chatHistory` in the order belongs after the history. `chatHistory`
  // is the pivot: ST's own Prompt Manager puts the history marker in the middle of the
  // list and the entries around it are emitted around it.
  let pastHistory = false;

  for (const { prompt } of enabled) {
    const markerKey = prompt.marker ? MARKER_NAMES[prompt.identifier] : undefined;

    if (markerKey) {
      if (markerKey === 'chatHistory') {
        pastHistory = true;
        continue;
      }
      const content = markerBlocks[markerKey];
      if (!content) continue;
      (pastHistory ? afterHistory : head).push({
        role: 'system',
        content,
        name: prompt.name || prompt.identifier,
      });
      continue;
    }

    if (!prompt.content) continue;

    const segment: ResolvedSegment = {
      role: wireRole(prompt.role),
      content: prompt.content,
      name: prompt.name || prompt.identifier,
    };

    // A depth-injected prompt is not part of the static run at all. ST gives these
    // priority over their list position: the depth is what places them.
    if (prompt.injectionPosition === 0) {
      injected.push({ depth: Math.max(0, prompt.injectionDepth ?? 0), segment });
      continue;
    }

    (pastHistory ? afterHistory : head).push(segment);
  }

  // Deepest first, so inserting them back-to-front lands each at its own depth without
  // disturbing the ones already placed.
  injected.sort((a, b) => b.depth - a.depth);

  return {
    head,
    afterHistory,
    injected,
    total: resolved.length,
    enabledCount: enabled.length,
  };
}

/**
 * Place the depth-injected segments into a history array.
 *
 * `depth` counts back from the END: depth 0 sits after the newest message, depth 1
 * before it, and so on. A depth beyond the start of the history is clamped to the front
 * rather than dropped — the prompt was enabled, and losing it silently is the failure
 * mode this whole module exists to avoid.
 *
 * Injected segments are grouped so several at one depth keep their relative order.
 */
export function injectAtDepth<T>(
  history: T[],
  injected: Array<{ depth: number; segment: ResolvedSegment }>,
): Array<T | { injected: ResolvedSegment }> {
  if (injected.length === 0) return history;

  const byDepth = new Map<number, ResolvedSegment[]>();
  for (const { depth, segment } of injected) {
    // Clamped HERE rather than at the call site, because this is where the meaning of
    // the number lives: a depth beyond the start of the history means "as early as
    // possible", and a gap that does not exist would otherwise drop the prompt
    // silently — the exact failure this module exists to prevent.
    const clamped = Math.min(Math.max(0, depth), history.length);
    const list = byDepth.get(clamped);
    if (list) list.push(segment);
    else byDepth.set(clamped, [segment]);
  }

  const out: Array<T | { injected: ResolvedSegment }> = [];
  for (let index = 0; index <= history.length; index += 1) {
    // The gap before `history[index]` is `history.length - index` messages from the end.
    const gapDepth = history.length - index;
    const here = byDepth.get(gapDepth);
    if (here) for (const segment of here) out.push({ injected: segment });
    if (index < history.length) out.push(history[index]);
  }
  return out;
}

/** A history row, for `injectAtDepth`. */
export interface HistoryRow {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
