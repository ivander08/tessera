import { describe, expect, test } from 'bun:test';
import { partialField } from './partial';

/**
 * The incremental scanner, which exists so the endpoint can show the `say` field while the
 * model is still writing it. The input is a half-written JSON document, so the cases that
 * matter are all about being cut off mid-token rather than about well-formed JSON.
 */
describe('partialField', () => {
  test('returns null before the field has started', () => {
    expect(partialField('{"sa', 'say')).toBeNull();
    expect(partialField('{"say"', 'say')).toBeNull();
    expect(partialField('{"say":', 'say')).toBeNull();
    expect(partialField('{"say": ', 'say')).toBeNull();
    expect(partialField('{"other":"x","say":"y"}', 'other')).toBe('x');
  });

  test('returns the empty string once the field has opened', () => {
    expect(partialField('{"say":"', 'say')).toBe('');
    expect(partialField('{"say": ""', 'say')).toBe('');
  });

  test('returns the decoded prefix while the string is open', () => {
    expect(partialField('{"say":"Hello the', 'say')).toBe('Hello the');
    expect(partialField('{"say":"Hello there."', 'say')).toBe('Hello there.');
    expect(partialField('{"say":"Hello there.","question":null}', 'say')).toBe('Hello there.');
  });

  test('decodes the simple escapes', () => {
    expect(partialField('{"say":"a\\nb\\tc\\"d\\\\e', 'say')).toBe('a\nb\tc"d\\e');
    expect(partialField('{"say":"a\\/b\\rc\\fd\\be', 'say')).toBe('a/b\rc\fd\be');
  });

  test('a buffer cut inside a \\u escape returns the prefix and does not throw', () => {
    // The case this whole function exists for. A slice-and-parse implementation would
    // throw here and lose the visible prefix, which reads as the stream stuttering
    // backwards.
    const full = '{"say":"caf\\u00e9 and more';
    const valueStart = full.indexOf('"', full.indexOf('"say"') + 5) + 1;
    for (let cut = valueStart; cut <= full.length; cut++) {
      const prefix = partialField(full.slice(0, cut), 'say');
      expect(prefix).not.toBeNull();
      expect('café and more').toContain(prefix as string);
    }

    expect(partialField('{"say":"caf\\u00e9', 'say')).toBe('café');
    expect(partialField('{"say":"caf\\u00e', 'say')).toBe('caf');
    expect(partialField('{"say":"caf\\u00', 'say')).toBe('caf');
    expect(partialField('{"say":"caf\\u0', 'say')).toBe('caf');
    expect(partialField('{"say":"caf\\u', 'say')).toBe('caf');
    expect(partialField('{"say":"caf\\', 'say')).toBe('caf');
  });

  test('rejects a \\u escape that is not hex rather than decoding nonsense', () => {
    expect(partialField('{"say":"a\\uZZZZb', 'say')).toBe('a');
  });

  test('stops at an unknown escape rather than guessing', () => {
    // Showing text the model never wrote is worse than showing less of it.
    expect(partialField('{"say":"a\\qb', 'say')).toBe('a');
  });

  test('stops at the closing quote and ignores what follows', () => {
    expect(partialField('{"say":"one","card":{"say":"two"}', 'say')).toBe('one');
  });

  test('a field whose value is not a string yields null', () => {
    expect(partialField('{"say":null', 'say')).toBeNull();
    expect(partialField('{"say":123', 'say')).toBeNull();
    expect(partialField('{"say":{"nested":"x"', 'say')).toBeNull();
  });

  test('returns null for a field that is absent entirely', () => {
    expect(partialField('{"question":null,"card":null}', 'say')).toBeNull();
    expect(partialField('', 'say')).toBeNull();
  });

  test('is monotone: a longer buffer never yields a shorter prefix', () => {
    // The endpoint emits a delta only when the prefix GROWS, so a shrink would be a
    // visible stutter. Walking every prefix of a document is the cheapest way to prove
    // there is no such case.
    const document = JSON.stringify({
      say: 'Line one.\nLine two — with an em dash, "quotes", a backslash \\ and é.',
      question: null,
      card: null,
    });

    let longest = '';
    for (let cut = 1; cut <= document.length; cut++) {
      const prefix = partialField(document.slice(0, cut), 'say');
      if (prefix === null) continue;
      expect(prefix.length).toBeGreaterThanOrEqual(longest.length);
      expect(prefix.startsWith(longest)).toBe(true);
      longest = prefix;
    }

    expect(longest).toBe(
      'Line one.\nLine two — with an em dash, "quotes", a backslash \\ and é.',
    );
  });
});
