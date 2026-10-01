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
  /** How the scene is written. */
  craft: Craft;
}

/**
 * How the scene is written.
 *
 * Per-chat rather than global: the register a reader wants for a tense thriller is not the
 * one they want for a slow romance, and both may be open at once. Per-chat rather than
 * per-preset because `chats.preset_id` is single-valued — a craft that lived in a preset
 * could not coexist with an imported preset's prompt list.
 *
 * Every block is independently switchable, including the content policy, so a reader whose
 * own preset already covers one part can suppress just that part. The two enum fields carry
 * an `'off'` member for the same reason a boolean is false.
 *
 * Every field is a closed enum or a boolean, so `parseSceneSetup` validates the whole
 * document the same way it validates the three fields above it.
 */
export interface Craft {
  /**
   * Emit the unrestricted-content policy. On by default; off means the reader's own preset
   * or system prompt governs content instead.
   */
  contentPolicy: boolean;
  /** Narrative person, or `'off'` to let the preset's own instruction stand. */
  pov: 'off' | 'second' | 'first' | 'third';
  /** Prose register, or `'off'`. */
  register: 'off' | 'plain' | 'cinematic' | 'literary';
  /** Ban the constructions that read as machine-written. */
  antiSlop: boolean;
  /** Give NPCs brief, tactical interiority; never the reader's. */
  interiority: boolean;
  /** NPC knowledge is earned, never ambient. */
  earnedKnowledge: boolean;
  /** NPCs have their own wants and may refuse, lose interest, or disagree. */
  independentNpcs: boolean;
  /** Track character-to-character relationships in world state. */
  bonds: boolean;
  /** Track unresolved plot threads in world state. */
  threads: boolean;
}

export const DEFAULT_CRAFT: Craft = {
  contentPolicy: true,
  pov: 'second',
  register: 'cinematic',
  antiSlop: true,
  interiority: true,
  earnedKnowledge: true,
  independentNpcs: true,
  bonds: false,
  threads: false,
};

export const DEFAULT_SCENE_SETUP: SceneSetup = {
  timePace: 'scene',
  stateMode: 'automatic',
  generateOpeningState: true,
  craft: DEFAULT_CRAFT,
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
 * The narrative person. Both enum lists lead with `'off'`, because suppressing the
 * instruction is a first-class choice and not an absent value.
 */
export const POV_OPTIONS: Array<{
  value: Craft['pov'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the preset',
    description: 'Tessera says nothing about narrative person.',
  },
  { value: 'second', label: 'Second person', description: 'The narrator addresses you as "you".' },
  { value: 'first', label: 'First person', description: 'The narrator writes as you.' },
  {
    value: 'third',
    label: 'Third person',
    description: 'The narrator writes your character by name.',
  },
];

export const REGISTER_OPTIONS: Array<{
  value: Craft['register'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the preset',
    description: 'Tessera says nothing about register.',
  },
  {
    value: 'plain',
    label: 'Plain',
    description: 'Direct and unadorned. Say the thing and move.',
  },
  {
    value: 'cinematic',
    label: 'Cinematic',
    description: 'Concrete and visual. Name what is in the room and what it does.',
  },
  {
    value: 'literary',
    label: 'Literary',
    description: 'Weight the sentence as much as the event.',
  },
];

/**
 * The seven switches the craft panel shows, in the order it shows them, with
 * `contentPolicy` first — it is the one a reader arriving from a preset is most likely to
 * change, because their preset already carries its own instructions.
 */
export const CRAFT_TOGGLES: Array<{
  key: 'contentPolicy' | 'antiSlop' | 'interiority' | 'earnedKnowledge' | 'independentNpcs' | 'bonds' | 'threads';
  label: string;
  description: string;
}> = [
  {
    key: 'contentPolicy',
    label: 'Unrestricted content',
    description:
      "Tessera's own unrestricted-content policy. Turn off to let your preset's instructions govern instead.",
  },
  {
    key: 'antiSlop',
    label: 'Anti-slop',
    description: 'Ban the constructions that read as machine-written.',
  },
  {
    key: 'interiority',
    label: 'NPC interiority',
    description: 'Give NPCs brief, tactical interiority; never the reader\'s.',
  },
  {
    key: 'earnedKnowledge',
    label: 'Earned knowledge',
    description: 'NPC knowledge is earned, never ambient.',
  },
  {
    key: 'independentNpcs',
    label: 'Independent NPCs',
    description: 'NPCs have their own wants and may refuse, lose interest, or disagree.',
  },
  {
    key: 'bonds',
    label: 'Track relationships',
    description: 'Track character-to-character relationships in world state.',
  },
  {
    key: 'threads',
    label: 'Track plot threads',
    description: 'Track unresolved plot threads in world state.',
  },
];

const POV_MODES = new Set<string>(POV_OPTIONS.map((option) => option.value));
const REGISTER_MODES = new Set<string>(REGISTER_OPTIONS.map((option) => option.value));

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
    craft: parseCraft(record.craft, fallback.craft),
  };
}

/**
 * The craft document, per field.
 *
 * Same rule as the three fields above: an unreadable value leaves that field alone rather
 * than resetting it. The `fallback` is threaded through rather than reaching for
 * `DEFAULT_CRAFT`, because a patch that mentions one field must not undo the other nine.
 */
function parseCraft(value: unknown, fallback: Craft): Craft {
  const record = asRecord(value);
  if (!record) return { ...fallback };

  const oneOf = <K extends keyof Craft>(key: K, allowed: Set<string>): Craft[K] => {
    const raw = record[key];
    return typeof raw === 'string' && allowed.has(raw) ? (raw as Craft[K]) : fallback[key];
  };
  const flag = <K extends keyof Craft>(key: K): Craft[K] => {
    const raw = record[key];
    return typeof raw === 'boolean' ? (raw as Craft[K]) : fallback[key];
  };

  return {
    contentPolicy: flag('contentPolicy'),
    pov: oneOf('pov', POV_MODES),
    register: oneOf('register', REGISTER_MODES),
    antiSlop: flag('antiSlop'),
    interiority: flag('interiority'),
    earnedKnowledge: flag('earnedKnowledge'),
    independentNpcs: flag('independentNpcs'),
    bonds: flag('bonds'),
    threads: flag('threads'),
  };
}
