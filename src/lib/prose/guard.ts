/**
 * The prose guard's detector.
 *
 * Pure text in, violations out. It lives in `src/lib` because the panel previews what it
 * will flag and the Worker runs the same rules; a second copy on either side would drift.
 *
 * The checks are deliberately narrow. This is not a prose critic — a model judging prose
 * is the thing that failed in the first place. It catches the failures that are cheap to
 * see and were measured in a real chat: the stocked body beat, a reply that opens on the
 * previous reply's sentence, a narration sentence that chains three "and" clauses, and a
 * reply that ran past its own length setting. Anything subtler is left to the reader.
 */

export type GuardKind = 'banned' | 'opening' | 'andChain' | 'length';

export interface GuardViolation {
  kind: GuardKind;
  /** What fired, in the panel's words. */
  detail: string;
  /** The smallest useful excerpt, for the toast and the repair prompt. */
  snippet: string;
}

export interface GuardOptions {
  /** The reader's own additions, on top of `BANNED_BEATS`. */
  bans?: string[];
  /** The preceding assistant replies, newest first. Used for opening repetition. */
  previous?: string[];
  /**
   * Paragraph ceiling for the chat's length setting. `null` means no ceiling.
   * Deliberately slack: the setting says five paragraphs, a compliant six is not a bug.
   */
  maxParagraphs?: number | null;
}

/**
 * The stock beats measured across the live transcript. Kept literal: a pattern that fires
 * on `voice comes out` also fires on a character describing a voice, which is why the guard
 * only reads narration and never dialogue.
 */
export const BANNED_BEATS: string[] = [
  'jaw works',
  'throat works',
  'ears burn',
  'ears are burning',
  'voice comes out',
  'voice is wrecked',
  'face is doing the thing',
  'barely a breath',
  'eyes half-closed',
  'breath catches',
  'breath catching',
  'breath hitching',
  'pupil dilation',
  'pupils dilate',
  'desk lamp hums',
  'kettle fogs',
  'something shifted in',
  'the air was thick with',
  'ozone',
];

export interface DialogueSplit {
  /** The reply with quoted speech and digital text blanked out. */
  narration: string;
  /** Every quoted line and `**name**:` message, in order. */
  dialogue: string[];
}

/**
 * Split a reply into narration and dialogue.
 *
 * Quote-aware rather than regex-only, because a naive `"[^"]*"` breaks on the apostrophe
 * inside a line and on a quote that never closes. Curly quotes count. Backticked text is
 * treated as dialogue too: in this app it is a phone message, not prose.
 */
export function splitDialogue(content: string): DialogueSplit {
  const dialogue: string[] = [];
  let narration = '';
  let i = 0;

  while (i < content.length) {
    const ch = content[i];
    if (ch === '"' || ch === '\u201c') {
      const close = ch === '\u201c' ? '\u201d' : '"';
      let j = i + 1;
      while (j < content.length && content[j] !== close) j += 1;
      if (j < content.length) {
        dialogue.push(content.slice(i + 1, j));
        narration += ' '.repeat(j - i + 1);
        i = j + 1;
        continue;
      }
    }
    if (ch === '`') {
      const j = content.indexOf('`', i + 1);
      if (j !== -1) {
        dialogue.push(content.slice(i + 1, j));
        narration += ' '.repeat(j - i + 1);
        i = j + 1;
        continue;
      }
    }
    narration += ch;
    i += 1;
  }

  // A digital-text line is one speaker's message, not narration. Masking the whole line
  // also keeps its lowercase texting style out of the sentence checks.
  const masked = narration.split('\n').map((line) => {
    if (/^\s*\*\*[^*\n]+\*\*:/.test(line)) {
      dialogue.push(line.replace(/^\s*\*\*[^*\n]+\*\*:\s*/, ''));
      return ' '.repeat(line.length);
    }
    return line;
  });

  return { narration: masked.join('\n'), dialogue };
}

/** The first sentence, or `''` when the reply opens on dialogue or a thought. */
export function firstSentence(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return '';
  if (trimmed[0] === '"' || trimmed[0] === '\u201c' || trimmed[0] === '*') return '';

  let inQuote = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '"' || ch === '\u201c' || ch === '\u201d') inQuote = !inQuote;
    if (ch === '\n') return trimmed.slice(0, i);
    if (!inQuote && (ch === '.' || ch === '!' || ch === '?') && /^(\s|$)/.test(trimmed.slice(i + 1))) {
      return trimmed.slice(0, i + 1);
    }
  }
  return trimmed;
}

function shingles(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) out.push(words.slice(i, i + size).join(' '));
  return out;
}

/**
 * Every rule the guard can fire, in the order the panel lists them.
 *
 * `previous` is the preceding assistant replies on the visible path, newest first. The
 * opening check compares the first sentence's 4-word shingles against theirs, which is how
 * "Her hips keep slamming down, ass hitting his thighs" is caught against the reply that
 * already said it. Four words is the shortest phrase that survives as a signature; two or
 * three would fire on "in the dark" and teach the reader to ignore the badge.
 */
export function detectViolations(content: string, options: GuardOptions = {}): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const { narration } = splitDialogue(content);
  const lowerNarration = narration.toLowerCase();

  const bans = [...BANNED_BEATS, ...(options.bans ?? [])]
    .map((ban) => ban.trim().toLowerCase())
    .filter((ban) => ban.length >= 3);
  const seen = new Set<string>();
  for (const ban of bans) {
    if (seen.has(ban) || !lowerNarration.includes(ban)) continue;
    seen.add(ban);
    violations.push({ kind: 'banned', detail: `stock beat: "${ban}"`, snippet: ban });
  }

  const first = firstSentence(content);
  const firstWords = first.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (firstWords.length >= 4) {
    const mine = new Set(shingles(firstWords, 4));
    for (const previous of options.previous ?? []) {
      const prevWords = firstSentence(previous).toLowerCase().match(/[a-z0-9']+/g) ?? [];
      if (prevWords.length < 4) continue;
      const shared = shingles(prevWords, 4).find((shingle) => mine.has(shingle));
      if (shared) {
        violations.push({
          kind: 'opening',
          detail: `opens on the previous reply's phrase: "${shared}"`,
          snippet: first.slice(0, 160),
        });
        break;
      }
    }
  }

  for (const sentence of narration
    .split(/(?<=[.!?])\s+|\n+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)) {
    const count = (sentence.match(/\band\b/gi) ?? []).length;
    if (count >= 3) {
      violations.push({
        kind: 'andChain',
        detail: `${count} "and" clauses in one narration sentence`,
        snippet: sentence.slice(0, 160),
      });
    }
  }

  if (options.maxParagraphs != null) {
    const paragraphs = content
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);
    if (paragraphs.length > options.maxParagraphs) {
      violations.push({
        kind: 'length',
        detail: `${paragraphs.length} paragraphs against a ceiling of ${options.maxParagraphs}`,
        snippet: `${paragraphs.length} paragraphs`,
      });
    }
  }

  return violations;
}

/**
 * Whether a repair preserved every line of dialogue.
 *
 * The repair prompt says to change only narration, but a model asked to rewrite prose will
 * paraphrase a line and call it preserved. This is the check that rejects that: every
 * original line must still be present, in the same order, with its words intact. A repair
 * that merges two lines is rejected even if the meaning survived — the reader liked the
 * dialogue, and silent edits to it are the one thing this feature must not do.
 */
export function preservesDialogue(original: string, repaired: string): boolean {
  const before = splitDialogue(original).dialogue
    .map((line) => line.replace(/\s+/g, ' ').replace(/^[\s"\u201c\u201d]+|[\s"\u201c\u201d]+$/g, '').trim())
    .filter((line) => line.length > 0);
  const after = splitDialogue(repaired).dialogue
    .map((line) => line.replace(/\s+/g, ' ').replace(/^[\s"\u201c\u201d]+|[\s"\u201c\u201d]+$/g, '').trim())
    .filter((line) => line.length > 0);
  if (before.length !== after.length) return false;
  return before.every((line, index) => line === after[index]);
}

const STOP_WORDS: Record<string, true> = Object.fromEntries(
  [
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'her',
    'his', 'she', 'he', 'it', 'its', 'was', 'were', 'is', 'are', 'that', 'this', 'as', 'by',
    'from', 'into', 'then', 'so', 'if', 'not', 'no', 'yes', 'up', 'down', 'out', 'off',
  ].map((word) => [word, true] as const),
);

/**
 * What to learn from a hand edit.
 *
 * Not a diff. A reader deletes whole paragraphs for story reasons, and teaching those to
 * the guard would ban the plot. A phrase is learned only when it is a known stock beat, or
 * when it repeats inside the deleted narration — the two signals that separate a tic from
 * a choice. At most three per edit, so one unusual edit cannot flood the list.
 */
export function learnFromEdit(before: string, after: string): string[] {
  const beforeNarration = splitDialogue(before).narration.toLowerCase();
  const afterNarration = splitDialogue(after).narration.toLowerCase();
  const learned: string[] = [];

  for (const ban of BANNED_BEATS) {
    if (beforeNarration.includes(ban) && !afterNarration.includes(ban)) learned.push(ban);
  }

  const words = beforeNarration.match(/[a-z']+/g) ?? [];
  const counts = new Map<string, number>();
  for (let size = 3; size <= 5; size += 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const phrase = words.slice(i, i + size).join(' ');
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  const repeated = [...counts.entries()]
    .filter(([phrase, count]) => count >= 2 && !afterNarration.includes(phrase))
    .sort((a, b) => b[0].length - a[0].length);

  for (const [phrase] of repeated) {
    if (learned.some((entry) => entry.includes(phrase) || phrase.includes(entry))) continue;
    if (phrase.split(' ').every((word) => STOP_WORDS[word] === true)) continue;
    learned.push(phrase);
    if (learned.length >= 3) break;
  }

  return [...new Set(learned)].slice(0, 3);
}
