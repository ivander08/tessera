/**
 * A line diff with character columns, for showing what the consultant changed.
 *
 * `git diff` output is the right mental model: lines that stayed, lines that went, lines that
 * arrived — and, for a line that was edited rather than replaced, WHERE in the line the edit
 * landed. That last part is the one a reader actually wants when the change is one word in a
 * paragraph, and it is what a plain before/after pair cannot show.
 *
 * ## Why not a character-level LCS
 *
 * A real diff algorithm over characters is O(n·m): two 4 KB paragraphs is 16 million cells,
 * for a field the reader will scan in two seconds. Trimming the common prefix and suffix
 * gives the same answer for every edit a model actually makes — one span, where the change
 * starts and ends — at O(n). A model rewriting a paragraph mid-sentence is exactly the case
 * this handles, and a model interleaving two edits into one line is not.
 *
 * Lines DO get an LCS, because a paragraph is short in lines and the alternative — treating
 * a one-line insertion as "everything after it changed" — is the failure that makes a diff
 * useless.
 */

/** The columns that differ within one edited line, in both versions. */
export interface CharSpan {
  /** 0-based column in the old line where the change starts. */
  beforeStart: number;
  /** Exclusive end column in the old line. */
  beforeEnd: number;
  /** 0-based column in the new line where the change starts. */
  afterStart: number;
  /** Exclusive end column in the new line. */
  afterEnd: number;
}

export type DiffKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffKind;
  /** 1-based line number in the old text, or null for a line that only exists in the new. */
  beforeLine: number | null;
  /** 1-based line number in the new text, or null for a line that only exists in the old. */
  afterLine: number | null;
  text: string;
  /**
   * Set on a `context` line that was edited in place: the paired old and new line are the
   * same line, so it is shown once with the changed columns marked.
   */
  span?: CharSpan;
  /** The line this one replaced, when `span` is set. */
  replaced?: string;
}

/** A run of changes with the unchanged lines around it. */
export interface DiffHunk {
  lines: DiffLine[];
}

export interface TextDiff {
  hunks: DiffHunk[];
  /** Lines added across the whole text. */
  added: number;
  /** Lines removed across the whole text. */
  removed: number;
  /** True when any line was edited in place rather than added or removed. */
  edited: boolean;
}

/**
 * How many unchanged lines to keep around a change.
 *
 * Three matches `git diff -U3`: enough that a hunk is readable on its own without burying
 * the change in a wall of unchanged prose.
 */
const CONTEXT = 3;

/**
 * Beyond this many lines on either side, the line LCS is skipped and the whole text is
 * reported as replaced.
 *
 * The LCS is O(n·m) in cells. 2000 lines is 4 million cells — a few milliseconds and 16 MB of
 * Int32Array at worst, which is the point at which a diff stops being worth its cost for a
 * text field. Nothing a character card holds comes close; this is a guard, not a limit anyone
 * will meet.
 */
const MAX_LCS_LINES = 2000;

/** Splits into lines without inventing a trailing empty one for a trailing newline. */
function toLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The length of the longest common prefix of two strings. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let at = 0;
  while (at < max && a[at] === b[at]) at++;
  return at;
}

/** The length of the longest common suffix of two strings, not overlapping the prefix. */
export function commonSuffixLength(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let at = 0;
  while (at < max && a[a.length - 1 - at] === b[b.length - 1 - at]) at++;
  return at;
}

/**
 * Where two versions of one line differ, by column.
 *
 * Returns null when the lines are identical. The span is the trimmed middle: everything
 * before `beforeStart` and after `beforeEnd` is byte-identical, which is what lets a caller
 * highlight exactly the columns that changed rather than the whole line.
 */
export function diffChars(before: string, after: string): CharSpan | null {
  if (before === after) return null;

  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);

  return {
    beforeStart: prefix,
    beforeEnd: before.length - suffix,
    afterStart: prefix,
    afterEnd: after.length - suffix,
  };
}

type Step = { kind: 'equal' | 'remove' | 'add'; before?: number; after?: number };

/**
 * The line-level edit script, by longest common subsequence.
 *
 * The DP table is a flat `Int32Array` rather than an array of arrays: the row-by-row
 * backtrack is the hot path and a nested array allocates one object per cell.
 */
function lineScript(before: string[], after: string[]): Step[] {
  const n = before.length;
  const m = after.length;

  // `table[i * (m + 1) + j]` is the LCS length of `before[i..]` and `after[j..]`.
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      steps.push({ kind: 'equal', before: i, after: j });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      steps.push({ kind: 'remove', before: i });
      i++;
    } else {
      steps.push({ kind: 'add', after: j });
      j++;
    }
  }
  while (i < n) steps.push({ kind: 'remove', before: i++ });
  while (j < m) steps.push({ kind: 'add', after: j++ });

  return steps;
}

/**
 * Pairs a run of removals with the run of additions that replaced them, so a line edited in
 * place reads as one edited line rather than a deletion plus an unrelated insertion.
 *
 * This is what `git diff` does not do and a word-level diff does, and it is the whole reason
 * this module exists: "the word `tide` became `tides` at column 42" is the answer the reader
 * wants, and it is invisible in an add/remove pair.
 */
function pairRun(removed: number[], added: number[], before: string[], after: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  const paired = Math.min(removed.length, added.length);

  for (let k = 0; k < paired; k++) {
    const oldIndex = removed[k];
    const newIndex = added[k];
    const span = diffChars(before[oldIndex], after[newIndex]);
    if (!span) {
      lines.push({
        kind: 'context',
        beforeLine: oldIndex + 1,
        afterLine: newIndex + 1,
        text: after[newIndex],
      });
      continue;
    }
    lines.push({
      kind: 'context',
      beforeLine: oldIndex + 1,
      afterLine: newIndex + 1,
      text: after[newIndex],
      replaced: before[oldIndex],
      span,
    });
  }

  // Anything past the shorter run is a real insertion or deletion.
  for (let k = paired; k < removed.length; k++) {
    lines.push({
      kind: 'remove',
      beforeLine: removed[k] + 1,
      afterLine: null,
      text: before[removed[k]],
    });
  }
  for (let k = paired; k < added.length; k++) {
    lines.push({
      kind: 'add',
      beforeLine: null,
      afterLine: added[k] + 1,
      text: after[added[k]],
    });
  }

  return lines;
}

/** The full edit script, with paired runs collapsed into edited lines. */
function editLines(before: string[], after: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  const steps = lineScript(before, after);

  let at = 0;
  while (at < steps.length) {
    const step = steps[at];

    if (step.kind === 'equal') {
      out.push({
        kind: 'context',
        beforeLine: step.before! + 1,
        afterLine: step.after! + 1,
        text: before[step.before!],
      });
      at++;
      continue;
    }

    // Collect the whole remove-run and add-run. In this script the two interleave, so both
    // are gathered until the next `equal`.
    const removed: number[] = [];
    const added: number[] = [];
    while (at < steps.length && steps[at].kind !== 'equal') {
      const current = steps[at];
      if (current.kind === 'remove') removed.push(current.before!);
      else added.push(current.after!);
      at++;
    }
    out.push(...pairRun(removed, added, before, after));
  }

  return out;
}

/** Groups the edit script into hunks with `CONTEXT` unchanged lines around each change. */
function toHunks(lines: DiffLine[]): DiffHunk[] {
  const changed = lines.map((line) => line.kind !== 'context' || line.span !== undefined);
  const hunks: DiffHunk[] = [];

  let at = 0;
  while (at < lines.length) {
    if (!changed[at]) {
      at++;
      continue;
    }

    let start = at;
    for (let back = 0; back < CONTEXT && start > 0 && !changed[start - 1]; back++) start--;

    let end = at;
    // Walk forward over this change, any nearby change, and the context between them.
    for (;;) {
      while (end + 1 < lines.length && changed[end + 1]) end++;
      // Peek past the context: a change within 2*CONTEXT lines belongs in the same hunk.
      let peek = end + 1;
      let gap = 0;
      while (peek < lines.length && !changed[peek] && gap <= CONTEXT * 2) {
        peek++;
        gap++;
      }
      if (peek < lines.length && changed[peek]) {
        end = peek;
        continue;
      }
      break;
    }

    let stop = end;
    for (let forward = 0; forward < CONTEXT && stop + 1 < lines.length && !changed[stop + 1]; forward++) {
      stop++;
    }

    hunks.push({ lines: lines.slice(start, stop + 1) });
    at = stop + 1;
  }

  return hunks;
}

/**
 * Diffs two texts by line, with the changed columns within each edited line.
 *
 * An empty `before` is a pure addition and an empty `after` a pure deletion; both produce a
 * single hunk, which is what a reader expects from "this field was blank and now it is not".
 */
export function diffText(before: string, after: string): TextDiff {
  if (before === after) return { hunks: [], added: 0, removed: 0, edited: false };

  const beforeLines = toLines(before);
  const afterLines = toLines(after);

  // Too large for the line LCS: report the whole thing as replaced rather than spending the
  // time, and let the caller fall back to a before/after pair.
  if (beforeLines.length > MAX_LCS_LINES || afterLines.length > MAX_LCS_LINES) {
    return {
      hunks: [
        {
          lines: [
            ...beforeLines.map<DiffLine>((text, index) => ({
              kind: 'remove',
              beforeLine: index + 1,
              afterLine: null,
              text,
            })),
            ...afterLines.map<DiffLine>((text, index) => ({
              kind: 'add',
              beforeLine: null,
              afterLine: index + 1,
              text,
            })),
          ],
        },
      ],
      added: afterLines.length,
      removed: beforeLines.length,
      edited: false,
    };
  }

  const lines = editLines(beforeLines, afterLines);

  return {
    hunks: toHunks(lines),
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'remove').length,
    edited: lines.some((line) => line.span !== undefined),
  };
}

/** True when there is nothing to show: no added, removed or edited line. */
export function isEmptyDiff(diff: TextDiff): boolean {
  return diff.hunks.length === 0;
}

/** A one-line summary in the shape of `git diff --stat`. */
export function summarizeDiff(diff: TextDiff): string {
  if (isEmptyDiff(diff)) return 'unchanged';
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`${diff.added} added`);
  if (diff.removed > 0) parts.push(`${diff.removed} removed`);
  if (diff.edited) parts.push('edited in place');
  return parts.join(' · ');
}
