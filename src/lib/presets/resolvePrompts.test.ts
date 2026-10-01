import { describe, expect, test } from 'bun:test';

import { injectAtDepth, resolveOrder, resolvePrompts } from './resolvePrompts';
import type { PromptEntry, PromptOrderEntry } from './types';

/**
 * The SillyTavern Prompt Manager, resolved.
 *
 * Every test here pins a behaviour that a plausible implementation gets wrong, and the
 * two that matter most were found by reading the real presets rather than invented:
 * `prompt_order` disagreeing with `prompts[].enabled`, and markers being positions
 * rather than content.
 */

function prompt(identifier: string, patch: Partial<PromptEntry> = {}): PromptEntry {
  return { identifier, name: identifier, content: `${identifier} body`, ...patch };
}

const BLOCKS = {
  worldInfoBefore: '',
  personaDescription: '',
  charDescription: 'CARD DESCRIPTION',
  charPersonality: '',
  scenario: '',
  worldInfoAfter: '',
  dialogueExamples: '',
  chatHistory: '',
};

describe('resolveOrder', () => {
  test('prompt_order decides what is on, not prompts[].enabled', () => {
    // The measured case: ST stores the flag twice and they disagree. `prompt_order` is
    // what its Prompt Manager renders, so it is what the reader ticked.
    const prompts = [
      prompt('a', { enabled: true }),
      prompt('b', { enabled: true }),
    ];
    const order: PromptOrderEntry[] = [
      { identifier: 'a', enabled: false },
      { identifier: 'b', enabled: true },
    ];

    const resolved = resolveOrder(prompts, order);
    expect(resolved.map((row) => [row.prompt.identifier, row.enabled])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  test('an order row naming an entry the file does not carry is skipped', () => {
    const resolved = resolveOrder([prompt('a')], [
      { identifier: 'ghost', enabled: true },
      { identifier: 'a', enabled: true },
    ]);
    expect(resolved.map((row) => row.prompt.identifier)).toEqual(['a']);
  });

  test('entries the order does not mention are kept, appended, and use their own flag', () => {
    // ST appends unknown entries to the end of the Prompt Manager. Dropping them would
    // lose a prompt the reader can see in ST.
    const resolved = resolveOrder(
      [prompt('a'), prompt('loose', { enabled: true }), prompt('off')],
      [{ identifier: 'a', enabled: true }],
    );
    expect(resolved.map((row) => [row.prompt.identifier, row.enabled])).toEqual([
      ['a', true],
      ['loose', true],
      ['off', false],
    ]);
  });

  test('with no order at all, prompts[].enabled is the only signal', () => {
    const resolved = resolveOrder(
      [prompt('a', { enabled: true }), prompt('b'), prompt('c', { enabled: false })],
      [],
    );
    expect(resolved.map((row) => [row.prompt.identifier, row.enabled])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
  });
});

describe('resolvePrompts', () => {
  test('emits enabled entries in order, with their own roles', () => {
    const out = resolvePrompts(
      [prompt('one', { role: 'system' }), prompt('two', { role: 'user' }), prompt('three')],
      [
        { identifier: 'one', enabled: true },
        { identifier: 'two', enabled: true },
        { identifier: 'three', enabled: false },
      ],
      BLOCKS,
    );

    expect(out.head.map((s) => [s.role, s.content])).toEqual([
      ['system', 'one body'],
      ['user', 'two body'],
    ]);
    expect(out.enabledCount).toBe(2);
    expect(out.total).toBe(3);
  });

  test('an unknown role falls back to system rather than emitting an invalid one', () => {
    const out = resolvePrompts(
      [prompt('a', { role: 'narrator' })],
      [{ identifier: 'a', enabled: true }],
      BLOCKS,
    );
    expect(out.head[0].role).toBe('system');
  });

  test('a marker emits the block Tessera built, not the marker itself', () => {
    // The failure this guards: emitting the marker's own (empty) content, which drops
    // the card out of the prompt entirely.
    const out = resolvePrompts(
      [prompt('charDescription', { marker: true, content: '' })],
      [{ identifier: 'charDescription', enabled: true }],
      BLOCKS,
    );
    expect(out.head.map((s) => s.content)).toEqual(['CARD DESCRIPTION']);
  });

  test('a marker with no block available is skipped, not emitted empty', () => {
    const out = resolvePrompts(
      [prompt('worldInfoBefore', { marker: true })],
      [{ identifier: 'worldInfoBefore', enabled: true }],
      BLOCKS,
    );
    expect(out.head).toEqual([]);
  });

  test('chatHistory is a pivot: entries after it land after the history', () => {
    const out = resolvePrompts(
      [prompt('before'), prompt('chatHistory', { marker: true }), prompt('after')],
      [
        { identifier: 'before', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'after', enabled: true },
      ],
      BLOCKS,
    );
    expect(out.head.map((s) => s.content)).toEqual(['before body']);
    expect(out.afterHistory.map((s) => s.content)).toEqual(['after body']);
  });

  test('a marker is never emitted as a segment of its own', () => {
    const out = resolvePrompts(
      [prompt('chatHistory', { marker: true, content: 'should not appear' })],
      [{ identifier: 'chatHistory', enabled: true }],
      BLOCKS,
    );
    expect(out.head).toEqual([]);
    expect(out.afterHistory).toEqual([]);
  });

  test('injection_position 0 goes to the depth list, not the static run', () => {
    const out = resolvePrompts(
      [prompt('static'), prompt('deep', { injectionPosition: 0, injectionDepth: 2 })],
      [
        { identifier: 'static', enabled: true },
        { identifier: 'deep', enabled: true },
      ],
      BLOCKS,
    );
    expect(out.head.map((s) => s.content)).toEqual(['static body']);
    expect(out.injected.map((entry) => [entry.depth, entry.segment.content])).toEqual([
      [2, 'deep body'],
    ]);
  });

  test('a disabled entry is never emitted however it is positioned', () => {
    const out = resolvePrompts(
      [prompt('a', { injectionPosition: 0, injectionDepth: 1 }), prompt('b')],
      [
        { identifier: 'a', enabled: false },
        { identifier: 'b', enabled: false },
      ],
      BLOCKS,
    );
    expect(out.head).toEqual([]);
    expect(out.injected).toEqual([]);
    expect(out.enabledCount).toBe(0);
  });

  test('an enabled entry with no content is skipped', () => {
    const out = resolvePrompts(
      [prompt('empty', { content: '' })],
      [{ identifier: 'empty', enabled: true }],
      BLOCKS,
    );
    expect(out.head).toEqual([]);
  });
});

describe('injectAtDepth', () => {
  const history = ['m0', 'm1', 'm2'];

  test('depth 0 sits after the newest message', () => {
    const out = injectAtDepth(history, [
      { depth: 0, segment: { role: 'system', content: 'X', name: 'x' } },
    ]);
    expect(out.map((e) => (typeof e === 'string' ? e : e.injected.content))).toEqual([
      'm0',
      'm1',
      'm2',
      'X',
    ]);
  });

  test('depth 1 sits before the newest message', () => {
    const out = injectAtDepth(history, [
      { depth: 1, segment: { role: 'system', content: 'X', name: 'x' } },
    ]);
    expect(out.map((e) => (typeof e === 'string' ? e : e.injected.content))).toEqual([
      'm0',
      'm1',
      'X',
      'm2',
    ]);
  });

  test('a depth past the start of the history clamps to the front rather than dropping', () => {
    const out = injectAtDepth(history, [
      { depth: 99, segment: { role: 'system', content: 'X', name: 'x' } },
    ]);
    expect(out.map((e) => (typeof e === 'string' ? e : e.injected.content))).toEqual([
      'X',
      'm0',
      'm1',
      'm2',
    ]);
  });

  test('several entries at one depth keep their relative order', () => {
    const out = injectAtDepth(history, [
      { depth: 1, segment: { role: 'system', content: 'FIRST', name: 'a' } },
      { depth: 1, segment: { role: 'system', content: 'SECOND', name: 'b' } },
    ]);
    expect(out.map((e) => (typeof e === 'string' ? e : e.injected.content))).toEqual([
      'm0',
      'm1',
      'FIRST',
      'SECOND',
      'm2',
    ]);
  });

  test('two different depths both land correctly', () => {
    const out = injectAtDepth(history, [
      { depth: 2, segment: { role: 'system', content: 'A', name: 'a' } },
      { depth: 0, segment: { role: 'system', content: 'B', name: 'b' } },
    ]);
    expect(out.map((e) => (typeof e === 'string' ? e : e.injected.content))).toEqual([
      'm0',
      'A',
      'm1',
      'm2',
      'B',
    ]);
  });

  test('an empty history still places the injection', () => {
    const out = injectAtDepth([], [
      { depth: 0, segment: { role: 'system', content: 'X', name: 'x' } },
    ]);
    expect(out.map((e) => (typeof e === 'string' ? e : e.injected.content))).toEqual(['X']);
  });

  test('no injections returns the history untouched', () => {
    expect(injectAtDepth(history, [])).toBe(history);
  });
});
