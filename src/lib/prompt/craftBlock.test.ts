import { describe, expect, test } from 'bun:test';
import { renderCraftBlock, renderContentPolicy } from './craftBlock';
import { DEFAULT_CRAFT, type Craft } from '../scene/setup';

/**
 * The craft document is split across two positions, and the split is the point.
 *
 * `renderCraftBlock` is the cached prefix: the person, the register and the quality rules.
 * `renderContentPolicy` is the tail: the unrestricted-content policy alone, placed last so
 * it is the most recent instruction the model reads. Measured against the local model, the
 * same policy text in the prefix was refused and in the tail was complied with, so the two
 * positions are not interchangeable and are tested separately.
 */
describe('renderCraftBlock', () => {
  test('the default craft emits the quality rules and the person', () => {
    const block = renderCraftBlock(DEFAULT_CRAFT);
    expect(block).toContain('<craft');
    expect(block).toContain('<craft_antislop>');
    expect(block).toContain('"you"');
    // The policy is NOT here: it belongs in the tail, emitted by `renderContentPolicy`.
    expect(block).not.toContain('<craft_content>');
  });

  test("pov 'off' drops the person instruction and leaves no blank line", () => {
    const block = renderCraftBlock({ ...DEFAULT_CRAFT, pov: 'off' });
    expect(block).not.toContain('Address the reader as "you"');
    expect(block).not.toMatch(/\n\n/);
  });

  test("register 'off' drops all three register sentences", () => {
    const block = renderCraftBlock({ ...DEFAULT_CRAFT, register: 'off' });
    expect(block).not.toContain('Concrete and visual');
    expect(block).not.toContain('Weight the sentence');
    expect(block).not.toContain('Direct and unadorned');
  });

  test('every block off returns the empty string', () => {
    const allOff: Craft = {
      contentPolicy: false,
      pov: 'off',
      register: 'off',
      antiSlop: false,
      interiority: false,
      earnedKnowledge: false,
      independentNpcs: false,
      bonds: false,
      threads: false,
    };
    expect(renderCraftBlock(allOff)).toBe('');
  });

  test('is deterministic for a given craft', () => {
    expect(renderCraftBlock(DEFAULT_CRAFT)).toBe(renderCraftBlock(DEFAULT_CRAFT));
    const custom: Craft = {
      contentPolicy: false,
      pov: 'third',
      register: 'plain',
      antiSlop: false,
      interiority: true,
      earnedKnowledge: false,
      independentNpcs: true,
      bonds: true,
      threads: true,
    };
    expect(renderCraftBlock(custom)).toBe(renderCraftBlock(custom));
  });

  test('changing any prefix field changes the output', () => {
    const base = renderCraftBlock(DEFAULT_CRAFT);
    const variants: Craft[] = [
      { ...DEFAULT_CRAFT, pov: 'off' },
      { ...DEFAULT_CRAFT, register: 'literary' },
      { ...DEFAULT_CRAFT, antiSlop: false },
      { ...DEFAULT_CRAFT, interiority: false },
      { ...DEFAULT_CRAFT, earnedKnowledge: false },
      { ...DEFAULT_CRAFT, independentNpcs: false },
    ];
    for (const variant of variants) {
      expect(renderCraftBlock(variant)).not.toBe(base);
    }
  });
});

describe('renderContentPolicy', () => {
  test('is emitted when the toggle is on, and carries the policy', () => {
    const policy = renderContentPolicy(DEFAULT_CRAFT);
    expect(policy).toContain('<craft_content>');
    expect(policy).toContain('unrestricted adult fiction');
    expect(policy).toContain('explicitly');
  });

  test('is the empty string when the toggle is off', () => {
    expect(renderContentPolicy({ ...DEFAULT_CRAFT, contentPolicy: false })).toBe('');
  });

  test('is independent of every other field', () => {
    // The policy is the one thing the prefix block cannot suppress, so it must render the
    // same whatever the rest of the craft says.
    const base = renderContentPolicy(DEFAULT_CRAFT);
    expect(renderContentPolicy({ ...DEFAULT_CRAFT, pov: 'off', register: 'off' })).toBe(base);
    expect(renderContentPolicy({ ...DEFAULT_CRAFT, antiSlop: false })).toBe(base);
  });
});
