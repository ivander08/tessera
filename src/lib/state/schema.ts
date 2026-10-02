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
  /**
   * Character name -> what they are wearing, e.g.
   * `{ Sydney: 'school uniform, blazer open' }`.
   *
   * A map keyed by name rather than a list, because clothing belongs to a person: a flat
   * list cannot say whose coat is whose, and "a coat" is not information.
   *
   * Like `conditions`, this replaces wholesale rather than merging — the cheap model is
   * told to include a character only when their clothing is established or changes, and a
   * merge would make it impossible to clear one.
   */
  outfits?: Record<string, string>;
  notes?: string[];
  /**
   * Character-to-character relationship values.
   *
   * Keyed `"A|B"` with the two names SORTED, so the same pair is one key however the model
   * orders them. Without sorting, `"Ada|Bram"` and `"Bram|Ada"` are two entries that
   * disagree, and the narrator reads both.
   */
  bonds?: Record<string, { bond?: number; sparks?: number; grudge?: number }>;
  /**
   * Plot threads the scene has raised and not resolved, so the narrator can pay them off
   * later instead of losing them.
   */
  threads?: Array<{ text: string; status?: 'open' | 'paid' | 'dropped' }>;
}

/**
 * Words that describe a role rather than name a character.
 *
 * Observed in real state: `present: ["me"]`. A pronoun in a cast list is always wrong —
 * the narrator then has to decide who "me" is, and the reader's own name never appears.
 * Rejecting these is cheap and the failure it prevents is a scene where the user is
 * invisible to the world model.
 *
 * The second group are the world-state block's own field labels. They are here because
 * they were observed doing real damage: a reply that began with a state block — the model
 * echoing the block it was shown — reads to the speaker parser as a script, because
 * `Time: late night, same day` is exactly `name: text`. One such reply added FIVE cast
 * members named `Time`, `Location`, `Present`, `Inventory` and `Outfits`, each with its own
 * voice colour, and they then rendered into the prompt's cast block as
 * "Time (a supporting character)". No story has a character called `Present`, and the cost
 * of refusing one is nil against that.
 */
const NOT_A_NAME: Record<string, true> = {
  me: true, i: true, you: true, them: true, him: true, her: true, us: true, we: true,
  they: true, someone: true, anyone: true, everyone: true, nobody: true, user: true,
  'the user': true, myself: true, yourself: true,
  // The state block's field labels, as rendered by `renderStateBlock`.
  'world state': true, time: true, 'date/time': true, location: true, weather: true, present: true,
  away: true, conditions: true, outfits: true, inventory: true, notes: true,
};

/**
 * Whether a word can be a character's name.
 *
 * Exported because speaker detection in a reply needs exactly this judgement, and a second
 * copy of the list would be a second thing to keep in step. A pronoun is never a name in
 * either context — the narrator writing `You: hello` in a script is the same mistake as
 * `present: ["me"]`, and it produces the same unusable result.
 */
export function isName(value: string): boolean {
  return NOT_A_NAME[value.trim().toLowerCase()] !== true;
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

      case 'outfits': {
        if (value === null) {
          delete next.outfits;
          break;
        }
        // Same shape as `conditions`: an object of names to strings. Empty-string values
        // are KEPT here and dropped at render time by `renderOutfits`, exactly as
        // `renderAway` and `renderConditions` do — making `stringMap` drop them would
        // change those two as well.
        const map = stringMap(value);
        if (!map) {
          return {
            ok: false,
            reason: `"outfits" must be an object with string values or null, got ${describe(value)}`,
          };
        }
        next.outfits = map;
        break;
      }

      case 'bonds': {
        if (value === null) {
          delete next.bonds;
          break;
        }
        const map = asRecord(value);
        if (!map) {
          return { ok: false, reason: `"bonds" must be an object or null, got ${describe(value)}` };
        }
        const bonds: Record<string, { bond?: number; sparks?: number; grudge?: number }> = {};
        for (const [pair, entry] of Object.entries(map)) {
          const fields = asRecord(entry);
          if (!fields) {
            return {
              ok: false,
              reason: `"bonds.${pair}" must be an object, got ${describe(entry)}`,
            };
          }
          const out: { bond?: number; sparks?: number; grudge?: number } = {};
          for (const field of ['bond', 'sparks', 'grudge'] as const) {
            const raw = fields[field];
            if (raw === undefined || raw === null) continue;
            if (typeof raw !== 'number' || !Number.isFinite(raw)) {
              return {
                ok: false,
                reason: `"bonds.${pair}.${field}" must be a number, got ${describe(raw)}`,
              };
            }
            // Clamped, not rejected: a model that writes 999 has the right idea and the
            // wrong scale, and refusing the whole patch would discard every other change
            // with it.
            out[field] = Math.max(-20, Math.min(20, Math.round(raw)));
          }
          if (Object.keys(out).length === 0) continue;
          bonds[sortPair(pair)] = out;
        }
        if (Object.keys(bonds).length > 0) next.bonds = bonds;
        else delete next.bonds;
        break;
      }

      case 'threads': {
        if (value === null) {
          delete next.threads;
          break;
        }
        if (!Array.isArray(value)) {
          return { ok: false, reason: `"threads" must be an array or null, got ${describe(value)}` };
        }
        const threads: Array<{ text: string; status?: 'open' | 'paid' | 'dropped' }> = [];
        for (const entry of value) {
          const record = asRecord(entry);
          if (!record) {
            return {
              ok: false,
              reason: `each "threads" entry must be an object, got ${describe(entry)}`,
            };
          }
          const text = typeof record.text === 'string' ? record.text.trim() : '';
          if (text.length === 0) {
            return { ok: false, reason: 'each "threads" entry needs a non-empty "text"' };
          }
          const status = record.status;
          if (status !== undefined && status !== 'open' && status !== 'paid' && status !== 'dropped') {
            return {
              ok: false,
              reason: `"threads.status" must be open, paid or dropped, got ${describe(status)}`,
            };
          }
          threads.push(status === undefined ? { text } : { text, status });
        }
        if (threads.length > 0) next.threads = threads;
        else delete next.threads;
        break;
      }

      default:
        return { ok: false, reason: `unknown state key "${key}"` };
    }
  }

  // Last, once every key has been applied: a condition on someone who has LEFT is a
  // contradiction the document must not carry.
  //
  // Measured on a real 157-turn chat: the final state had `present: []` and
  // `away.Odile = "gone up the market lane"` while `conditions.Odile` still read
  // "standing in the doorway, ledger under her arm, holding the door open". The narrator
  // reads both lines in the tail and is told she is simultaneously gone and present.
  //
  // The cheap model updates `present`/`away` when someone leaves but has no reason to
  // revisit their condition, so this cannot be left to the model — it is a structural
  // inconsistency, and the same class of thing `present` vs `away` already resolves.
  //
  // A departure is what makes a condition stale, so the condition is DROPPED rather than
  // rewritten: guessing what she is doing wherever she went is invention, and an absent
  // condition is simply less information.
  const present = new Set((next.present as string[] | undefined)?.map((name) => name.toLowerCase()) ?? []);
  const awayNames = new Set(Object.keys((next.away as Record<string, string> | undefined) ?? {}).map((name) => name.toLowerCase()));
  const conditions = next.conditions as Record<string, string> | undefined;
  if (conditions) {
    const kept: Record<string, string> = {};
    let dropped = 0;
    for (const [who, what] of Object.entries(conditions)) {
      const key = who.toLowerCase();
      // Only when the document has actually placed them elsewhere. Someone neither
      // present nor away is unaccounted for, not gone, and their condition may still be
      // current.
      if (awayNames.has(key) && !present.has(key)) {
        dropped += 1;
        continue;
      }
      kept[who] = what;
    }
    if (dropped > 0) {
      console.warn(`[state] dropped ${dropped} condition(s) for characters who have left`);
    }
    if (Object.keys(kept).length > 0) next.conditions = kept;
    else delete next.conditions;
  }

  return { ok: true, next: next as WorldState };
}

/**
 * `"Bram|Ada"` -> `"Ada|Bram"`.
 *
 * The key is the pair, so it must not depend on the order the model wrote them in. A
 * pair written both ways would otherwise be two entries whose values disagree, and the
 * narrator reads both.
 */
function sortPair(pair: string): string {
  const parts = pair.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) return pair.trim();
  return [...parts].sort((a, b) => a.localeCompare(b)).join('|');
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
