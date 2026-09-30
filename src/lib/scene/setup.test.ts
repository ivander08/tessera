import { describe, expect, test } from 'bun:test';
import { DEFAULT_SCENE_SETUP, parseSceneSetup, type SceneSetup } from './setup';

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
    const setup: SceneSetup = { timePace: 'hour', stateMode: 'off', generateOpeningState: false };
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
    const stored = { timePace: 'hour', stateMode: 'manual', generateOpeningState: false } as const;
    expect(parseSceneSetup({ timePace: 'bogus' }, { ...stored }).timePace).toBe('hour');
    expect(parseSceneSetup(null, { ...stored })).toEqual(stored);
    // And a valid value still wins over the fallback.
    expect(parseSceneSetup({ timePace: 'minute' }, { ...stored }).timePace).toBe('minute');
  });
});
