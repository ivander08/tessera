import { describe, expect, test } from 'bun:test';

import { applyScripts, parsePattern, placementForRole, scriptsFor } from './regexScripts';
import type { RegexScript } from './types';

/**
 * The preset regex half.
 *
 * The behaviour that matters is the TARGETING, not the matching: a script that runs on
 * the wrong side either mangles the prompt or leaves the reader looking at markup. Each
 * test below pins one of those decisions, and the `promptOnly`/`markdownOnly` pair is the
 * one a naive implementation gets wrong by treating them as a single flag.
 */

function script(patch: Partial<RegexScript> = {}): RegexScript {
  return { scriptName: 's', findRegex: '/x/g', replaceString: 'y', ...patch };
}

describe('parsePattern', () => {
  test('reads the body and flags out of ST’s /pattern/flags form', () => {
    const pattern = parsePattern('/foo/gi');
    expect(pattern).not.toBeNull();
    expect(pattern!.source).toBe('foo');
    expect(pattern!.flags).toContain('g');
    expect(pattern!.flags).toContain('i');
  });

  test('an escaped slash inside the pattern does not truncate it', () => {
    // The bug this guards: splitting on the FIRST `/` turns `a\/b` into the pattern `a`
    // with flags `\/b/`, which is both the wrong match and an invalid flag set.
    const pattern = parsePattern('/a\\/b/g');
    expect(pattern).not.toBeNull();
    expect(pattern!.source).toBe('a\\/b');
    expect(pattern!.test('a/b')).toBe(true);
  });

  test('a bare pattern with no delimiters is accepted', () => {
    const pattern = parsePattern('hello');
    expect(pattern).not.toBeNull();
    expect(pattern!.test('hello')).toBe(true);
  });

  test('global is added when the author omitted it, so replace hits every match', () => {
    const pattern = parsePattern('/x/');
    expect(pattern!.flags).toContain('g');
    expect('xxx'.replace(pattern!, 'y')).toBe('yyy');
  });

  test('an unknown flag is dropped rather than failing the whole pattern', () => {
    // `v` is a real JS flag in newer engines but not one this engine accepts; a preset
    // carrying it should still run.
    const pattern = parsePattern('/foo/gv');
    expect(pattern).not.toBeNull();
    expect(pattern!.test('foo')).toBe(true);
  });

  test('sticky is never honoured, because it changes replace into a one-shot', () => {
    const pattern = parsePattern('/x/gy');
    expect(pattern!.flags).not.toContain('y');
    expect('xx'.replace(pattern!, 'z')).toBe('zz');
  });

  test('an uncompilable pattern returns null instead of throwing', () => {
    expect(parsePattern('/(unclosed/g')).toBeNull();
    expect(parsePattern('')).toBeNull();
  });
});

describe('scriptsFor — the targeting axes', () => {
  test('neither flag set means both sides', () => {
    const s = [script()];
    expect(scriptsFor(s, 'prompt', 2, null)).toHaveLength(1);
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(1);
  });

  test('promptOnly runs on the prompt and not on the display', () => {
    const s = [script({ promptOnly: true })];
    expect(scriptsFor(s, 'prompt', 2, null)).toHaveLength(1);
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(0);
  });

  test('markdownOnly runs on the display and not on the prompt', () => {
    // The mirror of the above, and the case a single `promptOnly` flag cannot express.
    const s = [script({ markdownOnly: true })];
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(1);
    expect(scriptsFor(s, 'prompt', 2, null)).toHaveLength(0);
  });

  test('a disabled script is never in scope, on either side', () => {
    const s = [script({ disabled: true })];
    expect(scriptsFor(s, 'prompt', 2, null)).toHaveLength(0);
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(0);
  });

  test('placement separates the reader’s message from the model’s output', () => {
    const s = [script({ placement: [2] })];
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(1);
    expect(scriptsFor(s, 'display', 1, null)).toHaveLength(0);
  });

  test('a script targeting both placements runs on both', () => {
    const s = [script({ placement: [1, 2] })];
    expect(scriptsFor(s, 'display', 1, null)).toHaveLength(1);
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(1);
  });

  test('an absent placement means AI output, not nothing', () => {
    // Every script that predates the field targets the reply. Reading absent as "neither"
    // would silently disable half of an older preset.
    const s = [script({ placement: undefined })];
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(1);
    expect(scriptsFor(s, 'display', 1, null)).toHaveLength(0);
  });

  test('minDepth and maxDepth bound a script by distance from the end', () => {
    const s = [script({ minDepth: 2, maxDepth: 4 })];
    expect(scriptsFor(s, 'display', 2, 1)).toHaveLength(0);
    expect(scriptsFor(s, 'display', 2, 3)).toHaveLength(1);
    expect(scriptsFor(s, 'display', 2, 9)).toHaveLength(0);
  });

  test('depth is not filtered when the caller has no depth', () => {
    const s = [script({ minDepth: 99 })];
    expect(scriptsFor(s, 'display', 2, null)).toHaveLength(1);
  });
});

describe('applyScripts', () => {
  test('runs scripts in list order, because a preset’s pipeline depends on it', () => {
    // The second script matches what the first one produced. Reordering breaks it.
    const scripts = [
      script({ findRegex: '/<b>(.+?)<\\/b>/g', replaceString: '[$1]' }),
      script({ findRegex: '/\\[(.+?)\\]/g', replaceString: '$1' }),
    ];
    expect(applyScripts('a <b>bold</b> c', scripts, 'display')).toBe('a bold c');
  });

  test('a throwing script is skipped and the rest still run', () => {
    const scripts = [
      script({ findRegex: '/(?<a>x)/g', replaceString: '$<missing>' }),
      script({ findRegex: '/kept/g', replaceString: 'KEPT' }),
    ];
    // The first may or may not throw depending on the engine; the assertion is that the
    // second one ran either way.
    expect(applyScripts('x kept', scripts, 'display')).toContain('KEPT');
  });

  test('{{match}} is translated to the whole match', () => {
    const scripts = [script({ findRegex: '/\\d+/g', replaceString: '<n>{{match}}</n>' })];
    expect(applyScripts('see 42', scripts, 'display')).toBe('see <n>42</n>');
  });

  test('the CoT strip removes the reasoning block a preset asked for', () => {
    // The real script from the Douyin preset, and the exact leak it exists to prevent.
    const cot = script({
      findRegex:
        '/^[\\s\\S]*?(?:\\n|^)[ \\t]*(?:[-*]+[ \\t]*)?\\**Scene\\**[: ][\\s\\S]*?(?:\\n|^)[ \\t]*(?:[-*]+[ \\t]*)(?:\\**Done\\**\\.?|\\**Open\\**:.*)[ \\t]*(?:\\r?\\n|$)/',
      replaceString: '',
      placement: [2],
    });
    const leaked = '---\n- Scene: the flat, late\n- Mode: realism\n- Done.\nThe door clicks shut.';
    const cleaned = applyScripts(leaked, [cot], 'display');
    expect(cleaned).not.toContain('Scene:');
    expect(cleaned).toContain('The door clicks shut.');
  });

  test('an empty script list is a no-op', () => {
    expect(applyScripts('unchanged', [], 'display')).toBe('unchanged');
  });

  test('empty text is a no-op rather than a match against nothing', () => {
    const scripts = [script({ findRegex: '/^/g', replaceString: 'X' })];
    expect(applyScripts('', scripts, 'display')).toBe('');
  });

  test('oversized text is left alone, so a pathological pattern cannot burn the request', () => {
    const scripts = [script({ findRegex: '/x/g', replaceString: 'y' })];
    const huge = 'x'.repeat(250_000);
    expect(applyScripts(huge, scripts, 'display')).toBe(huge);
  });

  test('a promptOnly script does not alter what the reader sees', () => {
    const scripts = [script({ findRegex: '/secret/g', replaceString: 'REDACTED', promptOnly: true })];
    expect(applyScripts('the secret', scripts, 'display')).toBe('the secret');
    expect(applyScripts('the secret', scripts, 'prompt')).toBe('the REDACTED');
  });
});

describe('placementForRole', () => {
  test('the reader’s rows are placement 1 and everything else is 2', () => {
    expect(placementForRole('user')).toBe(1);
    expect(placementForRole('assistant')).toBe(2);
    expect(placementForRole('system')).toBe(2);
  });
});
