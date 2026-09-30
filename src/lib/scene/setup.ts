import { asRecord } from '../json';

/**
 * How a scene is set up when it opens.
 *
 * Three questions the reader is asked once, before the scene starts: how fast time moves,
 * who maintains the world state, and whether the opening should seed that state from the
 * greeting. They are per-chat because they describe the scene rather than the app — one
 * chat can be a slow afternoon and another a season.
 *
 * Every field is a closed enum or a boolean, so the whole document is a small fixed set.
 * It is stored as JSON (see `migrations/0007_scene_setup.sql`) so the wizard can grow
 * more questions without a migration each time.
 */
export interface SceneSetup {
  /** How much in-world time one exchange advances. */
  timePace: 'minute' | 'hour' | 'scene' | 'manual';
  /** Who maintains the world state. */
  stateMode: 'automatic' | 'manual' | 'off';
  /** Generate time/weather/location/outfits from the greeting when the scene opens. */
  generateOpeningState: boolean;
}

export const DEFAULT_SCENE_SETUP: SceneSetup = {
  timePace: 'scene',
  stateMode: 'automatic',
  generateOpeningState: true,
};

/**
 * The labels and descriptions the wizard shows. Kept here rather than in the wizard so
 * the meaning of a value lives beside the type that defines it — a second copy in the UI
 * is a copy that can drift from what the prompt actually does.
 */
export const TIME_PACE_OPTIONS: Array<{
  value: SceneSetup['timePace'];
  label: string;
  description: string;
}> = [
  { value: 'minute', label: 'Minute by minute', description: '1 exchange ≈ 1 minute' },
  { value: 'hour', label: 'Hourly', description: '1 exchange ≈ 1 hour' },
  {
    value: 'scene',
    label: 'When the writing says so',
    description: 'Time moves only when the writing says so',
  },
  { value: 'manual', label: 'I keep the clock', description: 'I set the clock myself' },
];

export const STATE_MODE_OPTIONS: Array<{
  value: SceneSetup['stateMode'];
  label: string;
  description: string;
}> = [
  {
    value: 'automatic',
    label: 'Automatic',
    description: 'The narrator keeps time, place and weather up to date after each turn.',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'It still runs, but you can correct anything in the world state panel.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Nothing is tracked. The scene carries only what the writing says.',
  },
];

const TIME_PACES = new Set<string>(TIME_PACE_OPTIONS.map((option) => option.value));
const STATE_MODES = new Set<string>(STATE_MODE_OPTIONS.map((option) => option.value));

/**
 * Coerce anything into a valid setup.
 *
 * Per field, not all-or-nothing: a document with one bad value keeps its good ones, so a
 * value written by an older version of the app — or a hand-edited row — degrades to the
 * fallback for that one question rather than silently resetting the reader's choices.
 *
 * `fallback` is what a missing or invalid field becomes. The default is the built-in
 * setup, which is right for reading a stored row. The merge path passes the CURRENT
 * document instead, which is what makes a patch that omits a field — or supplies an
 * unknown enum member — leave that field alone rather than reset it to the default.
 *
 * Never throws. The input comes from a JSON column and from request bodies, so a malformed
 * value is a normal event, not an error: an unreadable setup means "the fallback", which
 * is a working scene.
 */
export function parseSceneSetup(
  value: unknown,
  fallback: SceneSetup = DEFAULT_SCENE_SETUP,
): SceneSetup {
  const record = asRecord(value);
  if (!record) return { ...fallback };

  const timePace = record.timePace;
  const stateMode = record.stateMode;
  const generateOpeningState = record.generateOpeningState;

  return {
    timePace:
      typeof timePace === 'string' && TIME_PACES.has(timePace)
        ? (timePace as SceneSetup['timePace'])
        : fallback.timePace,
    stateMode:
      typeof stateMode === 'string' && STATE_MODES.has(stateMode)
        ? (stateMode as SceneSetup['stateMode'])
        : fallback.stateMode,
    generateOpeningState:
      typeof generateOpeningState === 'boolean'
        ? generateOpeningState
        : fallback.generateOpeningState,
  };
}
