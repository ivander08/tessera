import { describe, expect, test } from 'bun:test';
import { diffChars, diffText, isEmptyDiff, summarizeDiff } from './diff';

/**
 * The diff the consultant's proposal is shown through.
 *
 * The assertions are on what a READER sees — which lines were added, removed, and which
 * columns of an edited line changed — because that is the whole contract. A diff that is
 * technically correct but reports a one-word edit as a replaced paragraph has failed.
 */

/** The changed columns of the first edited line, as the reader would see them. */
function firstSpan(before: string, after: string) {
  const diff = diffText(before, after);
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.span) return { span: line.span, line, replaced: line.replaced };
    }
  }
  return null;
}

describe('diffChars', () => {
  test('an identical pair has no span', () => {
    expect(diffChars('the tide is out', 'the tide is out')).toBeNull();
  });

  test('finds the columns of a one-word edit', () => {
    // `tide` -> `tides` is an insertion of `s` at column 8, which is the tightest span that
    // covers the change: everything before it and after it is byte-identical.
    const span = diffChars('the tide is out', 'the tides is out');
    expect(span).toEqual({ beforeStart: 8, beforeEnd: 8, afterStart: 8, afterEnd: 9 });
  });

  test('a replaced word spans the word, not the line', () => {
    // `tide` -> `wave` shares its trailing `e`, so the minimal span is `tid` -> `wav`.
    const span = diffChars('the tide is out', 'the wave is out');
    expect(span).toEqual({ beforeStart: 4, beforeEnd: 7, afterStart: 4, afterEnd: 7 });
  });

  test('a pure insertion has an empty old span', () => {
    const span = diffChars('ab', 'axb');
    expect(span).toEqual({ beforeStart: 1, beforeEnd: 1, afterStart: 1, afterEnd: 2 });
  });

  test('a pure deletion has an empty new span', () => {
    const span = diffChars('axb', 'ab');
    expect(span).toEqual({ beforeStart: 1, beforeEnd: 2, afterStart: 1, afterEnd: 1 });
  });

  test('a completely different line spans the whole thing', () => {
    const span = diffChars('abc', 'xyz');
    expect(span).toEqual({ beforeStart: 0, beforeEnd: 3, afterStart: 0, afterEnd: 3 });
  });

  test('an empty old line marks the whole new line', () => {
    const span = diffChars('', 'hello');
    expect(span).toEqual({ beforeStart: 0, beforeEnd: 0, afterStart: 0, afterEnd: 5 });
  });

  test('an edit at the very end does not eat the prefix', () => {
    const span = diffChars('the light', 'the lights');
    expect(span).toEqual({ beforeStart: 9, beforeEnd: 9, afterStart: 9, afterEnd: 10 });
  });
});

describe('diffText', () => {
  test('identical text produces nothing', () => {
    const diff = diffText('one\ntwo', 'one\ntwo');
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.edited).toBe(false);
  });

  test('an appended line is an addition, not a rewrite', () => {
    // The failure this prevents: reporting the whole paragraph as changed because a line
    // arrived at the end.
    const diff = diffText('one\ntwo', 'one\ntwo\nthree');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    const kinds = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
    expect(kinds).toEqual(['context:one', 'context:two', 'add:three']);
  });

  test('a removed line is a removal', () => {
    const diff = diffText('one\ntwo\nthree', 'one\nthree');
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(1);
    const kinds = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind));
    expect(kinds).toEqual(['context', 'remove', 'context']);
  });

  test('an edited line is one line with a span, not an add plus a remove', () => {
    // The core promise: a word changed inside a paragraph reads as that word changing.
    const found = firstSpan('The tide is out.', 'The tides are out.');
    expect(found).not.toBeNull();
    expect(found!.replaced).toBe('The tide is out.');
    expect(found!.line.text).toBe('The tides are out.');
    expect(found!.line.kind).toBe('context');
    // "The tide is out." -> "The tides are out." is ` is` becoming `s are` at column 8,
    // which is the tightest span: `The tide` and ` out.` are byte-identical.
    expect(found!.span).toEqual({ beforeStart: 8, beforeEnd: 11, afterStart: 8, afterEnd: 13 });
  });

  test('marks the whole text edited when every line differs', () => {
    const diff = diffText('a\nb', 'x\ny');
    expect(diff.edited).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  test('an insertion in the middle does not report the tail as changed', () => {
    const diff = diffText('one\ntwo\nthree\nfour', 'one\ntwo\nINSERTED\nthree\nfour');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.edited).toBe(false);
    expect(diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add')).toHaveLength(1);
  });

  test('an addition and a deletion in the same run are paired as an edit', () => {
    const diff = diffText('keep\nold line\nkeep', 'keep\nnew line\nkeep');
    expect(diff.edited).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  test('an uneven run keeps the leftovers as a real add or remove', () => {
    const diff = diffText('a\nb\nc', 'a\nX');
    // `b` pairs with `X`; `c` is genuinely removed.
    expect(diff.removed).toBe(1);
    expect(diff.edited).toBe(true);
  });

  test('empty to text is a pure addition', () => {
    const diff = diffText('', 'first\nsecond');
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
    expect(diff.hunks).toHaveLength(1);
  });

  test('text to empty is a pure removal', () => {
    const diff = diffText('first\nsecond', '');
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(2);
  });

  test('a trailing newline does not invent an empty final line', () => {
    const diff = diffText('one\ntwo\n', 'one\ntwo');
    expect(isEmptyDiff(diff)).toBe(true);
  });

  test('line numbers are 1-based and track each side', () => {
    const diff = diffText('one\ntwo', 'one\nNEW\ntwo');
    const lines = diff.hunks.flatMap((hunk) => hunk.lines);
    const added = lines.find((line) => line.kind === 'add');
    expect(added?.beforeLine).toBeNull();
    expect(added?.afterLine).toBe(2);
    const context = lines.find((line) => line.kind === 'context' && line.text === 'two');
    expect(context?.beforeLine).toBe(2);
    expect(context?.afterLine).toBe(3);
  });

  test('keeps unchanged lines around a change so the hunk is readable', () => {
    const before = ['a', 'b', 'c', 'd', 'TARGET', 'f', 'g', 'h', 'i'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'CHANGED', 'f', 'g', 'h', 'i'].join('\n');
    const diff = diffText(before, after);
    const texts = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
    expect(texts).toContain('b');
    expect(texts).toContain('h');
    // ...but not the whole text: a hunk is a window, not the file.
    expect(texts).not.toContain('a');
    expect(texts).not.toContain('i');
  });

  test('splits distant changes into separate hunks', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[2] = 'changed early';
    after[35] = 'changed late';
    const diff = diffText(before.join('\n'), after.join('\n'));
    expect(diff.hunks.length).toBe(2);
  });

  test('a long text still diffs without the guard tripping', () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 250', 'line 250 changed');
    const diff = diffText(before, after);
    expect(diff.edited).toBe(true);
    expect(diff.hunks.length).toBe(1);
  });

  test('an edit on a single line with no newline is still a span', () => {
    const found = firstSpan('a lone line', 'a single line');
    expect(found!.line.kind).toBe('context');
    expect(found!.span).not.toBeNull();
  });
});

describe('summarizeDiff', () => {
  test('names what changed', () => {
    expect(summarizeDiff(diffText('a', 'a\nb'))).toBe('1 added');
    expect(summarizeDiff(diffText('a\nb', 'a'))).toBe('1 removed');
    expect(summarizeDiff(diffText('old', 'new'))).toBe('edited in place');
    expect(summarizeDiff(diffText('same', 'same'))).toBe('unchanged');
  });
});
