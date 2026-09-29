import { describe, expect, test } from 'bun:test';
import { DEFAULT_PRESET_CONFIG, parsePresetConfig } from './presetConfig';

/**
 * A stored preset config is untrusted input: it may have been written by an older build,
 * hand-edited in D1, or carried by an imported preset that used a different shape. The
 * contract is that `parsePresetConfig` always returns a usable, complete config — the
 * editor renders whatever comes out, and a chat's generation budget is taken from it.
 *
 * So the tests below check the two things that actually matter at those call sites:
 * numbers land inside their bounds, and every field falls back independently.
 */

describe('parsePresetConfig — absent input', () => {
  test('null, undefined and empty string all yield the defaults', () => {
    for (const raw of [null, undefined, '']) {
      expect(parsePresetConfig(raw)).toEqual(DEFAULT_PRESET_CONFIG);
    }
  });

  test('unparseable JSON and a non-object document yield the defaults rather than throwing', () => {
    // A row like this must not make the preset editor unreachable.
    expect(() => parsePresetConfig('{ not json')).not.toThrow();
    expect(parsePresetConfig('{ not json')).toEqual(DEFAULT_PRESET_CONFIG);
    expect(parsePresetConfig('[1,2,3]')).toEqual(DEFAULT_PRESET_CONFIG);
    expect(parsePresetConfig('"a string"')).toEqual(DEFAULT_PRESET_CONFIG);
    expect(parsePresetConfig('42')).toEqual(DEFAULT_PRESET_CONFIG);
  });

  test('the returned defaults do not share their stop list with the exported constant', () => {
    // A caller that pushes into the result must not mutate the module's default.
    const parsed = parsePresetConfig(null);
    parsed.stopStrings?.push('</s>');
    expect(DEFAULT_PRESET_CONFIG.stopStrings).toEqual([]);
    expect(parsePresetConfig(null).stopStrings).toEqual([]);
  });
});

describe('parsePresetConfig — numeric bounds', () => {
  test('an out-of-range value is clamped to the nearest bound, not rejected', () => {
    const config = parsePresetConfig(
      JSON.stringify({ maxTokens: 10_000_000, contextSize: 1, loreScanDepth: 999, loreTokenBudget: -5 }),
    );
    expect(config.maxTokens).toBe(65536);
    expect(config.contextSize).toBe(1024);
    expect(config.loreScanDepth).toBe(100);
    expect(config.loreTokenBudget).toBe(0);
  });

  test('a negative maxTokens clamps to the minimum rather than reaching the provider', () => {
    expect(parsePresetConfig(JSON.stringify({ maxTokens: -1 })).maxTokens).toBe(16);
  });

  test('an in-range value survives unchanged, including fractional rounding', () => {
    const config = parsePresetConfig(
      JSON.stringify({ maxTokens: 2048, contextSize: 32768, loreScanDepth: 4.6, loreTokenBudget: 900 }),
    );
    expect(config.maxTokens).toBe(2048);
    expect(config.contextSize).toBe(32768);
    expect(config.loreScanDepth).toBe(5);
    expect(config.loreTokenBudget).toBe(900);
  });

  test('a quoted number is coerced, and a non-numeric string falls back to the default', () => {
    expect(parsePresetConfig(JSON.stringify({ maxTokens: '2048' })).maxTokens).toBe(2048);
    expect(parsePresetConfig(JSON.stringify({ maxTokens: 'lots' })).maxTokens).toBe(
      DEFAULT_PRESET_CONFIG.maxTokens,
    );
    expect(parsePresetConfig(JSON.stringify({ maxTokens: null })).maxTokens).toBe(
      DEFAULT_PRESET_CONFIG.maxTokens,
    );
    expect(parsePresetConfig(JSON.stringify({ maxTokens: Number.NaN })).maxTokens).toBe(
      DEFAULT_PRESET_CONFIG.maxTokens,
    );
    expect(parsePresetConfig(JSON.stringify({ maxTokens: Number.POSITIVE_INFINITY })).maxTokens).toBe(
      DEFAULT_PRESET_CONFIG.maxTokens,
    );
  });
});

describe('parsePresetConfig — per-field fallback', () => {
  test('a garbage field does not discard the valid ones beside it', () => {
    const config = parsePresetConfig(
      JSON.stringify({ maxTokens: 'nonsense', includeNames: true, systemPrompt: 'Stay in character.' }),
    );
    expect(config.maxTokens).toBe(DEFAULT_PRESET_CONFIG.maxTokens);
    expect(config.includeNames).toBe(true);
    expect(config.systemPrompt).toBe('Stay in character.');
  });

  test('a non-string where text belongs becomes empty, not the stringified value', () => {
    const config = parsePresetConfig(JSON.stringify({ systemPrompt: 42, assistantPrefill: { a: 1 } }));
    expect(config.systemPrompt).toBe('');
    expect(config.assistantPrefill).toBe('');
  });

  test('only a real boolean sets a flag — truthy strings do not', () => {
    const config = parsePresetConfig(
      JSON.stringify({ includeNames: 'yes', banEmojis: 1, trimIncompleteSentences: false, loreRecursive: true }),
    );
    expect(config.includeNames).toBe(false);
    expect(config.banEmojis).toBe(false);
    expect(config.trimIncompleteSentences).toBe(false);
    expect(config.loreRecursive).toBe(true);
  });
});

describe('parsePresetConfig — stop strings', () => {
  test('non-strings and empty entries are dropped', () => {
    const config = parsePresetConfig(
      JSON.stringify({ stopStrings: ['</s>', '', 42, null, { x: 1 }, 'User:'] }),
    );
    expect(config.stopStrings).toEqual(['</s>', 'User:']);
  });

  test('a non-array stopStrings is empty, not a crash', () => {
    expect(parsePresetConfig(JSON.stringify({ stopStrings: '</s>' })).stopStrings).toEqual([]);
  });

  test('the list is capped, so a preset shipping hundreds cannot bloat every request', () => {
    const many = Array.from({ length: 200 }, (_, i) => `stop-${i}`);
    const config = parsePresetConfig(JSON.stringify({ stopStrings: many }));
    expect(config.stopStrings).toHaveLength(32);
    expect(config.stopStrings?.[0]).toBe('stop-0');
  });
});

describe('parsePresetConfig — a complete config', () => {
  test('every field is present after parsing a partial record', () => {
    const config = parsePresetConfig(JSON.stringify({ systemPrompt: 'x' }));
    expect(Object.keys(config).sort()).toEqual(Object.keys(DEFAULT_PRESET_CONFIG).sort());
  });

  test('a round trip through JSON preserves a fully specified config', () => {
    const full = {
      systemPrompt: 'Write in present tense.',
      preHistoryInstructions: 'The scene opens in a rain-soaked alley.',
      postHistoryInstructions: 'Never end a reply with a question.',
      impersonationPrompt: 'Write one line as {{user}}.',
      includeNames: true,
      banEmojis: true,
      trimIncompleteSentences: true,
      assistantPrefill: '<reply>',
      stopStrings: ['</reply>', 'User:'],
      maxTokens: 4096,
      contextSize: 65536,
      loreScanDepth: 6,
      loreTokenBudget: 2048,
      loreRecursive: true,
    };
    expect(parsePresetConfig(JSON.stringify(full))).toEqual(full);
  });
});
