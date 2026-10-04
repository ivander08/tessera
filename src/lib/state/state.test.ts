import { describe, expect, test } from 'bun:test';
import { EMPTY_STATE, validatePatch } from './schema';
import type { WorldState } from './schema';
import { renderStateBlock } from '../prompt/stateBlock';
import { estimateTokens } from '../tokenEstimate';

describe('validatePatch', () => {
  test('rejects a patch that is not an object', () => {
    for (const bad of [null, 'location', 7, ['location']]) {
      const result = validatePatch({}, bad);
      expect(result.ok).toBe(false);
    }
    expect(validatePatch({}, null).ok).toBe(false);
    expect(validatePatch({}, { location: 'x' }).ok).toBe(true);
  });

  test('rejects an unknown key instead of dropping it', () => {
    // A dropped key is the dangerous case: the model believes it recorded the change
    // and the prompt never shows it, so the model re-proposes it forever.
    const result = validatePatch({ location: 'the workshop' }, { mood: 'tense' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('mood');
  });

  test('rejects prototype keys, which JSON.parse can produce as own properties', () => {
    // `{"__proto__":{...}}` parsed from JSON is an OWN enumerable key, so it reaches
    // the loop. Assigning it would set the prototype rather than a data property.
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    const result = validatePatch({}, patch);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('rejects a wrong type for a known key', () => {
    const cases: Array<[string, unknown]> = [
      ['location', 42],
      ['time', { hour: 3 }],
      ['present', 'Ada'],
      ['conditions', { Ada: 3 }],
      ['conditions', ['Ada']],
    ];
    for (const [key, value] of cases) {
      const result = validatePatch({}, { [key]: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(key);
    }
  });

  test('accepts a well-typed patch and returns the merged state', () => {
    const current: WorldState = { location: 'the workshop', present: ['Ada'] };
    const result = validatePatch(current, {
      time: 'just past midnight',
      present: ['Ada', 'Bram'],
      conditions: { Ada: 'bleeding' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next).toEqual({
      location: 'the workshop',
      time: 'just past midnight',
      present: ['Ada', 'Bram'],
      conditions: { Ada: 'bleeding' },
    });
  });

  test('null clears a key', () => {
    const current: WorldState = { location: 'the workshop', present: ['Ada'], conditions: { Ada: 'tired' } };
    const result = validatePatch(current, { location: null, conditions: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('location' in result.next).toBe(false);
    expect('conditions' in result.next).toBe(false);
    expect(result.next.present).toEqual(['Ada']);
  });

  test('never mutates the current state', () => {
    const current: WorldState = { location: 'the workshop', present: ['Ada'], conditions: { Ada: 'tired' } };
    const snapshot = structuredClone(current);

    const result = validatePatch(current, { location: 'the gate', present: null, conditions: { Ada: 'calm' } });
    expect(result.ok).toBe(true);
    expect(current).toEqual(snapshot);

    // A rejected patch must not mutate either.
    validatePatch(current, { nonsense: true });
    expect(current).toEqual(snapshot);
  });

  test('an empty patch leaves the state untouched', () => {
    const current: WorldState = { location: 'the workshop' };
    const result = validatePatch(current, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toEqual(current);
  });

  test('EMPTY_STATE cannot be mutated through a returned merge', () => {
    const result = validatePatch(EMPTY_STATE, { location: 'the gate' });
    expect(result.ok).toBe(true);
    expect(EMPTY_STATE).toEqual({});
  });
});

describe('validatePatch — bonds and threads', () => {
  test('a bond round-trips', () => {
    const result = validatePatch({}, { bonds: { 'Ada|Bram': { bond: 4 } } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.bonds).toEqual({ 'Ada|Bram': { bond: 4 } });
  });

  test('a pair written the other way round is stored sorted', () => {
    // Otherwise "Ada|Bram" and "Bram|Ada" are two entries that disagree, and the
    // narrator reads both.
    const result = validatePatch({}, { bonds: { 'Bram|Ada': { bond: 4 } } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.next.bonds!)).toEqual(['Ada|Bram']);
  });

  test('a value out of range is clamped, not rejected', () => {
    // The model has the right idea and the wrong scale; refusing would discard the rest
    // of the patch with it.
    const high = validatePatch({}, { bonds: { 'A|B': { bond: 9999 } } });
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.next.bonds!['A|B'].bond).toBe(20);

    const low = validatePatch({}, { bonds: { 'A|B': { bond: -9999 } } });
    expect(low.ok).toBe(true);
    if (low.ok) expect(low.next.bonds!['A|B'].bond).toBe(-20);
  });

  test('a malformed bond is rejected with a reason naming the pair', () => {
    const result = validatePatch({}, { bonds: { 'Ada|Bram': 'close' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('bonds.Ada|Bram');
  });

  test('a thread round-trips, and an empty one is rejected', () => {
    const ok = validatePatch({}, { threads: [{ text: 'the letter' }] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.next.threads).toEqual([{ text: 'the letter' }]);

    const empty = validatePatch({}, { threads: [{ text: '' }] });
    expect(empty.ok).toBe(false);

    const badStatus = validatePatch({}, { threads: [{ text: 'x', status: 'maybe' }] });
    expect(badStatus.ok).toBe(false);
  });

  test('null clears both keys', () => {
    const current: WorldState = {
      bonds: { 'A|B': { bond: 3 } },
      threads: [{ text: 'the letter' }],
    };
    const result = validatePatch(current, { bonds: null, threads: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('bonds' in result.next).toBe(false);
      expect('threads' in result.next).toBe(false);
    }
  });
});

/**
 * The name-keyed maps MERGE, because the prompt tells the model to include an entry only
 * when it CHANGED. Replacing the map wholesale contradicted that: every entry the model
 * correctly declined to restate was deleted. Measured on the live cheap model, three
 * seeded conditions lost two of them inside a single turn.
 */
describe('name-keyed maps merge rather than replace', () => {
  test('an entry the patch does not mention is kept', () => {
    const current: WorldState = {
      conditions: { Ada: 'bleeding', Bram: 'calm', Cass: 'wet' },
      outfits: { Ada: 'grey dress', Bram: 'fisherman knit' },
    };
    const result = validatePatch(current, {
      conditions: { Ada: 'bandaged' },
      outfits: { Bram: 'oilskin coat' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.conditions).toEqual({ Ada: 'bandaged', Bram: 'calm', Cass: 'wet' });
    expect(result.next.outfits).toEqual({ Ada: 'grey dress', Bram: 'oilskin coat' });
  });

  test('an explicit null removes exactly that entry', () => {
    // The deletion signal. Without it, an entry could only be removed by clearing the
    // whole field, which is what made these maps impossible to maintain.
    const current: WorldState = { conditions: { Ada: 'bleeding', Bram: 'calm' } };
    const result = validatePatch(current, { conditions: { Ada: null } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.conditions).toEqual({ Bram: 'calm' });
  });

  test('removing the last entry drops the key entirely', () => {
    const current: WorldState = { conditions: { Ada: 'bleeding' } };
    const result = validatePatch(current, { conditions: { Ada: null } });
    expect(result.ok).toBe(true);
    if (result.ok) expect('conditions' in result.next).toBe(false);
  });

  test('a bond merges per pair AND per value', () => {
    // The prompt describes two levels: include a pair only when it changed, and include
    // only the value that changed. Both levels have to merge or one of them is lost.
    const current: WorldState = {
      bonds: { 'Ada|Bram': { bond: 4, sparks: 2 }, 'Ada|Cass': { grudge: 6 } },
    };
    const result = validatePatch(current, { bonds: { 'Ada|Bram': { bond: 7 } } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.bonds).toEqual({
      'Ada|Bram': { bond: 7, sparks: 2 },
      'Ada|Cass': { grudge: 6 },
    });
  });

  test('an explicit null on a bond pair removes it', () => {
    const current: WorldState = { bonds: { 'Ada|Bram': { bond: 4 }, 'Ada|Cass': { grudge: 6 } } };
    const result = validatePatch(current, { bonds: { 'Ada|Bram': null } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.bonds).toEqual({ 'Ada|Cass': { grudge: 6 } });
  });

  test('threads merge by text, and a thread the patch omits is kept', () => {
    const current: WorldState = {
      threads: [{ text: 'the letter' }, { text: 'the debt', status: 'open' }],
    };
    const result = validatePatch(current, { threads: [{ text: 'the debt', status: 'paid' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.threads).toEqual([
      { text: 'the letter' },
      { text: 'the debt', status: 'paid' },
    ]);
  });

  test('a new thread is appended rather than replacing the list', () => {
    const current: WorldState = { threads: [{ text: 'the letter' }] };
    const result = validatePatch(current, { threads: [{ text: 'the key' }] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.threads).toEqual([{ text: 'the letter' }, { text: 'the key' }]);
    }
  });
});

describe('renderStateBlock', () => {
  test('returns an empty string for an empty state', () => {
    expect(renderStateBlock({})).toBe('');
    expect(renderStateBlock({ location: '', present: [], conditions: { Ada: '  ' } })).toBe('');
  });

  test('is deterministic under differing key insertion order', () => {
    const a: WorldState = {
      time: 'dusk',
      location: 'the workshop',
      present: ['Ada', 'Bram'],
      conditions: { Ada: 'bleeding', Bram: 'calm' },
      outfits: { Ada: 'apron' },
    };
    const b: WorldState = {
      outfits: { Ada: 'apron' },
      conditions: { Bram: 'calm', Ada: 'bleeding' },
      present: ['Ada', 'Bram'],
      location: 'the workshop',
      time: 'dusk',
    };

    const first = renderStateBlock(a);
    expect(renderStateBlock(b)).toBe(first);
    expect(renderStateBlock(a)).toBe(first);
    expect(first).toContain('Location: the workshop');
    expect(first).toContain('Conditions: Ada (bleeding); Bram (calm)');
  });

  test('drops conditions before location when over budget', () => {
    const state: WorldState = {
      location: 'the workshop',
      conditions: { Ada: 'bleeding badly and holding the door shut' },
    };

    const full = renderStateBlock(state);
    const count = (text: string): number => text.length;

    // A budget that fits location but not location + conditions.
    const budget = 'World state:\nLocation: the workshop'.length;
    expect(full.length).toBeGreaterThan(budget);

    const trimmed = renderStateBlock(state, budget, count);
    expect(trimmed).toContain('Location: the workshop');
    expect(trimmed).not.toContain('Conditions:');
  });

  test('sheds in priority order and keeps at least one section', () => {
    const state: WorldState = {
      location: 'the workshop',
      present: ['Ada'],
      conditions: { Ada: 'bleeding' },
      outfits: { Ada: 'an ink-stained apron with three pockets' },
    };

    const count = (text: string): number => text.length;
    const withoutConditions = renderStateBlock({ ...state, conditions: {} });
    const kept = renderStateBlock(state, withoutConditions.length, count);

    expect(kept).toContain('Location: the workshop');
    expect(kept).toContain('Present: Ada');
    expect(kept).not.toContain('Conditions:');

    // Even at an impossible budget the block is never empty.
    expect(renderStateBlock(state, 1, count).length).toBeGreaterThan(0);
  });

  test('stays within the default 800-token budget for a large state', () => {
    const state: WorldState = {
      location: 'the workshop',
      present: Array.from({ length: 40 }, (_, i) => `Character ${i}`),
      conditions: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`Character ${i}`, `condition number ${i} with a fair amount of text.`]),
      ),
    };
    expect(estimateTokens(renderStateBlock(state))).toBeLessThanOrEqual(800);
  });
});

describe('world state: weather and cast hygiene', () => {
  test('accepts a weather field', () => {
    const result = validatePatch({}, { weather: 'Overcast, light drizzle' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.weather).toBe('Overcast, light drizzle');
  });

  test('clears weather with null like the other scalars', () => {
    const result = validatePatch({ weather: 'rain' }, { weather: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.weather).toBeUndefined();
  });

  /**
   * Observed in real stored state: `present: ["me"]`. A pronoun in a cast list makes the
   * reader invisible to the world model, and the narrator then has to guess who "me" is.
   */
  test('drops pronouns from the cast list without rejecting the patch', () => {
    const result = validatePatch({}, { present: ['Ada', 'me', 'the user', 'Ivan'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.present).toEqual(['Ada', 'Ivan']);
  });

  test('keeps a cast list that is already clean', () => {
    const result = validatePatch({}, { present: ['Ada', 'Ivan'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.present).toEqual(['Ada', 'Ivan']);
  });

  test('an all-pronoun cast list becomes empty rather than wrong', () => {
    const result = validatePatch({}, { present: ['me', 'you'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.present).toEqual([]);
  });

  test('the removed fields are ignored rather than rejected', () => {
    // `loadState` and `loadStateAt` parse the stored document through this same validator.
    // A stored row from before the removal must still load, with everything else intact,
    // rather than collapsing to EMPTY_STATE and wiping the scene the reader is in.
    const stored: unknown = JSON.parse(
      '{"inventory":["a map of me"],"notes":["a note"],"location":"the workshop","present":["Ada"]}',
    );
    const result = validatePatch({}, stored);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.location).toBe('the workshop');
      expect(result.next.present).toEqual(['Ada']);
      expect('inventory' in result.next).toBe(false);
      expect('notes' in result.next).toBe(false);
    }
  });

  test('a patch that re-proposes a removed key does not take the rest of the patch down', () => {
    const result = validatePatch({}, { inventory: ['x'], notes: ['y'], weather: 'rain' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toEqual({ weather: 'rain' });
  });
});

/**
 * `away` is what stops the narrator writing someone into a room they walked out of, so
 * the one thing it must never do is contradict `present`.
 */
describe('world state: characters who have left', () => {
  test('records where someone went', () => {
    const result = validatePatch({ present: ['Ada'] }, { away: { Bram: 'the courtyard' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.away).toEqual({ Bram: 'the courtyard' });
  });

  test('a departure moves someone out of present', () => {
    const result = validatePatch(
      { present: ['Ada', 'Bram'] },
      { present: ['Ada'], away: { Bram: 'the courtyard' } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.present).toEqual(['Ada']);
      expect(result.next.away).toEqual({ Bram: 'the courtyard' });
    }
  });

  test('someone listed as present is not also elsewhere', () => {
    // A model that writes both is confused; rendering the contradiction would tell the
    // narrator that Bram is in the room and out of it. Present wins — the reader can see
    // who is there.
    const result = validatePatch(
      { present: ['Bram'], away: { Bram: 'the courtyard', Ada: 'the gate' } },
      { present: ['Bram'] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.away).toEqual({ Ada: 'the gate' });
  });

  test('a returning character leaves no stale away entry', () => {
    const result = validatePatch(
      { present: ['Ada'], away: { Bram: 'the courtyard' } },
      { present: ['Ada', 'Bram'] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.away).toBeUndefined();
  });

  test('pronouns are dropped from away, like present', () => {
    const result = validatePatch({}, { away: { me: 'the kitchen', Bram: 'the gate' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.away).toEqual({ Bram: 'the gate' });
  });

  test('clears with null, and an emptied map disappears', () => {
    const cleared = validatePatch({ away: { Bram: 'the gate' } }, { away: null });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.next.away).toBeUndefined();

    // Every entry filtered out is the same as clearing it: an empty record would render
    // as a heading with nothing under it.
    const emptied = validatePatch({}, { away: { me: 'somewhere' } });
    expect(emptied.ok).toBe(true);
    if (emptied.ok) expect(emptied.next.away).toBeUndefined();
  });

  test('rejects a value that is not a name -> place map', () => {
    const result = validatePatch({}, { away: ['Bram'] });
    expect(result.ok).toBe(false);
  });
});

describe('state block: weather', () => {
  test('renders weather between location and the cast', () => {
    const block = renderStateBlock({
      time: 'dusk',
      location: 'The docks',
      weather: 'Overcast, light drizzle',
      present: ['Ada'],
    });
    const lines = block.split('\n');
    expect(lines.indexOf('Weather: Overcast, light drizzle')).toBe(
      lines.indexOf('Location: The docks') + 1,
    );
  });

  test('omits an empty weather line rather than emitting a bare label', () => {
    expect(renderStateBlock({ weather: '   ' })).toBe('');
  });

  /**
   * Shedding is by priority, not by size: bonds and threads go first, then conditions,
   * outfits, away, weather, cast, location, time. A budget too tight for the whole block
   * therefore drops the LOWEST-priority section that is present, whatever its length — so
   * weather goes before the cast list even when the cast list is what does not fit.
   */
  test('sheds weather before the cast list', () => {
    const state = {
      time: 'late evening',
      location: 'The Compass Rose',
      weather: 'Overcast, light drizzle, humid, with a wind off the water',
      present: ['Ada', 'Ivan'],
    };
    // Room for time, location and cast, but not weather as well.
    const tight = renderStateBlock(state, 32);
    expect(tight).not.toContain('Weather:');
    expect(tight).toContain('Present: Ada, Ivan');
  });

  test('keeps time and location longest', () => {
    const state = {
      time: 'late evening',
      location: 'The Compass Rose',
      weather: 'Overcast',
      present: ['Ada'],
    };
    const tight = renderStateBlock(state, 20);
    expect(tight).toContain('Date/Time: late evening');
  });
});

/**
 * The rendered block is what the narrator actually reads, so a section that exists in
 * the document but never renders is a feature that does not work.
 */
describe('state block: characters elsewhere', () => {
  test('renders away right after present, so the two read together', () => {
    const block = renderStateBlock({
      location: 'The scriptorium',
      present: ['Ada'],
      away: { Bram: 'the courtyard' },
    });
    const lines = block.split('\n');
    expect(lines.indexOf('Elsewhere: Bram is at the courtyard')).toBe(
      lines.indexOf('Present: Ada') + 1,
    );
  });

  test('sorts entries by name rather than by insertion order', () => {
    // A record's iteration order is insertion order, so without a sort the same state
    // would render differently depending on which patch happened to write it first.
    const block = renderStateBlock({ away: { Zoe: 'the gate', Ada: 'the well' } });
    expect(block).toContain('Elsewhere: Ada is at the well; Zoe is at the gate');
  });

  test('omits the section entirely when nobody is away', () => {
    const block = renderStateBlock({ location: 'The scriptorium', present: ['Ada'] });
    expect(block).not.toContain('Elsewhere');
  });
});

/**
 * Outfits: what each character is wearing.
 *
 * Keyed by name rather than held in a flat list, because a flat list cannot say whose coat
 * is whose — "a coat" is not information. Every assertion here is about the two properties
 * that make it usable: it is per-character, and it renders identically every turn.
 */
describe('world state: outfits', () => {
  test('accepts a name -> outfit map', () => {
    const result = validatePatch({}, { outfits: { Sydney: 'blazer' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.outfits?.Sydney).toBe('blazer');
  });

  test('rejects a value that is not a name -> outfit map', () => {
    // Same shape as `away`: a string, an array and a non-string value are all rejected
    // whole rather than coerced.
    expect(validatePatch({}, { outfits: 'blazer' }).ok).toBe(false);
    expect(validatePatch({}, { outfits: ['blazer'] }).ok).toBe(false);
    expect(validatePatch({}, { outfits: { Sydney: 3 } }).ok).toBe(false);
  });

  test('merges into the map rather than replacing it, and null removes one entry', () => {
    // This used to assert the opposite, on the reasoning that a merge "would make it
    // impossible to clear one character". That reasoning was wrong twice over: it made
    // every entry the model declined to restate disappear, and clearing one is exactly
    // what an explicit null is for.
    const result = validatePatch({ outfits: { A: 'x', C: 'z' } }, { outfits: { B: 'y' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.outfits).toEqual({ A: 'x', C: 'z', B: 'y' });

    const removed = validatePatch({ outfits: { A: 'x', B: 'y' } }, { outfits: { A: null } });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.next.outfits).toEqual({ B: 'y' });
  });

  test('clears with null', () => {
    const result = validatePatch({ outfits: { A: 'x' } }, { outfits: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.outfits).toBeUndefined();
  });

  test('a patch mixing valid outfits with an unknown key is rejected whole', () => {
    // The all-or-nothing contract, asserted for this key: a partially applied patch
    // would leave the model believing it recorded something the state never took.
    const result = validatePatch({}, { outfits: { A: 'x' }, nonsense: true });
    expect(result.ok).toBe(false);
  });

  test('renders one line per character, sorted by name', () => {
    const block = renderStateBlock({
      location: 'The scriptorium',
      outfits: { Zoe: 'riding leathers', Ada: 'ink-stained apron' },
    });
    expect(block).toContain('Outfits: Ada: ink-stained apron; Zoe: riding leathers');
  });

  test('an entry with an empty value renders nothing', () => {
    const block = renderStateBlock({ outfits: { Ada: '   ' } });
    expect(block).not.toContain('Outfits');
    // And the same state with a real value does render, so the filter is not hiding a
    // broken renderer.
    expect(renderStateBlock({ outfits: { Ada: 'apron' } })).toContain('Outfits: Ada: apron');
  });

  test('is deterministic under differing insertion order', () => {
    const first = renderStateBlock({ outfits: { Zoe: 'leathers', Ada: 'apron' } });
    const second = renderStateBlock({ outfits: { Ada: 'apron', Zoe: 'leathers' } });
    expect(first).toBe(second);
  });

  test('sheds outfits before away and after conditions', () => {
    const state = {
      time: 'late evening',
      location: 'The scriptorium',
      present: ['Ada'],
      away: { Bram: 'the courtyard' },
      conditions: { Ada: 'tired' },
      outfits: { Ada: 'an ink-stained apron with three pockets and a torn hem' },
    };
    const full = renderStateBlock(state, 1000);
    expect(full).toContain('Conditions:');
    expect(full).toContain('Outfits:');
    expect(full).toContain('Elsewhere:');

    // Just too tight for everything: conditions go first, then the outfits, and the
    // characters are the last to be given up.
    const tight = renderStateBlock(state, 34);
    expect(tight).not.toContain('Conditions:');
    expect(tight).toContain('Present: Ada');
  });
});

/**
 * The document must not contradict itself about who is in the scene.
 *
 * Found on a real 157-turn chat: the final state held `present: []` and
 * `away.Odile = "gone up the market lane"` while `conditions.Odile` still read
 * "standing in the doorway, ledger under her arm, holding the door open". The narrator
 * reads both lines and is told she is simultaneously gone and present.
 *
 * The cheap model updates `present`/`away` when someone leaves and has no reason to
 * revisit their condition, so this cannot be left to the model.
 */
describe('world state: conditions versus presence', () => {
  test('a condition is dropped when the character has left the scene', () => {
    const result = validatePatch(
      { conditions: { Odile: 'standing in the doorway' } },
      { present: [], away: { Odile: 'gone up the market lane' } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.conditions).toBeUndefined();
      expect(result.next.away).toEqual({ Odile: 'gone up the market lane' });
    }
  });

  test('a condition survives while the character is present', () => {
    const result = validatePatch({}, { present: ['Ada'], conditions: { Ada: 'tired' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.conditions).toEqual({ Ada: 'tired' });
  });

  test('a condition survives for someone the document does not place at all', () => {
    // Neither present nor away is unaccounted for, not gone. Dropping the condition would
    // lose a fact the scene may still be using.
    const result = validatePatch({}, { conditions: { Ada: 'tired' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.conditions).toEqual({ Ada: 'tired' });
  });

  test('only the departed character loses their condition', () => {
    const result = validatePatch(
      { conditions: { Ada: 'tired', Bram: 'bleeding' } },
      { present: ['Ada'], away: { Bram: 'the courtyard' } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.conditions).toEqual({ Ada: 'tired' });
  });

  test('a character who returns keeps a condition written for them afterwards', () => {
    // The drop happens on the patch that places them away, not forever: once they are
    // back, a new condition for them is legitimate.
    const away = validatePatch(
      { conditions: { Ada: 'tired' } },
      { present: [], away: { Ada: 'the courtyard' } },
    );
    expect(away.ok).toBe(true);
    if (away.ok) expect(away.next.conditions).toBeUndefined();

    const back = validatePatch(away.ok ? away.next : {}, { present: ['Ada'], conditions: { Ada: 'wary' } });
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.next.conditions).toEqual({ Ada: 'wary' });
  });
});

describe('world state: bonds and threads rendering', () => {
  test('bonds render sorted, joined with an arrow, and omit a zero value', () => {
    const block = renderStateBlock({
      bonds: { 'Ada|Zoe': { bond: 3, sparks: 0 }, 'Ada|Bram': { grudge: 2 } },
    });
    expect(block).toContain('Bonds:');
    // Sorted by key, so the insertion order of the map cannot leak out.
    expect(block).toContain('- Ada ↔ Bram | grudge 2');
    expect(block).toContain('- Ada ↔ Zoe | bond 3');
    // sparks is zero, so it is not shown.
    expect(block).not.toContain('sparks 0');
  });

  test('threads render open and paid, and omit dropped', () => {
    const block = renderStateBlock({
      threads: [
        { text: 'the letter' },
        { text: 'the meeting', status: 'paid' },
        { text: 'the rumour', status: 'dropped' },
      ],
    });
    expect(block).toContain('Threads:');
    expect(block).toContain('- [open] the letter');
    expect(block).toContain('- [paid] the meeting');
    expect(block).not.toContain('the rumour');
  });

  test('both sections can be switched off, and the default keeps them on', () => {
    const state = {
      location: 'The workshop',
      bonds: { 'A|B': { bond: 3 } },
      threads: [{ text: 'the letter' }],
    };
    const off = renderStateBlock(state, 800, estimateTokens, { bonds: false, threads: false });
    expect(off).not.toContain('Bonds:');
    expect(off).not.toContain('Threads:');
    expect(off).toContain('Location: The workshop');

    // Backwards compatibility: a caller that does not pass options keeps both.
    const dflt = renderStateBlock(state);
    expect(dflt).toContain('Bonds:');
    expect(dflt).toContain('Threads:');
  });

  test('is deterministic under differing insertion order', () => {
    const first = renderStateBlock({
      bonds: { 'B|A': { bond: 1 }, 'D|C': { bond: 2 } },
      threads: [{ text: 'z' }, { text: 'a' }],
    });
    const second = renderStateBlock({
      bonds: { 'D|C': { bond: 2 }, 'B|A': { bond: 1 } },
      threads: [{ text: 'a' }, { text: 'z' }],
    });
    expect(first).toBe(second);
  });
});
