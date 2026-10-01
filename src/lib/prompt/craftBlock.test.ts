import { describe, expect, test } from 'bun:test';
import { renderCraftBlock, renderContentPolicy, renderVocalisation } from './craftBlock';
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

  test("pov 'off' drops the person instruction without leaving an empty block", () => {
    const block = renderCraftBlock({ ...DEFAULT_CRAFT, pov: 'off' });
    expect(block).not.toContain('Address the reader as "you"');
    // An `'off'` POV contributes nothing at all. The assertion is that the block does not
    // OPEN on a blank line (an empty pushed segment), not that the document has no blank
    // lines anywhere — the blocks themselves are separated by one.
    expect(block).not.toMatch(/<craft>\n\n/);
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
      vocalisation: false,
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
      vocalisation: true,
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

  test('vocalisation is NOT in the prefix, whatever its toggle says', () => {
    // It is a tail renderer (`renderVocalisation`) because position decides whether the
    // model obeys it — in the prefix the same text was ignored. Pinning the absence here
    // is what stops it being moved back by accident.
    expect(renderCraftBlock(DEFAULT_CRAFT)).not.toContain('<craft_vocalisation>');
    expect(renderCraftBlock({ ...DEFAULT_CRAFT, vocalisation: false })).not.toContain(
      '<craft_vocalisation>',
    );
  });
});

describe('renderVocalisation', () => {
  test('is emitted when the toggle is on, and carries a concrete sound', () => {
    const block = renderVocalisation(DEFAULT_CRAFT);
    expect(block).toContain('<craft_vocalisation>');
    expect(block).toContain('A-Ah');
    // The restraint sentence is load-bearing: without it the block is a list of sounds
    // and the model over-generates, which is the measured failure mode it exists to
    // prevent (arXiv 2412.12710: 12.9 insertions/sample against a human 5.0).
    expect(block).toMatch(/most lines carry no sound at all/i);
  });

  test('is the empty string when the toggle is off', () => {
    expect(renderVocalisation({ ...DEFAULT_CRAFT, vocalisation: false })).toBe('');
  });

  test('is independent of every other field', () => {
    // The other craft blocks must not be able to switch it on or off.
    const base = renderVocalisation(DEFAULT_CRAFT);
    expect(renderVocalisation({ ...DEFAULT_CRAFT, pov: 'off', register: 'off' })).toBe(base);
    expect(renderVocalisation({ ...DEFAULT_CRAFT, antiSlop: false, interiority: false })).toBe(base);
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
