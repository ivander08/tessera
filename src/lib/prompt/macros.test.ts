import { describe, expect, test } from 'bun:test';
import { dynamicMacrosIn, hasDynamicMacro, substituteHead, substituteTail } from './macros';

const ctx = { char: 'Ada', user: 'Ivan', persona: 'Ivan', now: new Date('2026-05-11T08:15:00Z') };

describe('substituteHead', () => {
  test('replaces the fixed macros', () => {
    expect(substituteHead('{{char}} looked at {{user}}.', ctx)).toBe('Ada looked at Ivan.');
  });

  test('tolerates whitespace inside the braces', () => {
    expect(substituteHead('{{ char }} and {{  user  }}', ctx)).toBe('Ada and Ivan');
  });

  test('is case-insensitive', () => {
    expect(substituteHead('{{CHAR}}', ctx)).toBe('Ada');
  });

  test('substitutes every occurrence, not just the first', () => {
    expect(substituteHead('{{char}} {{char}} {{char}}', ctx)).toBe('Ada Ada Ada');
  });

  test('leaves unknown macros alone so a gap is visible rather than silent', () => {
    expect(substituteHead('roll {{roll:2d6}} now', ctx)).toBe('roll {{roll:2d6}} now');
  });

  test('leaves a single brace untouched', () => {
    expect(substituteHead('a { b } c', ctx)).toBe('a { b } c');
  });

  /**
   * The bug this pins: falling back to the pronoun "You" produced "She calls You by
   * name", which reads as a proper noun and made the model invent a name for the user.
   */
  test('leaves {{user}} visible when no persona is set', () => {
    expect(substituteHead('She calls {{user}} by name.', { char: 'Ada', user: null })).toBe(
      'She calls {{user}} by name.',
    );
  });

  test('still substitutes the character name without a persona', () => {
    expect(substituteHead('{{char}} waits.', { char: 'Ada', user: null })).toBe('Ada waits.');
  });

  test('falls back to the user name when no persona name is given', () => {
    expect(substituteHead('{{persona}}', { char: 'Ada', user: 'Ivan' })).toBe('Ivan');
  });

  test('uses the persona name when one is set', () => {
    expect(substituteHead('{{persona}}', { char: 'Ada', user: 'Ivan', persona: 'The Cartographer' })).toBe(
      'The Cartographer',
    );
  });

  /**
   * The property that makes head substitution safe at all: the same input must always
   * produce the same output, so the cached prefix stays byte-identical between turns.
   */
  test('is stable across calls, which is what keeps the prefix cacheable', () => {
    const text = '{{char}} met {{user}} at dawn.';
    expect(substituteHead(text, ctx)).toBe(substituteHead(text, ctx));
  });

  test('does NOT expand a dynamic macro', () => {
    // If this ever starts returning a timestamp, the cache dies every turn.
    expect(substituteHead('It is {{time}}.', ctx)).toBe('It is {{time}}.');
    expect(substituteHead('{{date}}', ctx)).toBe('{{date}}');
  });

  test('is a no-op on text with no macros, without copying unnecessarily', () => {
    const text = 'plain prose';
    expect(substituteHead(text, ctx)).toBe(text);
  });
});

describe('substituteTail', () => {
  test('expands fixed and dynamic macros', () => {
    const out = substituteTail('{{char}} at {{time}} on {{date}} ({{weekday}})', ctx);
    expect(out).toContain('Ada at');
    expect(out).not.toContain('{{');
  });

  test('still leaves unknown macros visible', () => {
    expect(substituteTail('{{char}} rolls {{roll:2d6}}', ctx)).toBe('Ada rolls {{roll:2d6}}');
  });
});

describe('dynamic macro detection', () => {
  test('flags a dynamic macro anywhere in a string', () => {
    expect(hasDynamicMacro('Current time: {{time}}')).toBe(true);
    expect(hasDynamicMacro('{{char}} is here')).toBe(false);
  });

  test('names the offending macros so the warning can be specific', () => {
    expect(dynamicMacrosIn('{{time}} and {{date}} and {{char}}')).toEqual(['time', 'date']);
  });

  test('reports each macro once', () => {
    expect(dynamicMacrosIn('{{time}} {{time}} {{time}}')).toEqual(['time']);
  });
});
