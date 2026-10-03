import { describe, expect, test } from 'bun:test';
import { MAX_ELAPSED_MINUTES, advanceClock, clampElapsed, formatClock, parseClock } from './time';

/**
 * The clock arithmetic, which exists because the cheap model cannot be trusted with it.
 *
 * The reported bug was a clock that did not move: "10 minutes pass" left the stored time
 * unchanged, and a quiet exchange left it unchanged for eight messages. The model is now
 * asked only to COUNT the minutes, and this module is what turns that count into a new
 * clock — so it is the part that has to be right.
 */
describe('parseClock', () => {
  test('reads the canonical stored form', () => {
    expect(parseClock('Friday, April 11, 2025, 22:02')).toBe(
      Date.UTC(2025, 3, 11, 22, 2),
    );
  });

  test('reads the 12-hour form an older prompt produced', () => {
    // Those rows are still in the database; failing to parse them would leave real chats
    // unable to advance.
    expect(parseClock('Friday, April 11, 2025, 10:01 PM')).toBe(Date.UTC(2025, 3, 11, 22, 1));
  });

  test('reads a value with no weekday', () => {
    expect(parseClock('April 11, 2025, 22:02')).toBe(Date.UTC(2025, 3, 11, 22, 2));
  });

  test('returns null for free text rather than guessing', () => {
    // A reader's own "late evening" has no clock in it. Inventing one would replace what
    // they wrote with a guess.
    expect(parseClock('late evening')).toBeNull();
    expect(parseClock('')).toBeNull();
    expect(parseClock('sometime next week')).toBeNull();
  });

  test('rejects an out-of-range field instead of rolling it over', () => {
    expect(parseClock('Friday, April 11, 2025, 25:00')).toBeNull();
    expect(parseClock('Friday, April 11, 2025, 22:75')).toBeNull();
  });
});

describe('advanceClock', () => {
  test('adds minutes across a day boundary', () => {
    expect(advanceClock('Friday, April 11, 2025, 23:55', 10)).toBe('Saturday, April 12, 2025, 00:05');
  });

  test('adds a whole night and lands on the next day', () => {
    expect(advanceClock('Friday, April 11, 2025, 22:02', 480)).toBe(
      'Saturday, April 12, 2025, 06:02',
    );
  });

  test('is a no-op for a zero count', () => {
    expect(advanceClock('Friday, April 11, 2025, 22:02', 0)).toBe('Friday, April 11, 2025, 22:02');
  });

  test('returns null when there is no stored clock to advance', () => {
    expect(advanceClock(undefined, 10)).toBeNull();
    expect(advanceClock('late evening', 10)).toBeNull();
  });

  test('steps the weekday with the date', () => {
    // Rounding at a week boundary: the weekday comes from the resulting date, not from the
    // string it started as.
    expect(advanceClock('Friday, April 11, 2025, 22:02', 60 * 24 * 7)).toBe(
      'Friday, April 18, 2025, 22:02',
    );
  });
});

describe('clampElapsed', () => {
  test('passes a normal count through', () => {
    expect(clampElapsed(10)).toBe(10);
    expect(clampElapsed(180)).toBe(180);
  });

  test('rounds a fractional count', () => {
    expect(clampElapsed(2.6)).toBe(3);
  });

  test('floors a negative count at zero rather than moving backwards', () => {
    expect(clampElapsed(-5)).toBe(0);
  });

  test('caps an absurd count at a week', () => {
    expect(clampElapsed(999999)).toBe(MAX_ELAPSED_MINUTES);
  });

  test('rejects a non-number, so a missing count is distinguishable from zero', () => {
    expect(clampElapsed(undefined)).toBeNull();
    expect(clampElapsed('10')).toBeNull();
    expect(clampElapsed(NaN)).toBeNull();
  });
});

describe('formatClock', () => {
  test('emits the canonical stored shape', () => {
    // What `parseClock` reads back must be what `formatClock` writes, or a stored value
    // would stop being parseable after one turn.
    const formatted = formatClock(Date.UTC(2025, 3, 11, 22, 2));
    expect(formatted).toBe('Friday, April 11, 2025, 22:02');
    expect(parseClock(formatted)).toBe(Date.UTC(2025, 3, 11, 22, 2));
  });

  test('zero-pads the clock', () => {
    expect(formatClock(Date.UTC(2025, 0, 5, 4, 7))).toBe('Sunday, January 5, 2025, 04:07');
  });
});
