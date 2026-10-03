import { describe, expect, test } from 'bun:test';
import { DEFAULT_CRAFT, DEFAULT_SCENE_SETUP, parseSceneSetup, type SceneSetup } from './setup';

/**
 * The setup document is read from a JSON column and from request bodies, so every value
 * it sees is untrusted. The rule that matters: a bad value degrades to the default FOR
 * THAT FIELD, and never takes the good fields with it — a reader who chose "manual" must
 * not lose that because an older version wrote an unknown pace.
 */
describe('parseSceneSetup', () => {
  test('returns the defaults for a value that is not an object', () => {
    for (const value of [null, undefined, 'x', 7, [], true]) {
      expect(parseSceneSetup(value)).toEqual(DEFAULT_SCENE_SETUP);
    }
  });

  test('returns the defaults for an empty object', () => {
    expect(parseSceneSetup({})).toEqual(DEFAULT_SCENE_SETUP);
  });

  test('keeps a valid document', () => {
    const setup: SceneSetup = {
      timePace: 'hour',
      stateMode: 'off',
      generateOpeningState: false,
      craft: DEFAULT_CRAFT,
    };
    expect(parseSceneSetup(setup)).toEqual(setup);
  });

  test('an unknown enum member falls back per field, keeping its valid siblings', () => {
    // This is the whole reason the coercion is per field rather than all-or-nothing.
    const parsed = parseSceneSetup({ timePace: 'bogus', stateMode: 'off' });
    expect(parsed.timePace).toBe(DEFAULT_SCENE_SETUP.timePace);
    expect(parsed.stateMode).toBe('off');
  });

  test('a wrong-typed boolean falls back without disturbing the enums', () => {
    const parsed = parseSceneSetup({ timePace: 'minute', generateOpeningState: 'yes' });
    expect(parsed.timePace).toBe('minute');
    expect(parsed.generateOpeningState).toBe(DEFAULT_SCENE_SETUP.generateOpeningState);
  });

  test('ignores unknown keys rather than carrying them through', () => {
    const parsed = parseSceneSetup({ timePace: 'hour', somethingElse: 1 });
    expect(parsed).toEqual({ ...DEFAULT_SCENE_SETUP, timePace: 'hour' });
  });

  test('never throws, whatever it is handed', () => {
    // A malformed row is a normal event, not an error: "unconfigured" is a working scene.
    expect(() => parseSceneSetup({ timePace: { nested: true } })).not.toThrow();
    expect(parseSceneSetup({ timePace: { nested: true } }).timePace).toBe(
      DEFAULT_SCENE_SETUP.timePace,
    );
  });

  test('a supplied fallback replaces the built-in default for invalid fields', () => {
    // This is what the PATCH merge relies on: an invalid value in a patch must land on
    // the STORED value, not on the built-in default, or a typo would undo a choice.
    const stored: SceneSetup = {
      timePace: 'hour',
      stateMode: 'manual',
      generateOpeningState: false,
      craft: DEFAULT_CRAFT,
    };
    expect(parseSceneSetup({ timePace: 'bogus' }, { ...stored }).timePace).toBe('hour');
    expect(parseSceneSetup(null, { ...stored })).toEqual(stored);
    // And a valid value still wins over the fallback.
    expect(parseSceneSetup({ timePace: 'minute' }, { ...stored }).timePace).toBe('minute');
  });
});

describe('parseSceneSetup — craft', () => {
  test('an empty document carries the default craft', () => {
    expect(parseSceneSetup({}).craft).toEqual(DEFAULT_CRAFT);
  });

  test('a patch that mentions one field leaves the others at the fallback', () => {
    const parsed = parseSceneSetup({ craft: { pov: 'third' } });
    expect(parsed.craft.pov).toBe('third');
    expect(parsed.craft.register).toBe(DEFAULT_CRAFT.register);
  });

  test('an unknown enum member falls back to the FALLBACK, not the built-in default', () => {
    // The whole reason the craft parse threads `fallback` through: a client that does not
    // know about a field must not silently reset a choice the reader made.
    const custom: SceneSetup = {
      ...DEFAULT_SCENE_SETUP,
      craft: { ...DEFAULT_CRAFT, pov: 'first', register: 'plain' },
    };
    const parsed = parseSceneSetup({ craft: { pov: 'nonsense' } }, custom);
    expect(parsed.craft.pov).toBe('first');
    expect(parsed.craft.register).toBe('plain');
  });

  test('a wrong-typed boolean keeps the fallback boolean', () => {
    expect(parseSceneSetup({ craft: { antiSlop: 'yes' } }).craft.antiSlop).toBe(
      DEFAULT_CRAFT.antiSlop,
    );
  });

  test('round-trips through JSON', () => {
    const setup: SceneSetup = {
      timePace: 'hour',
      stateMode: 'manual',
      generateOpeningState: false,
      craft: {
        contentPolicy: false,
        pov: 'third',
        register: 'literary',
        antiSlop: false,
        interiority: true,
        earnedKnowledge: false,
        independentNpcs: true,
        vocalisation: false,
        antiParrot: false,
        stagnation: true,
        impulseFirst: false,
        subtext: true,
        dialogueState: false,
        livingWorld: true,
        sideCharacters: false,
        nomenclature: true,
        wordplay: true,
        dialects: true,
        momentum: 'driving',
        tense: 'present',
        showTell: 'show',
        narrativeDistance: 'fid',
        responseLength: 'adaptiveLong',
        density: 'dense',
        rhythm: 'percussive',
        figurative: 'saturated',
        vocabulary: 'ornate',
        profanity: 'heavy',
        dialogueFrequency: 'talkative',
        dialogueNaturalism: 'verbatim',
        dialogueDepth: 'philosophical',
        changeResistance: 'entrenched',
        traitAdherence: 'exaggerated',
        consequence: 'reset',
        bonds: true,
        threads: false,
      },
    };
    expect(parseSceneSetup(JSON.parse(JSON.stringify(setup)))).toEqual(setup);
  });

  test('an unknown member of a new enum falls back per field', () => {
    const parsed = parseSceneSetup({
      craft: { momentum: 'nonsense', dialogueDepth: 'nonsense' },
    });
    expect(parsed.craft.momentum).toBe(DEFAULT_CRAFT.momentum);
    expect(parsed.craft.dialogueDepth).toBe(DEFAULT_CRAFT.dialogueDepth);
  });

  test('a new boolean with a wrong type falls back', () => {
    const parsed = parseSceneSetup({ craft: { antiParrot: 'yes', livingWorld: 1 } });
    expect(parsed.craft.antiParrot).toBe(DEFAULT_CRAFT.antiParrot);
    expect(parsed.craft.livingWorld).toBe(DEFAULT_CRAFT.livingWorld);
  });

  test('a patch turning vocalisation off leaves the other craft fields at the fallback', () => {
    const parsed = parseSceneSetup({ craft: { vocalisation: false } });
    expect(parsed.craft.vocalisation).toBe(false);
    expect(parsed.craft.antiSlop).toBe(DEFAULT_CRAFT.antiSlop);
    expect(parsed.craft.independentNpcs).toBe(DEFAULT_CRAFT.independentNpcs);
  });

  test('the content policy is a flag on craft, not a separate document', () => {
    expect('nsfw' in parseSceneSetup({}).craft).toBe(false);
  });
});
