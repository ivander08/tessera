import { asRecord } from './json';

/**
 * One-tap steering for the next turn, as the instruction text it sends.
 *
 * A label for the row, a sentence for the tail: the reader taps a label and `text`
 * rides the request's `steer` field — one turn only, never stored, never near the
 * cached prefix. These target the complaints the community survey puts at the top of
 * its list (purple prose, rushed pacing, passive scenes) as single-tap corrections
 * rather than a field the reader has to compose themselves.
 */
export interface Steer {
  label: string;
  text: string;
}

export const BUILTIN_STEERS: Steer[] = [
  {
    label: 'More conflict',
    text: 'Raise the conflict this turn: let disagreement, stakes, or friction visibly escalate.',
  },
  {
    label: 'Slower pace',
    text: 'Slow down this turn: linger on small gestures and beats; do not advance the plot.',
  },
  {
    label: 'Less purple',
    text: 'Plain description this turn: cut ornate metaphor and elevated diction.',
  },
  {
    label: 'More dialogue',
    text: 'Carry this turn primarily in dialogue; keep narration to staging only.',
  },
  {
    label: 'More body',
    text: 'Ground this turn in physical action and sensation; minimal abstraction.',
  },
  {
    label: 'Surprise me',
    text: 'Do something genuinely unexpected this turn, within what the scene has already established.',
  },
];

/** The settings key the custom chips live under, as a JSON array of `{label, text}`. */
export const STEERS_SETTING_KEY = 'steers';

/**
 * The custom chips stored in the settings row, or nothing when the value is not one.
 *
 * Custom chips are written by the settings screen but the row is also reachable by hand
 * (`curl` against `/api/settings`, a database edit), and a malformed value must degrade
 * to no custom chips rather than break the composer: the built-in row is the floor, and
 * a broken setting takes nothing away from it. Entries missing either field, or carrying
 * an empty one, are dropped individually — one bad chip does not discard its siblings.
 */
export function parseSteers(value: unknown): Steer[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const steers: Steer[] = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    const label = typeof record?.label === 'string' ? record.label.trim() : '';
    const text = typeof record?.text === 'string' ? record.text.trim() : '';
    if (label.length === 0 || text.length === 0) continue;
    steers.push({ label, text });
  }
  return steers;
}
