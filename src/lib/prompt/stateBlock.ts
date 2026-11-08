import { estimateTokens } from '../tokenEstimate';
import type { WorldState } from '../state/schema';

/**
 * Renders the world state as a compact block for the prompt TAIL.
 *
 * Two properties matter more than readability:
 *
 *  1. It is DETERMINISTIC. The same state must render byte-for-byte identically every
 *     turn, or the tail churns and (worse) any future move of this block into the head
 *     would silently break caching. Sections are emitted in a fixed order and thread and
 *     bond lists are sorted, so the order a patch happened to be written in cannot leak
 *     out.
 *  2. It is BUDGETED. The block competes for tail space with recall results and the
 *     authors note. Over budget it sheds whole sections, lowest value first, rather
 *     than being truncated mid-sentence.
 *
 * Nothing here varies per turn except the state itself: no clock, no ids, no counters.
 */

type SectionKey = 'time' | 'location' | 'weather' | 'bonds' | 'threads';

interface Section {
  key: SectionKey;
  text: string;
}

/**
 * Shedding order, least valuable first. Time, location and weather are the facts a scene
 * cannot be written without, so they are the last to go.
 */
const DROP_ORDER: SectionKey[] = [
  // Bonds and threads shed first: they are the least load-bearing of the tracked facts —
  // a scene can be written without either — and they are the newest, so the least proven.
  'threads',
  'bonds',
  'weather',
  'location',
  'time',
];
export const DEFAULT_STATE_BUDGET = 800;

/**
 * Render `state` into at most `maxTokens` tokens of prompt text.
 *
 * Returns `''` when there is nothing to say — an empty state, or a state whose only
 * values are empty — so `assemble` omits the segment entirely rather than sending an
 * empty `system` message.
 */
export function renderStateBlock(
  state: WorldState,
  maxTokens: number = DEFAULT_STATE_BUDGET,
  count: (text: string) => number = estimateTokens,
  /**
   * Which optional sections to render. Defaults to both ON so an existing caller that does
   * not know about craft keeps its current output exactly.
   */
  options: { bonds?: boolean; threads?: boolean } = { bonds: true, threads: true },
): string {
  const sections = collect(state, options);
  if (sections.length === 0 || maxTokens <= 0) return '';

  const renderText = (list: Section[]): string =>
    ['World state:', ...list.map((section) => section.text)].join('\n');

  let text = renderText(sections);
  if (count(text) <= maxTokens) return text;

  const kept = [...sections];
  for (const key of DROP_ORDER) {
    // Never shed the last remaining section: a truncated location is still a location,
    // and an empty block tells the narrator nothing at all.
    if (kept.length <= 1) break;
    const index = kept.findIndex((section) => section.key === key);
    if (index < 0) continue;
    kept.splice(index, 1);
    text = renderText(kept);
    if (count(text) <= maxTokens) return text;
  }

  return truncate(text, maxTokens, count);
}

/** Sections in fixed emission order, most load-bearing facts first. Empty ones omitted. */
function collect(state: WorldState, options: { bonds?: boolean; threads?: boolean }): Section[] {
  const out: Section[] = [];
  const add = (key: SectionKey, text: string): void => {
    if (text.length > 0) out.push({ key, text });
  };

  const time = state.time?.trim() ?? '';
  add('time', time.length > 0 ? `Date/Time: ${time}` : '');
  const location = state.location?.trim() ?? '';
  add('location', location.length > 0 ? `Location: ${location}` : '');
  // Weather sits with time and location: it is scene atmosphere the narrator writes
  // against, and it sheds before the cast list because a scene can be written indoors.
  const weather = state.weather?.trim() ?? '';
  add('weather', weather.length > 0 ? `Weather: ${weather}` : '');

  // Bonds and threads are gated on the craft toggle: with the toggle off the engine is not
  // asked to maintain them, so rendering a stale entry would be a fact the reader turned
  // off coming back.
  if (options.bonds !== false) {
    const bondLines = Object.entries(state.bonds ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pair, values]) => {
        const parts = (['bond', 'sparks', 'grudge'] as const)
          .filter((field) => typeof values[field] === 'number' && values[field] !== 0)
          .map((field) => `${field} ${values[field]}`);
        return parts.length > 0 ? `- ${pair.replace('|', ' ↔ ')} | ${parts.join(', ')}` : '';
      })
      .filter(Boolean);
    add('bonds', bondLines.length > 0 ? `Bonds:\n${bondLines.join('\n')}` : '');
  }

  if (options.threads !== false) {
    const threadLines = (state.threads ?? [])
      .filter((thread) => thread.status !== 'dropped')
      .sort((a, b) => a.text.localeCompare(b.text))
      .map((thread) => `- [${thread.status ?? 'open'}] ${thread.text}`);
    add('threads', threadLines.length > 0 ? `Threads:\n${threadLines.join('\n')}` : '');
  }

  return out;
}




/**
 * Last resort when a single section alone exceeds the budget — a state so large that
 * even dropping every other section does not fit. Character-proportional, then cut on
 * the last newline (or failing that the last space) so the result is still
 * deterministic and still ends on a whole word rather than mid-token.
 */
function truncate(text: string, maxTokens: number, count: (text: string) => number): string {
  const ratio = maxTokens / count(text);
  if (ratio >= 1) return text;

  const target = Math.max(1, Math.floor(text.length * ratio));
  const cut = text.slice(0, target);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return boundary > 0 ? cut.slice(0, boundary) : cut;
}
