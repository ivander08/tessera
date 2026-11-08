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

      // Removed fields. Ignored so a stored document from before their removal still loads
      // instead of collapsing to EMPTY_STATE — the same rule `inventory` and `notes` follow.
      //
      // `present`, `away`, `conditions` and `outfits` were removed because the cheap model
      // could not keep them accurate: a cast list missing someone who walked in, an `away`
      // entry surviving their return, outfits restated from memory rather than the exchange.
      // The transcript already says who is in the room and what they wear; a second, staler
      // record of it is worse than none.
      case 'present':
      case 'away':
      case 'conditions':
      case 'outfits':
      case 'inventory':
      case 'notes':
        continue;

      case 'bonds': {
        if (value === null) {
          delete next.bonds;
          break;
        }
        const map = asRecord(value);
        if (!map) {
          return { ok: false, reason: `"bonds" must be an object or null, got ${describe(value)}` };
        }
        const bonds: Record<string, { bond?: number; sparks?: number; grudge?: number } | null> = {};
        for (const [pair, entry] of Object.entries(map)) {
          // An explicit null on a pair removes it, which is what the panel sends when the
          // reader deletes a relationship row.
          if (entry === null) {
            bonds[sortPair(pair)] = null;
            continue;
          }
          const fields = asRecord(entry);
          if (!fields) {
            return {
              ok: false,
              reason: `"bonds.${pair}" must be an object or null, got ${describe(entry)}`,
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
          // A pair with no values is a pair the model raised without a number for. Kept as
          // an empty object so the panel can show it, which is what the pre-merge code did
          // by `continue`ing past it.
          bonds[sortPair(pair)] = out;
        }
        const merged = mergeBonds(
          next.bonds as Record<string, { bond?: number; sparks?: number; grudge?: number }> | undefined,
          bonds,
        );
        if (Object.keys(merged).length > 0) next.bonds = merged;
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
        const merged = mergeThreads(
          next.threads as Array<{ text: string; status?: 'open' | 'paid' | 'dropped' }> | undefined,
          threads,
        );
        if (merged.length > 0) next.threads = merged;
        else delete next.threads;
        break;
      }

      default:
        return { ok: false, reason: `unknown state key "${key}"` };
    }
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

/**
 * Merge bonds, one pair and one value at a time.
 *
 * Two levels of merge, because the prompt describes two: include a PAIR only when the
 * exchange changes it, and include only the VALUE that changed. A wholesale replace lost
 * the pairs the model left out; replacing a pair's object lost the values it left out.
 */
function mergeBonds(
  current: Record<string, { bond?: number; sparks?: number; grudge?: number }> | undefined,
  incoming: Record<string, { bond?: number; sparks?: number; grudge?: number } | null>,
): Record<string, { bond?: number; sparks?: number; grudge?: number }> {
  const out: Record<string, { bond?: number; sparks?: number; grudge?: number }> = {
    ...(current ?? {}),
  };
  for (const [pair, values] of Object.entries(incoming)) {
    if (values === null) {
      delete out[pair];
      continue;
    }
    out[pair] = { ...(out[pair] ?? {}), ...values };
  }
  return out;
}

/**
 * Merge plot threads, keyed by their text.
 *
 * A thread is identified by what it says, so restating it with a new status updates it and
 * a thread the model does not mention is left alone. `dropped` threads are kept in the
 * document rather than pruned: the renderer filters them out, so they cost no prompt
 * tokens, and the panel still shows the reader what was abandoned.
 */
function mergeThreads(
  current: Array<{ text: string; status?: 'open' | 'paid' | 'dropped' }> | undefined,
  incoming: Array<{ text: string; status?: 'open' | 'paid' | 'dropped' }>,
): Array<{ text: string; status?: 'open' | 'paid' | 'dropped' }> {
  const out = [...(current ?? [])];
  for (const thread of incoming) {
    const at = out.findIndex((entry) => entry.text === thread.text);
    if (at >= 0) out[at] = thread;
    else out.push(thread);
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
