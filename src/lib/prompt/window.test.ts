import { describe, expect, test } from 'bun:test';
import { computeWindowStart } from './window';

describe('computeWindowStart', () => {
  test('holds the anchor while the window fits', () => {
    const history = [
      { seq: 1, tokens: 10 },
      { seq: 2, tokens: 10 },
      { seq: 3, tokens: 10 },
    ];
    expect(computeWindowStart(history, 1, 100)).toBe(1);
  });

  test('re-anchors to the low-water mark, leaving headroom for the next turns', () => {
    const history = [
      { seq: 1, tokens: 50 },
      { seq: 2, tokens: 50 },
      { seq: 3, tokens: 50 },
      { seq: 4, tokens: 50 },
    ];
    // Budget 100, re-anchor target 85: the newest message (50) fits the target, the next
    // brings the window to 100 — over the target — so the anchor is the newest. The other
    // 50 of the budget is the headroom that keeps the prefix stable for the following
    // turns. (Re-anchoring to the exact budget anchored at 3 and moved again on the next
    // turn, which is what made a live chat cache 10% of its prompt.)
    expect(computeWindowStart(history, 1, 100)).toBe(4);
  });

  test('the headroom holds the anchor while the window grows back', () => {
    // The property the provider's prefix cache depends on: after a re-anchor, ordinary
    // turns must not move the anchor again. A zero-headroom re-anchor moved it every turn.
    const history = [
      { seq: 1, tokens: 50 },
      { seq: 2, tokens: 50 },
      { seq: 3, tokens: 50 },
      { seq: 4, tokens: 50 },
    ];
    const anchor = computeWindowStart(history, 1, 100);
    const grown = [...history, { seq: 5, tokens: 10 }, { seq: 6, tokens: 10 }];
    expect(computeWindowStart(grown, anchor, 100)).toBe(anchor);
  });

  test('keeps at least the newest message when it alone exceeds the budget', () => {
    const history = [
      { seq: 1, tokens: 10 },
      { seq: 2, tokens: 999 },
    ];
    expect(computeWindowStart(history, 1, 100)).toBe(2);
  });

  test('is idempotent — a re-anchor does not move again on the next turn', () => {
    const history = [
      { seq: 1, tokens: 50 },
      { seq: 2, tokens: 50 },
      { seq: 3, tokens: 50 },
      { seq: 4, tokens: 50 },
    ];
    const first = computeWindowStart(history, 1, 100);
    expect(computeWindowStart(history, first, 100)).toBe(first);
  });

  test('empty history leaves the anchor untouched', () => {
    expect(computeWindowStart([], 7, 100)).toBe(7);
  });
});
