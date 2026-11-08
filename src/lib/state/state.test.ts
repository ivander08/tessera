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
      ['weather', ['rain']],
    ];
    for (const [key, value] of cases) {
      const result = validatePatch({}, { [key]: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(key);
    }
  });

  test('accepts a well-typed patch and returns the merged state', () => {
    const current: WorldState = { location: 'the workshop' };
    const result = validatePatch(current, { time: 'just past midnight', weather: 'clear' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next).toEqual({
      location: 'the workshop',
      time: 'just past midnight',
      weather: 'clear',
    });
  });

  test('null clears a key', () => {
    const current: WorldState = { location: 'the workshop', weather: 'rain' };
    const result = validatePatch(current, { location: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('location' in result.next).toBe(false);
    expect(result.next.weather).toBe('rain');
  });

  test('never mutates the current state', () => {
    const current: WorldState = { location: 'the workshop', weather: 'rain' };
    const snapshot = structuredClone(current);

    const result = validatePatch(current, { location: 'the gate', weather: 'clear' });
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
describe('renderStateBlock', () => {
  test('returns an empty string for an empty state', () => {
    expect(renderStateBlock({})).toBe('');
    expect(renderStateBlock({ location: '', weather: '  ' })).toBe('');
  });

  test('is deterministic under differing key insertion order', () => {
    const a: WorldState = {
      time: 'dusk',
      location: 'the workshop',
      threads: [{ text: 'b' }, { text: 'a' }],
      bonds: { 'Zoe|Ada': { bond: 2 }, 'Ada|Bram': { grudge: 1 } },
    };
    const b: WorldState = {
      bonds: { 'Ada|Bram': { grudge: 1 }, 'Zoe|Ada': { bond: 2 } },
      threads: [{ text: 'b' }, { text: 'a' }],
      location: 'the workshop',
      time: 'dusk',
    };

    const first = renderStateBlock(a);
    expect(renderStateBlock(b)).toBe(first);
    expect(renderStateBlock(a)).toBe(first);
    expect(first).toContain('Location: the workshop');
    expect(first).toContain('- Ada ↔ Bram');
  });

  test('drops bonds before location when over budget', () => {
    const state: WorldState = {
      location: 'the workshop',
      bonds: { 'Ada|Bram': { bond: 4, grudge: 2 } },
    };

    const full = renderStateBlock(state);
    const count = (text: string): number => text.length;

    // A budget that fits location but not location + bonds.
    const budget = 'World state:\nLocation: the workshop'.length;
    expect(full.length).toBeGreaterThan(budget);

    const trimmed = renderStateBlock(state, budget, count);
    expect(trimmed).toContain('Location: the workshop');
    expect(trimmed).not.toContain('Bonds:');
  });

  test('sheds in priority order and keeps at least one section', () => {
    const state: WorldState = {
      time: 'late evening',
      location: 'the workshop',
      weather: 'a wind off the water',
      bonds: { 'Ada|Bram': { bond: 4 } },
    };

    const count = (text: string): number => text.length;
    const withoutBonds = renderStateBlock({ ...state, bonds: {} });
    const kept = renderStateBlock(state, withoutBonds.length, count);

    expect(kept).toContain('Location: the workshop');
    expect(kept).toContain('Date/Time: late evening');
    expect(kept).not.toContain('Bonds:');

    // Even at an impossible budget the block is never empty.
    expect(renderStateBlock(state, 1, count).length).toBeGreaterThan(0);
  });

  test('stays within the default 800-token budget for a large state', () => {
    const state: WorldState = {
      location: 'the workshop',
      threads: Array.from({ length: 200 }, (_, i) => ({
        text: `thread number ${i} with a fair amount of text so the block grows.`,
      })),
    };
    expect(estimateTokens(renderStateBlock(state))).toBeLessThanOrEqual(800);
  });
});

describe('world state: weather and removed fields', () => {
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

  test('the removed fields are ignored rather than rejected', () => {
    // `loadState` and `loadStateAt` parse the stored document through this same validator.
    // A stored row from before the removal must still load, with everything else intact,
    // rather than collapsing to EMPTY_STATE and wiping the scene the reader is in.
    const stored: unknown = JSON.parse(
      '{"inventory":["a map"],"notes":["a note"],"present":["Ada"],"away":{"Bram":"the courtyard"},' +
        '"conditions":{"Ada":"bleeding"},"outfits":{"Ada":"a coat"},"location":"the workshop"}',
    );
    const result = validatePatch({}, stored);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.location).toBe('the workshop');
      for (const key of ['inventory', 'notes', 'present', 'away', 'conditions', 'outfits']) {
        expect(key in result.next).toBe(false);
      }
    }
  });

  test('a patch that re-proposes a removed key does not take the rest of the patch down', () => {
    const result = validatePatch({}, { inventory: ['x'], outfits: { Ada: 'a coat' }, weather: 'rain' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toEqual({ weather: 'rain' });
  });
});


describe('state block: weather', () => {
  test('renders weather after location', () => {
    const block = renderStateBlock({
      time: 'dusk',
      location: 'The docks',
      weather: 'Overcast, light drizzle',
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
   * Shedding is by priority, not by size: bonds and threads go first, then weather,
   * location, time. A budget too tight for the whole block therefore drops the
   * LOWEST-priority section that is present, whatever its length.
   */
  test('sheds weather before time and location', () => {
    const state = {
      time: 'late evening',
      location: 'The Compass Rose',
      weather: 'Overcast, light drizzle, humid, with a wind off the water',
    };
    // A budget that exactly fits the block without weather.
    const budget = estimateTokens(renderStateBlock({ ...state, weather: '' }));
    const tight = renderStateBlock(state, budget, estimateTokens);
    expect(tight).not.toContain('Weather:');
    expect(tight).toContain('Location: The Compass Rose');
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
