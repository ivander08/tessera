import { describe, expect, test } from 'bun:test';

import { parseStateTime } from './time';

/**
 * The clock reader the backwards guard compares with.
 *
 * It only has to be exact about ORDER: two readings the model wrote in the documented shape
 * must compare correctly, and anything else must return null so the guard stands aside
 * rather than rejecting a document it cannot judge.
 */
describe('parseStateTime', () => {
  test('reads the documented month-first shape', () => {
    const value = parseStateTime('Friday, April 11, 2025, 22:38');
    expect(value).toBe(Date.UTC(2025, 3, 11, 22, 38));
  });

  test('reads the older day-first shape with a 12-hour clock', () => {
    expect(parseStateTime('Friday, 27 February 2026, 05:35')).toBe(Date.UTC(2026, 1, 27, 5, 35));
    expect(parseStateTime('Friday, 27 February 2026, 05:35 PM')).toBe(Date.UTC(2026, 1, 27, 17, 35));
  });

  test('orders a later weekday above an earlier one', () => {
    const stored = parseStateTime('Friday, April 11, 2025, 22:38')!;
    const past = parseStateTime('Thursday, April 10, 2025, 19:00')!;
    const next = parseStateTime('Thursday, April 17, 2025, 19:00')!;
    expect(past).toBeLessThan(stored);
    expect(next).toBeGreaterThan(stored);
  });

  test('returns null for free text, a bare time of day, and an empty string', () => {
    // These are legitimate stored values under the manual pace and in older documents. The
    // guard must not treat "cannot compare" as "backwards".
    expect(parseStateTime('late evening')).toBeNull();
    expect(parseStateTime('22:38')).toBeNull();
    expect(parseStateTime('')).toBeNull();
    expect(parseStateTime('Thursday, April 10, 2025')).toBeNull();
  });
});
