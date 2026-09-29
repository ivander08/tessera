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
  time?: string;
  location?: string;
  /** Characters currently in the scene. */
  present?: string[];
  inventory?: string[];
  /** Character name -> short condition, e.g. `{ Ada: 'bleeding' }`. */
  conditions?: Record<string, string>;
  notes?: string[];
}

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
      case 'location': {
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

      case 'present':
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
