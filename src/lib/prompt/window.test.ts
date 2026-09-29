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

  test('re-anchors once to the newest messages that fit', () => {
    const history = [
      { seq: 1, tokens: 50 },
      { seq: 2, tokens: 50 },
      { seq: 3, tokens: 50 },
      { seq: 4, tokens: 50 },
    ];
    // Budget 100: newest-first accumulation 4 (50), 3 (100), 2 (150 > 100) -> anchor at 3.
    expect(computeWindowStart(history, 1, 100)).toBe(3);
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
