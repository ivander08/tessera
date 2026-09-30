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
      ['inventory', [1, 2]],
      ['notes', 'a note'],
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
    const current: WorldState = { location: 'the workshop', present: ['Ada'], notes: ['a'] };
    const result = validatePatch(current, { location: null, notes: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('location' in result.next).toBe(false);
    expect('notes' in result.next).toBe(false);
    expect(result.next.present).toEqual(['Ada']);
  });

  test('never mutates the current state', () => {
    const current: WorldState = { location: 'the workshop', present: ['Ada'], notes: ['a'] };
    const snapshot = structuredClone(current);

    const result = validatePatch(current, { location: 'the gate', present: null, notes: ['b'] });
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

describe('renderStateBlock', () => {
  test('returns an empty string for an empty state', () => {
    expect(renderStateBlock({})).toBe('');
    expect(renderStateBlock({ location: '', present: [], notes: ['  '] })).toBe('');
  });

  test('is deterministic under differing key insertion order', () => {
    const a: WorldState = {
      time: 'dusk',
      location: 'the workshop',
      present: ['Ada', 'Bram'],
      inventory: ['lamp', 'key'],
      conditions: { Ada: 'bleeding', Bram: 'calm' },
      notes: ['the door is barred'],
    };
    const b: WorldState = {
      notes: ['the door is barred'],
      conditions: { Bram: 'calm', Ada: 'bleeding' },
      inventory: ['lamp', 'key'],
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

  test('drops notes before location when over budget', () => {
    const state: WorldState = {
      location: 'the workshop',
      notes: ['a note that costs tokens', 'another note that costs tokens'],
    };

    const full = renderStateBlock(state);
    const count = (text: string): number => text.length;

    // A budget that fits location but not location + notes.
    const budget = 'World state:\nLocation: the workshop'.length;
    expect(full.length).toBeGreaterThan(budget);

    const trimmed = renderStateBlock(state, budget, count);
    expect(trimmed).toContain('Location: the workshop');
    expect(trimmed).not.toContain('Notes:');
  });

  test('sheds in priority order and keeps at least one section', () => {
    const state: WorldState = {
      location: 'the workshop',
      present: ['Ada'],
      inventory: ['lamp'],
      conditions: { Ada: 'bleeding' },
      notes: ['something'],
    };

    const count = (text: string): number => text.length;
    const withoutNotes = renderStateBlock({ ...state, notes: [] });
    const kept = renderStateBlock(state, withoutNotes.length, count);

    expect(kept).toContain('Location: the workshop');
    expect(kept).toContain('Present: Ada');
    expect(kept).not.toContain('Notes:');

    // Even at an impossible budget the block is never empty.
    expect(renderStateBlock(state, 1, count).length).toBeGreaterThan(0);
  });

  test('stays within the default 800-token budget for a large state', () => {
    const state: WorldState = {
      location: 'the workshop',
      present: Array.from({ length: 40 }, (_, i) => `Character ${i}`),
      notes: Array.from({ length: 200 }, (_, i) => `Note number ${i} with a fair amount of text.`),
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

  test('does not apply the name filter to inventory or notes', () => {
    // "me" is a bad character name but a plausible note or inventory entry in prose.
    const result = validatePatch({}, { inventory: ['a map of me'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.inventory).toEqual(['a map of me']);
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
   * Shedding is by priority, not by size: notes go first, then inventory, conditions,
   * weather, cast, location, time. A budget too tight for the whole block therefore drops
   * the LOWEST-priority section that is present, whatever its length — so weather goes
   * before the cast list even when the cast list is what does not fit.
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
      inventory: ['tube'],
      notes: ['something'],
    };
    const tight = renderStateBlock(state, 20);
    expect(tight).toContain('Time: late evening');
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
