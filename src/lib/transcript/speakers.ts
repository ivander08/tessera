import { isName } from '../state/schema';

/**
 * Reading a script.
 *
 * A group reply is written as a script: each speaker's name on its own line, then their
 * words and actions. These two functions are the only places that shape is interpreted —
 * the worker uses `speakersIn` to learn who the narrator introduced, and the transcript
 * uses `splitSpeakers` to give each of them their own name and colour.
 *
 * Both live here, in `src/lib`, because the dependency direction in this repo is strictly
 * `worker/ → src/lib/`: nothing under `src/` may import from `worker/`. One module both
 * sides can reach is what guarantees they agree on the pattern — a second copy of the
 * regex would drift, and the symptom would be a speaker the worker recorded and the
 * transcript did not show.
 */

/**
 * One capitalised word. `\p{Lu}` rather than `[A-Z]`: `A-Z` is ASCII-only, so it fails on
 * `Àmélie`, `Øyvind` and every other accented name. The rest of the class allows combining
 * marks, apostrophes and hyphens, so `O'Brien` and `Mary-Jane` work.
 */
const WORD = `\\p{Lu}[\\p{L}\\p{M}'-]{0,30}`;

/**
 * A single word, requiring at least one LOWERCASE letter somewhere in it.
 *
 * This is what stops an all-caps heading from being read as a speaker: `NARRATION` on its
 * own line would otherwise be a name. No real name is all capitals, and a single-word
 * heading is.
 */
const SINGLE_WORD = `\\p{Lu}(?=[\\p{L}\\p{M}'-]*\\p{Ll})[\\p{L}\\p{M}'-]{1,30}`;

/**
 * A name: either several capitalised words, or one word containing a lowercase letter.
 *
 * The multi-word alternative is what allows `WS-G Probe` — which is all-caps in its first
 * word, so the single-word rule rejects it — while a bare `WS-G` still does not match. A
 * scene's own character is routinely named like a designation rather than a person, and
 * failing to match them means the reply renders as one undifferentiated block.
 *
 * The join is a plain space, not `\s`: a tab is not a script line, and `\s` would let a
 * name run across the newline a script is built from.
 */
const NAME = `(?:${WORD}(?: +${WORD})+|${SINGLE_WORD})`;

/**
 * A script line's speaker: a capitalised name, a colon, then text.
 *
 * The text after the colon is required but NOT consumed — `(?=\S)` rather than `\S`. That
 * is what makes the renderer's `replace(SPEAKER_LINE, '')` lossless: consuming the first
 * non-space character would eat the opening quote of `Ada: "one"`.
 *
 * Anchored at the start of the line, so `He said: "no"` — where the colon is mid-line — is
 * not a speaker.
 */
export const SPEAKER_LINE = new RegExp(`^(${NAME})\\s*:\\s*(?=\\S)`, 'u');

/** A name alone on a line, for the `Name\n"dialogue"` form. */
export const SPEAKER_ALONE = new RegExp(`^(${NAME})\\s*$`, 'u');

/**
 * A line matching `SPEAKER_ALONE` is only a speaker when the next non-empty line opens
 * with dialogue or an action beat. A capitalised word alone on a line is otherwise just a
 * heading, a signature, or a paragraph that happens to be one word long.
 */
const DIALOGUE_START = /^\s*(?:"|'|“|‘|\*|—|–)/u;

export interface Segment {
  /** Null for prose that belongs to nobody in particular — narration, or a single-voice reply. */
  speaker: string | null;
  text: string;
}

/**
 * Split a reply into its speakers' segments.
 *
 * A segment starts at each `SPEAKER_LINE` match and INCLUDES that line verbatim. That is
 * the load-bearing detail: the obvious implementation strips the label and keeps only the
 * dialogue, which loses text. When a speaker continues after a narration paragraph the
 * trailing lines belong to that speaker, and a stripper that only starts a new segment on
 * a match either mis-assigns those lines or drops them — verified against a real
 * four-paragraph reply, where it dropped three labels and mis-assigned an action beat.
 *
 * The consequence is that concatenating every segment's `text` with `\n` reproduces the
 * input exactly, which is asserted in the tests. The renderer strips the label for
 * display; the parser does not.
 *
 * When nothing matches, one segment with `speaker: null` is returned — the ordinary
 * single-character reply, which needs no special path anywhere.
 */
export function splitSpeakers(content: string): Segment[] {
  const lines = content.split('\n');

  // The index of the first line that opens a speaker's segment.
  let first = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (SPEAKER_LINE.test(lines[index])) {
      first = index;
      break;
    }
  }

  if (first === -1) return [{ speaker: null, text: content }];

  const segments: Segment[] = [];
  // Anything before the first speaker is narration, which belongs to nobody.
  if (first > 0) segments.push({ speaker: null, text: lines.slice(0, first).join('\n') });

  let current: Segment | null = null;
  for (let index = first; index < lines.length; index += 1) {
    const match = SPEAKER_LINE.exec(lines[index]);
    if (match) {
      if (current) segments.push(current);
      current = { speaker: match[1], text: lines[index] };
      continue;
    }
    // `current` is non-null here: the loop starts at `first`, which matched.
    current!.text += `\n${lines[index]}`;
  }
  if (current) segments.push(current);

  return segments;
}

/**
 * Names introduced by a reply, in order of first appearance.
 *
 * Conservative on purpose: a false positive invents a cast member, and an invented cast
 * member is rendered as a speaker with a colour and an avatar who does not exist. So a
 * name only counts when it is the first thing on a line and is followed by dialogue or an
 * action beat.
 *
 * `known` and the exclusions are compared case-insensitively, because the narrator writes
 * `olivia` and `Olivia` and they are the same person.
 */
export function speakersIn(content: string, known: string[]): string[] {
  const excluded = new Set(known.map((name) => name.trim().toLowerCase()));
  const lines = content.split('\n');
  const found: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const labelled = SPEAKER_LINE.exec(line);
    if (labelled) {
      add(labelled[1]);
      continue;
    }

    // The `Name\n"dialogue"` form. Only a speaker when what follows is actually speech or
    // an action beat — a capitalised word alone on a line is otherwise a heading.
    const alone = SPEAKER_ALONE.exec(line);
    if (!alone) continue;
    let next = index + 1;
    while (next < lines.length && lines[next].trim().length === 0) next += 1;
    if (next < lines.length && DIALOGUE_START.test(lines[next])) add(alone[1]);
  }

  return found;

  function add(candidate: string): void {
    const name = candidate.trim();
    // A pronoun is never a name, and neither is someone already accounted for.
    if (!isName(name)) return;
    const key = name.toLowerCase();
    if (excluded.has(key)) return;
    excluded.add(key);
    found.push(name);
  }
}
