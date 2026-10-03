/**
 * The in-world clock, as arithmetic rather than as a model's job.
 *
 * `time` used to be free text the cheap model rewrote from scratch each turn, and it
 * drifted: measured against the live model, an exchange saying "10 minutes pass" advanced
 * the clock correctly only when the instruction was unambiguous, and a plain exchange —
 * "You good now?" / "Both." — advanced it not at all, or not at all for several turns.
 * A model cannot reliably do clock arithmetic, and asking it to decide WHETHER time moved
 * at all is worse: a conversation is minutes, and it kept returning the unchanged value.
 *
 * So the model now reports only the ELAPSED minutes it read out of the exchange, and this
 * module does the addition. That is deterministic, testable, and impossible to drift.
 *
 * The stored format is `"Friday, April 11, 2025, 22:02"` — a full weekday, date and
 * 24-hour clock. The parser also accepts the 12-hour `"10:01 PM"` form, because an older
 * version of the prompt produced it and those rows are still in the database.
 */

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `"Friday, April 11, 2025, 22:02"` -> the parts, or null when it is not that shape. */
function parseParts(value: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  const match =
    /^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/.exec(
      value.trim(),
    );
  if (!match) return null;

  const monthName = match[1];
  const month = MONTHS.findIndex((name) => name.toLowerCase() === monthName.toLowerCase()) + 1;
  if (month === 0) return null;

  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const meridiem = match[6]?.toLowerCase();

  // A 12-hour clock without a meridiem is ambiguous; treat 12 as noon rather than
  // midnight, which is the reading that matches how "12:30" is normally said.
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  return { year, month, day, hour, minute };
}

/**
 * A stored clock string parsed to a UTC-epoch minute count, or null when it cannot be read.
 *
 * Deliberately uses `Date.UTC` and formats back through UTC getters: the value is a
 * wall-clock reading, not an instant, so any local timezone would shift it by hours and
 * make the rendered clock disagree with the stored one.
 */
export function parseClock(value: string): number | null {
  const parts = parseParts(value);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

/** The canonical rendering: `"Friday, April 11, 2025, 22:02"`. */
export function formatClock(epochMinutes: number): string {
  const date = new Date(epochMinutes);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${weekday}, ${month} ${day}, ${year}, ${hour}:${minute}`;
}

/**
 * Advance a stored clock by `minutes`.
 *
 * Returns null when the stored value cannot be parsed AND no absolute time was supplied,
 * which is the honest answer: inventing a new date from an unreadable one would silently
 * replace the reader's own setting with a guess.
 */
export function advanceClock(stored: string | undefined, minutes: number): string | null {
  const base = stored ? parseClock(stored) : null;
  if (base === null) return null;
  return formatClock(base + Math.round(minutes) * 60_000);
}

/**
 * How far to move the clock, in minutes, from what the model reported.
 *
 * `elapsed` is the model's count of minutes the exchange covers. It is clamped to a sane
 * range: a negative or absurd value is a misread, and moving the clock backwards or by a
 * week on a single turn is worse than ignoring it. 0 is a legitimate answer for an
 * exchange the model judges instantaneous, so the floor is 0 rather than 1.
 */
export function clampElapsed(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > MAX_ELAPSED_MINUTES) return MAX_ELAPSED_MINUTES;
  return rounded;
}

/**
 * A week. The largest honest single-turn jump is an overnight break (~8 hours) or a
 * "three days later" the reader wrote; anything past this is the model having misread a
 * number, and capping it keeps one bad reply from throwing the calendar out.
 */
export const MAX_ELAPSED_MINUTES = 7 * 24 * 60;
