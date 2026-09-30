import { asRecord } from '../json';

/**
 * The world state is a small JSON document describing where the scene is and what has
 * changed since it started.
 *
 * It is rendered into the prompt TAIL (see `stateBlock.ts`) and never into the cached
 * prefix. It is also never edited by application code: a cheap model proposes a patch,
 * `validatePatch` accepts or rejects it whole, and the accepted result is what gets
 * stored. That single choke point is the reason a hallucinated key or a misread
 * sentence cannot quietly become part of the record.
 *
 * Every field is optional — an empty document is a legitimate state, not an error.
 */
export interface WorldState {
  /** In-world clock, free text ("late evening", "03:40"). Not a real timestamp. */
  time?: string;
  location?: string;
  weather?: string;
  /** Characters currently in the scene. */
  present?: string[];
  inventory?: string[];
  /**
   * Characters who are NOT where the scene is, and where they are instead.
   *
   * `location` is single-valued because a scene has one point of view: the reader is
   * somewhere, and `present` lists who is there with them. But a story routinely cuts
   * away — "meanwhile, Ada is still in the courtyard" — and without this the narrator
   * has no way to know that Ada is not standing in the room, so she keeps being written
   * into a scene she left.
   *
   * Deliberately a map rather than a full location per character: only the characters
   * who are AWAY need an entry, which keeps the common case (everyone together) at zero
   * extra tokens. Per-character clocks and timezones are not modelled — a scene that
   * spans timezones is rare enough that inventing a timezone table would cost every
   * other scene for it.
   */
  away?: Record<string, string>;
  /** Character name -> short condition, e.g. `{ Ada: 'bleeding' }`. */
  conditions?: Record<string, string>;
  notes?: string[];
}

/**
 * Words that describe a role rather than name a character.
 *
 * Observed in real state: `present: ["me"]`. A pronoun in a cast list is always wrong —
 * the narrator then has to decide who "me" is, and the reader's own name never appears.
 * Rejecting these is cheap and the failure it prevents is a scene where the user is
 * invisible to the world model.
 */
const NOT_A_NAME: Record<string, true> = {
  me: true, i: true, you: true, them: true, him: true, her: true, us: true, we: true,
  they: true, someone: true, anyone: true, everyone: true, nobody: true, user: true,
  'the user': true, myself: true, yourself: true,
};

/**
 * Frozen so a caller cannot mutate the shared empty document by accident. Copy it
 * (`{ ...EMPTY_STATE }`) if you need to change it.
 */
export const EMPTY_STATE: WorldState = Object.freeze({});

/** A proposed change. Untrusted: it comes from a model, so every key is checked. */
export interface Patch {
  [key: string]: unknown;
}

export type ValidationResult = { ok: true; next: WorldState } | { ok: false; reason: string };

/**
 * Merge an untrusted patch into `current` and return the next state.
 *
 * Rules, in the order they are enforced:
 *  - the patch must be a JSON object (not an array, not a string, not null);
 *  - every key must be one this module knows — an unknown key is rejected outright
 *    rather than dropped, because a dropped key is a silent divergence between what
 *    the model believes it recorded and what the prompt will show it next turn;
 *  - every value must have the right type for its key;
 *  - `null` for a key clears it ("this is no longer true" is not the same as
 *    "unchanged", and an empty string cannot express the difference);
 *  - `current` is never mutated; the result is a fresh object.
 *
 * A rejection names the offending key, so the caller can log something actionable
 * instead of a generic "invalid patch".
 */
export function validatePatch(current: WorldState, patch: unknown): ValidationResult {
  const record = asRecord(patch);
  if (!record) return { ok: false, reason: 'patch must be a JSON object' };

  // `delete` needs an index-signature view. The switch below is what guarantees the
  // result still matches `WorldState`.
  const next: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(record)) {
    switch (key) {
      case 'time':
      case 'location':
      case 'weather': {
        if (value === null) {
          delete next[key];
          break;
        }
        if (typeof value !== 'string') {
          return { ok: false, reason: `"${key}" must be a string or null, got ${describe(value)}` };
        }
        next[key] = value;
        break;
      }

      case 'present': {
        if (value === null) {
          delete next.present;
          break;
        }
        const list = stringList(value);
        if (!list) {
          return {
            ok: false,
            reason: `"present" must be an array of strings or null, got ${describe(value)}`,
          };
        }
        // Drop role-words rather than rejecting the whole patch: the rest of the
        // document is usually fine, and a rejected patch means no state advances at all.
        const names = list.filter((entry) => NOT_A_NAME[entry.trim().toLowerCase()] !== true);
        if (names.length !== list.length) {
          console.warn(`[state] dropped non-names from present: ${list.filter((e) => NOT_A_NAME[e.trim().toLowerCase()]).join(', ')}`);
        }
        // Someone cannot be both here and away. A model that writes both is confused
        // about the scene, and the contradiction would render into the prompt as two
        // facts — so whoever is listed as present wins and their `away` entry is dropped.
        const away = next.away;
        if (away && typeof away === 'object' && !Array.isArray(away)) {
          const remaining: Record<string, string> = {};
          for (const [who, where] of Object.entries(away)) {
            if (!names.some((name) => name.toLowerCase() === who.toLowerCase())) {
              remaining[who] = String(where);
            }
          }
          if (Object.keys(remaining).length > 0) next.away = remaining;
          else delete next.away;
        }
        next.present = names;
        break;
      }

      case 'away': {
        if (value === null) {
          delete next.away;
          break;
        }
        const map = stringMap(value);
        if (!map) {
          return {
            ok: false,
            reason: `"away" must be an object of name -> place, or null, got ${describe(value)}`,
          };
        }
        // Same reasoning as `present`: a pronoun is not a character, and "me" is away
        // from a scene the reader is standing in.
        const cleaned: Record<string, string> = {};
        for (const [who, where] of Object.entries(map)) {
          if (NOT_A_NAME[who.trim().toLowerCase()] === true) continue;
          if (where.trim().length === 0) continue;
          cleaned[who] = where;
        }
        if (Object.keys(cleaned).length > 0) next.away = cleaned;
        else delete next.away;
        break;
      }

      case 'inventory':
      case 'notes': {
        if (value === null) {
          delete next[key];
          break;
        }
        const list = stringList(value);
        if (!list) {
          return {
            ok: false,
            reason: `"${key}" must be an array of strings or null, got ${describe(value)}`,
          };
        }
        next[key] = list;
        break;
      }

      case 'conditions': {
        if (value === null) {
          delete next.conditions;
          break;
        }
        const map = stringMap(value);
        if (!map) {
          return {
            ok: false,
            reason: `"conditions" must be an object with string values or null, got ${describe(value)}`,
          };
        }
        next.conditions = map;
        break;
      }

      default:
        return { ok: false, reason: `unknown state key "${key}"` };
    }
  }

  return { ok: true, next: next as WorldState };
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
  }
  return value as string[];
}

function stringMap(value: unknown): Record<string, string> | null {
  // `asRecord` rejects arrays, so `conditions: []` fails here rather than becoming an
  // empty object.
  const record = asRecord(value);
  if (!record) return null;

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') return null;
    out[key] = entry;
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
