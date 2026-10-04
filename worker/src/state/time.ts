/**
 * Reading the scene clock, so code can enforce what the prompt asks for.
 *
 * The state engine's `time` is a display string in a fixed shape — the model is told to
 * write "Weekday, Month D, YYYY, HH:MM" and nothing else under the managed pace. That
 * shape is parseable, and parsing it is what lets a guard refuse a clock that runs
 * backwards instead of trusting a model to do weekday arithmetic. The model has been
 * measured getting that arithmetic wrong: from a Friday-night scene it placed a reader's
 * "On Thursday evening" on the Thursday just past, a day before the stored reading.
 *
 * Free text is allowed under the manual pace and in hand-edited documents, so a value that
 * does not parse returns `null` and the guard stands aside rather than rejecting it.
 */

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const MONTH = Object.keys(MONTHS).join('|');
// "Friday, April 11, 2025, 22:38" — month first.
const MONTH_FIRST = new RegExp(
  `^\\s*(?:[a-z]+,\\s*)?(${MONTH})\\s+(\\d{1,2}),?\\s+(\\d{4}),?\\s+(\\d{1,2}):(\\d{2})\\s*([ap]\\.?m\\.?)?\\s*$`,
  'i',
);
// "Friday, 27 February 2026, 05:35" — day first. The older documented shape.
const DAY_FIRST = new RegExp(
  `^\\s*(?:[a-z]+,\\s*)?(\\d{1,2})\\s+(${MONTH})\\s+(\\d{4}),?\\s+(\\d{1,2}):(\\d{2})\\s*([ap]\\.?m\\.?)?\\s*$`,
  'i',
);

function instant(
  month: string,
  day: string,
  year: string,
  hour: string,
  minute: string,
  meridiem?: string,
): number | null {
  const monthIndex = MONTHS[month.toLowerCase()];
  const dayNumber = Number(day);
  const yearNumber = Number(year);
  let hours = Number(hour);
  const minutes = Number(minute);
  if (meridiem) {
    const pm = meridiem.toLowerCase().startsWith('p');
    if (hours === 12) hours = 0;
    if (pm) hours += 12;
  }
  if (monthIndex === undefined) return null;
  if (hours > 23 || minutes > 59 || dayNumber < 1 || dayNumber > 31) return null;
  // UTC, so a comparison cannot be bent by the host timezone or a DST edge.
  return Date.UTC(yearNumber, monthIndex, dayNumber, hours, minutes);
}

/**
 * The instant a clock reading names, or `null` when it is not in the documented shape.
 *
 * Only ever compared against another result from this function, so the exact epoch value
 * is not meaningful — the ordering is.
 */
export function parseStateTime(value: string): number | null {
  const text = value.trim();
  if (text.length === 0) return null;

  const monthFirst = MONTH_FIRST.exec(text);
  if (monthFirst) {
    return instant(monthFirst[1], monthFirst[2], monthFirst[3], monthFirst[4], monthFirst[5], monthFirst[6]);
  }

  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst) {
    return instant(dayFirst[2], dayFirst[1], dayFirst[3], dayFirst[4], dayFirst[5], dayFirst[6]);
  }

  return null;
}
