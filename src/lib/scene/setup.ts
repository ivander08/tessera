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
  /**
   * How in-world time moves.
   *
   * There used to be five choices — auto, minute, hour, scene, manual — and the first four
   * were all the same instruction ("move the clock") with a different multiplier, which the
   * cheap model then had to apply by doing clock arithmetic it is bad at. Measured: a plain
   * exchange left the clock unchanged for several turns, and "10 minutes pass" advanced it
   * by a minute or not at all. The reader is not asked to pick a broken dial.
   *
   * So time is SYSTEM-managed: the model reports only the elapsed minutes it read out of
   * the exchange and `advanceClock` does the addition. `manual` survives as the one
   * deliberate opt-out, for a reader who wants to keep the clock themselves.
   */
  timePace: 'auto' | 'manual';
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
  /** Write what the body sounds like, and let speech break under stress. */
  vocalisation: boolean;
  /** Characters never echo the reader's words back. */
  antiParrot: boolean;
  /** Something changes every turn; no reused gestures or beat shapes. */
  stagnation: boolean;
  /** The flaw-driven urge fires before reason; empathy degrades under hunger and injury. */
  impulseFirst: boolean;
  /** Characters deflect, misread, and never need the last clever line. */
  subtext: boolean;
  /** Anger, fear, drink, lies and exhaustion change how a character speaks. */
  dialogueState: boolean;
  /** The world moves without the reader; a returning place keeps a detail. */
  livingWorld: boolean;
  /** Every new side character is distinct, flawed, and mid-activity. */
  sideCharacters: boolean;
  /** New names are rooted in the setting, never generic fantasy. */
  nomenclature: boolean;
  /** Comedy mode: idioms taken literally, jokes unacknowledged. */
  wordplay: boolean;
  /** Regional speech textures for new voices. */
  dialects: boolean;
  /** How far a reply may go past the reader's input. */
  momentum: 'off' | 'responsive' | 'active' | 'driving';
  /** Narration tense, or `'off'` to let the greeting establish it. */
  tense: 'off' | 'past' | 'present';
  /** How directly emotion is stated. */
  showTell: 'off' | 'show' | 'showWeighted' | 'balanced' | 'tellWeighted' | 'tell' | 'adaptive';
  /** How close narration sits to the POV character. */
  narrativeDistance:
    | 'off'
    | 'remote'
    | 'objective'
    | 'standard'
    | 'close'
    | 'fid'
    | 'adaptive';
  /** How long a reply runs. */
  responseLength:
    | 'off'
    | 'short'
    | 'medium'
    | 'long'
    | 'noLimit'
    | 'adaptiveShort'
    | 'adaptiveMedium'
    | 'adaptiveLong';
  /** Sentences per paragraph. */
  density: 'off' | 'minimal' | 'light' | 'standard' | 'full' | 'dense' | 'adaptive';
  /** Sentence length and shape. */
  rhythm: 'off' | 'uniform' | 'sprawling' | 'percussive' | 'dynamic';
  /** How much imagery the prose uses. */
  figurative: 'off' | 'none' | 'sparse' | 'moderate' | 'rich' | 'saturated' | 'adaptive';
  /** Word choice level. */
  vocabulary: 'off' | 'plain' | 'clean' | 'literary' | 'ornate' | 'purple' | 'adaptive';
  /** How much the narration swears. */
  profanity: 'off' | 'lightly' | 'natural' | 'heavy' | 'settingAppropriate';
  /** How much of a reply is dialogue. */
  dialogueFrequency: 'off' | 'silent' | 'sparse' | 'balanced' | 'often' | 'talkative';
  /** How clean speech is. */
  dialogueNaturalism: 'off' | 'literary' | 'casual' | 'verbatim';
  /** How deep conversations go. */
  dialogueDepth:
    | 'off'
    | 'surface'
    | 'simple'
    | 'grounded'
    | 'layered'
    | 'philosophical'
    | 'realistic';
  /** How hard characters are to move. */
  changeResistance: 'off' | 'fluid' | 'responsive' | 'resistant' | 'entrenched' | 'adaptive';
  /** How hard card traits show. */
  traitAdherence: 'off' | 'natural' | 'restrained' | 'pronounced' | 'exaggerated';
  /** How injuries and damage carry over. */
  consequence: 'off' | 'realistic' | 'persistent' | 'soft' | 'reset';
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
  vocalisation: true,
  antiParrot: true,
  stagnation: true,
  impulseFirst: true,
  subtext: true,
  dialogueState: true,
  livingWorld: true,
  sideCharacters: true,
  nomenclature: true,
  wordplay: false,
  dialects: false,
  momentum: 'active',
  tense: 'off',
  showTell: 'balanced',
  narrativeDistance: 'close',
  responseLength: 'adaptiveMedium',
  density: 'standard',
  rhythm: 'dynamic',
  figurative: 'adaptive',
  vocabulary: 'adaptive',
  profanity: 'natural',
  dialogueFrequency: 'balanced',
  dialogueNaturalism: 'casual',
  dialogueDepth: 'realistic',
  changeResistance: 'adaptive',
  traitAdherence: 'natural',
  consequence: 'realistic',
  bonds: false,
  threads: false,
};

export const DEFAULT_SCENE_SETUP: SceneSetup = {
  timePace: 'auto',
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
  {
    value: 'auto',
    label: 'Managed for you',
    description:
      'The clock moves by what the exchange covers — minutes for a conversation, hours for a skip, overnight for a night\'s sleep.',
  },
  {
    value: 'manual',
    label: 'I keep the clock',
    description: 'Nothing advances it. It changes only when you write a time yourself.',
  },
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
 * The sixteen craft enums ported from the reader's preset work. Every list leads with
 * `'off'`, the same first-class choice as `POV_OPTIONS`, and each description is the
 * sentence the prompt block emits for that member — kept here so the panel and the
 * prompt cannot drift apart.
 */
export const MOMENTUM_OPTIONS: Array<{
  value: Craft['momentum'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'responsive',
    label: 'Responsive',
    description:
      "The turn resolves the reader's input and stops. Nothing beyond the input: no new consequences, no new events.",
  },
  {
    value: 'active',
    label: 'Active',
    description:
      "The turn resolves the reader's input and carries the scene forward on its own: characters pursue their own aims and events continue whether or not the reader drives them.",
  },
  {
    value: 'driving',
    label: 'Driving',
    description:
      'Every turn ends on an unresolved action, arrival, question, or threat from someone other than the POV character that demands a response. Characters pursue their own aims whether or not the reader drives them.',
  },
];

export const TENSE_OPTIONS: Array<{
  value: Craft['tense'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'The greeting sets the tense; Tessera says nothing.',
  },
  { value: 'past', label: 'Past', description: 'Narration is in past tense.' },
  { value: 'present', label: 'Present', description: 'Narration is in present tense.' },
];

export const SHOW_TELL_OPTIONS: Array<{
  value: Craft['showTell'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'show',
    label: 'Pure show',
    description:
      'Emotion and character traits are never stated; both come through action, physical response, dialogue, and what the character attends to.',
  },
  {
    value: 'showWeighted',
    label: 'Show weighted',
    description:
      'Emotion and traits come through physical action by default; a direct statement appears only where behavior would be ambiguous.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description:
      'Emotion and traits may be named where naming is efficient, and shown through physical action otherwise.',
  },
  {
    value: 'tellWeighted',
    label: 'Tell weighted',
    description:
      "Emotion and traits are stated directly; behavior supplements the statement, and showing is reserved for the scene's strongest beats.",
  },
  {
    value: 'tell',
    label: 'Pure tell',
    description:
      'Emotions and traits are reported plainly: the narration says what characters feel and are.',
  },
  {
    value: 'adaptive',
    label: 'Adaptive',
    description:
      'Show by default; tell where efficiency matters more than immersion — minor beats, transitions, and background characters are stated plainly.',
  },
];

export const DISTANCE_OPTIONS: Array<{
  value: Craft['narrativeDistance'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'remote',
    label: 'Remote',
    description:
      'Narration observes from outside every character. Interiority is unavailable; no thoughts are shown.',
  },
  {
    value: 'objective',
    label: 'Objective',
    description:
      'Actions and sensations are reported; no internal thoughts or feelings of anyone, including the POV character.',
  },
  {
    value: 'standard',
    label: 'Standard',
    description:
      "The POV character's thoughts and feelings are reported, but the narration keeps its own voice; thoughts appear in italics.",
  },
  {
    value: 'close',
    label: 'Close',
    description:
      "Narration takes on the POV character's perceptions and biases: what gets noticed, ignored, assumed, or misread reflects who they are and their state of mind.",
  },
  {
    value: 'fid',
    label: 'Free indirect discourse',
    description:
      "The narrative voice and the POV character's voice merge: their diction, judgments, and distortions appear in the narration itself, without attribution or italics.",
  },
  {
    value: 'adaptive',
    label: 'Adaptive',
    description:
      "Narration takes its attitude from the POV character's temperament, mood, and relationship to the scene: what they find funny is narrated as funny, what they dread is narrated as ominous.",
  },
];

export const LENGTH_OPTIONS: Array<{
  value: Craft['responseLength'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'short',
    label: 'Short',
    description:
      'The reply runs under four paragraphs; paragraphs that are dialogue do not count toward the limit.',
  },
  {
    value: 'medium',
    label: 'Medium',
    description:
      'The reply runs under eight paragraphs; paragraphs that are dialogue do not count toward the limit.',
  },
  {
    value: 'long',
    label: 'Long',
    description:
      'The reply runs four to twelve or more paragraphs; paragraphs that are dialogue do not count toward the limit.',
  },
  {
    value: 'noLimit',
    label: 'No set limit',
    description:
      'The reply is as long as the scene demands: do not pad, and end early rather than filling space.',
  },
  {
    value: 'adaptiveShort',
    label: 'Adaptive short',
    description:
      'Length follows the beat: developmental under four paragraphs, transitional under three, reactive under two, climax under six. Dialogue paragraphs do not count.',
  },
  {
    value: 'adaptiveMedium',
    label: 'Adaptive medium',
    description:
      'Length follows the beat: developmental under eight, transitional under four, reactive under three, climax under ten. Dialogue paragraphs do not count.',
  },
  {
    value: 'adaptiveLong',
    label: 'Adaptive long',
    description:
      'Length follows the beat: developmental under nine, transitional under five, reactive under four, climax twelve or more. Dialogue paragraphs do not count.',
  },
];

export const DENSITY_OPTIONS: Array<{
  value: Craft['density'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'minimal',
    label: 'Minimal',
    description:
      'One to two sentences of narration per paragraph; frequent breaks, heavy white space.',
  },
  {
    value: 'light',
    label: 'Light',
    description: 'One to three sentences of narration per paragraph; breaks come often.',
  },
  {
    value: 'standard',
    label: 'Standard',
    description:
      'One to five sentences per paragraph: conventional novel paragraphing. A paragraph holds one beat and closes.',
  },
  {
    value: 'full',
    label: 'Full',
    description:
      'One to eight sentences per paragraph; paragraphs accumulate detail before breaking.',
  },
  {
    value: 'dense',
    label: 'Dense',
    description: 'Eight or more sentences per paragraph; breaks only at hard shifts in subject or scene.',
  },
  {
    value: 'adaptive',
    label: 'Adaptive',
    description:
      'Sentences per paragraph follow the beat: developmental and transitional 1-5, reactive 1-2, climax up to 8.',
  },
];

export const RHYTHM_OPTIONS: Array<{
  value: Craft['rhythm'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'uniform',
    label: 'Uniform',
    description:
      'Sentences hold a consistent length and shape; little variation between adjacent sentences.',
  },
  { value: 'sprawling', label: 'Sprawling', description: 'Long, clause-heavy sentences are the default.' },
  {
    value: 'percussive',
    label: 'Percussive',
    description: 'Short, punchy sentences dominate; fragments are permitted.',
  },
  {
    value: 'dynamic',
    label: 'Dynamic',
    description:
      'Sentence length follows what the scene is doing: physical action gets short sentences and fragments with visceral verbs; interiority and observation get longer, subordinated sentences.',
  },
];

export const FIGURATIVE_OPTIONS: Array<{
  value: Craft['figurative'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'none',
    label: 'None',
    description: 'No figurative language. Descriptions are literal and direct.',
  },
  {
    value: 'sparse',
    label: 'Sparse',
    description:
      'One figurative image per reply, reserved for a moment that carries weight; most description stays literal.',
  },
  {
    value: 'moderate',
    label: 'Moderate',
    description:
      'Roughly one figurative image per several paragraphs, reserved for moments that carry weight.',
  },
  {
    value: 'rich',
    label: 'Rich',
    description: 'Multiple figurative images per paragraph; comparison is a primary descriptive tool.',
  },
  {
    value: 'saturated',
    label: 'Saturated',
    description:
      'Figurative language governs: images extend, compound, and sustain across sentences.',
  },
  {
    value: 'adaptive',
    label: 'Adaptive',
    description:
      'Default to literal description. Figurative language is reserved for beats that carry weight — emotional turns, first sight of something significant, moments of extremity; routine action and functional description stay literal.',
  },
];

export const VOCABULARY_OPTIONS: Array<{
  value: Craft['vocabulary'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  { value: 'plain', label: 'Plain', description: 'Everyday words.' },
  { value: 'clean', label: 'Clean', description: 'Standard novel diction.' },
  {
    value: 'literary',
    label: 'Literary',
    description:
      'Deliberate, textured diction: an uncommon word where it carries meaning a common word would not.',
  },
  {
    value: 'ornate',
    label: 'Ornate',
    description:
      'Elevated register throughout: formal syntax, Latinate word choice, rare and archaic words used freely.',
  },
  {
    value: 'purple',
    label: 'Purple',
    description:
      'Elevated register throughout, unbound: formal syntax, Latinate and archaic word choice pushed past ornament.',
  },
  {
    value: 'adaptive',
    label: 'Adaptive',
    description:
      'Word choice derives from the POV character: class, education, age, occupation, and era.',
  },
];

export const PROFANITY_OPTIONS: Array<{
  value: Craft['profanity'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'lightly',
    label: 'Light',
    description: 'Narration and dialogue swear lightly: damn and hell equivalents only.',
  },
  {
    value: 'natural',
    label: 'Natural',
    description:
      'Characters and narration swear as much as the situation warrants; explicit swears are allowed.',
  },
  {
    value: 'heavy',
    label: 'Heavy',
    description: 'Profanity is a normal part of speech and narration: frequent and strong.',
  },
  {
    value: 'settingAppropriate',
    label: 'Setting appropriate',
    description:
      'Profanity follows the setting: modern settings use modern profanity, period settings use period profanity.',
  },
];

export const DIALOGUE_FREQUENCY_OPTIONS: Array<{
  value: Craft['dialogueFrequency'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'silent',
    label: 'Silent',
    description:
      'Dialogue is rare: scenes are carried by action, observation, and interiority; characters speak only when speech is the only option. Aim for 0-10% dialogue.',
  },
  {
    value: 'sparse',
    label: 'Sparse',
    description:
      'A few exchanged lines per conversation, with narration doing the primary work between them. Aim for 20-30% dialogue.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Conversations run to natural length: roughly half dialogue, half narration.',
  },
  {
    value: 'often',
    label: 'Often',
    description:
      'Speech leads: most scenes are built around conversation, with narration as connective tissue. Aim for 70% dialogue.',
  },
  {
    value: 'talkative',
    label: 'Talkative',
    description: 'Dialogue dominates: extended turns, minimal staging. Aim for 80-90% dialogue.',
  },
];

export const DIALOGUE_NATURALISM_OPTIONS: Array<{
  value: Craft['dialogueNaturalism'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'literary',
    label: 'Literary',
    description:
      'Speech stays clean and purposeful: contractions and fragments are natural and interruptions happen, but no filler words and no stumbling.',
  },
  {
    value: 'casual',
    label: 'Casual',
    description:
      'Speech loosens: slang, regional phrasing, fragments, characters talking over each other and trailing off.',
  },
  {
    value: 'verbatim',
    label: 'Verbatim',
    description:
      'Full disfluency: filler words, false starts, self-corrections, repetitions, trailing sentences. Disfluency scales with emotional state — calm speech is close to casual; stress, drunkenness, exhaustion, or grief break it apart.',
  },
];

export const DIALOGUE_DEPTH_OPTIONS: Array<{
  value: Craft['dialogueDepth'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'surface',
    label: 'Surface',
    description: 'Speech is factual and direct: what characters want, see, and feel right now.',
  },
  { value: 'simple', label: 'Simple', description: 'Talk stays concrete and present-tense in scope.' },
  {
    value: 'grounded',
    label: 'Grounded',
    description:
      'Occasional reflection tied closely to the scene; an abstraction stays short and returns to the concrete.',
  },
  {
    value: 'layered',
    label: 'Layered',
    description:
      'Conversations carry more than their surface: characters argue past the ostensible subject, and abstraction is present.',
  },
  {
    value: 'philosophical',
    label: 'Philosophical',
    description:
      'Characters theorize and generalize; digressions are permitted and extended — a conversation may leave its subject and not return.',
  },
  {
    value: 'realistic',
    label: 'Realistic',
    description:
      'Depth follows the speaker and the moment: functional exchanges stay functional; pressure, intimacy, and idleness are when characters reach for larger statements. Education, temperament, and self-awareness cap how abstract a character gets.',
  },
];

export const CHANGE_RESISTANCE_OPTIONS: Array<{
  value: Craft['changeResistance'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'fluid',
    label: 'Fluid',
    description:
      'Characters update readily: a single strong scene can shift a stance, and new information is absorbed easily.',
  },
  {
    value: 'responsive',
    label: 'Responsive',
    description: 'One significant event, or several smaller converging ones, is enough to move a character.',
  },
  {
    value: 'resistant',
    label: 'Resistant',
    description:
      'Change requires sustained cause and comes with backsliding: progress made in one scene is partially lost by the next.',
  },
  {
    value: 'entrenched',
    label: 'Entrenched',
    description:
      'Characters return to baseline: change requires overwhelming, repeated cause, and even then registers as strain rather than transformation. A position abandoned in one scene is usually reoccupied by the following one.',
  },
  {
    value: 'adaptive',
    label: 'Adaptive',
    description:
      'Resistance scales: preferences, tactics, and surface opinions move easily; identity-level convictions and beliefs tied to self-image require sustained pressure and resist reverting.',
  },
];

export const TRAIT_ADHERENCE_OPTIONS: Array<{
  value: Craft['traitAdherence'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  { value: 'natural', label: 'Natural', description: 'Traits reliably inform behavior.' },
  {
    value: 'restrained',
    label: 'Restrained',
    description:
      'Traits surface selectively: characters act on them when circumstances call for it and behave unremarkably otherwise.',
  },
  {
    value: 'pronounced',
    label: 'Pronounced',
    description: 'Traits are visible in most choices; characters are recognizable from a single scene.',
  },
  {
    value: 'exaggerated',
    label: 'Exaggerated',
    description:
      'Traits are expressed past realistic proportion: characters read as heightened versions of their description.',
  },
];

export const CONSEQUENCE_OPTIONS: Array<{
  value: Craft['consequence'];
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Leave it to the card',
    description: 'Tessera says nothing about this.',
  },
  {
    value: 'realistic',
    label: 'Realistic',
    description:
      'Injury, damage, and loss do not reverse: wounds heal at realistic rates or not at all, broken things stay broken unless repaired, and the dead stay dead.',
  },
  {
    value: 'persistent',
    label: 'Persistent',
    description:
      'Damage carries forward but does not accumulate: injuries heal faster than realistically, property is repaired between scenes, and nothing resets within a scene.',
  },
  {
    value: 'soft',
    label: 'Soft',
    description:
      'Damage matters while a scene is running and fades between scenes: characters arrive at the next scene functional.',
  },
  {
    value: 'reset',
    label: 'Resets',
    description:
      'Damage and injuries matter while a scene is running and are gone by the next: characters arrive healed, destruction repaired.',
  },
];

/**
 * The eighteen switches the craft panel shows, in the order it shows them, with
 * `contentPolicy` first — it is the one a reader arriving from a preset is most likely to
 * change, because their preset already carries its own instructions. State-tracking
 * toggles stay last, apart from the prose rules.
 */
export const CRAFT_TOGGLES: Array<{
  key:
    | 'contentPolicy'
    | 'antiSlop'
    | 'interiority'
    | 'earnedKnowledge'
    | 'independentNpcs'
    | 'vocalisation'
    | 'antiParrot'
    | 'stagnation'
    | 'impulseFirst'
    | 'subtext'
    | 'dialogueState'
    | 'livingWorld'
    | 'sideCharacters'
    | 'nomenclature'
    | 'wordplay'
    | 'dialects'
    | 'bonds'
    | 'threads';
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
    key: 'vocalisation',
    label: 'Vocalisation',
    description: 'Write what the body sounds like, and let speech break under stress.',
  },
  {
    key: 'antiParrot',
    label: 'Anti-parrot',
    description: 'Characters never echo your words back.',
  },
  {
    key: 'stagnation',
    label: 'Forward motion',
    description: 'Every turn changes something; no reused gestures or beat shapes.',
  },
  {
    key: 'impulseFirst',
    label: 'Impulse first',
    description: 'The flaw fires before reason; empathy degrades under hunger and injury.',
  },
  {
    key: 'subtext',
    label: 'Subtext',
    description: 'Characters deflect, misread, and never need the last clever line.',
  },
  {
    key: 'dialogueState',
    label: 'Dialogue state',
    description: 'Anger, fear, drink, lies and exhaustion change how a character speaks.',
  },
  {
    key: 'livingWorld',
    label: 'Living world',
    description: 'The world moves without you; returning places keep a detail.',
  },
  {
    key: 'sideCharacters',
    label: 'Side characters',
    description: 'Each new side character is distinct, flawed, and mid-activity.',
  },
  {
    key: 'nomenclature',
    label: 'Nomenclature',
    description: 'New names are rooted in the setting, never generic fantasy.',
  },
  {
    key: 'wordplay',
    label: 'Wordplay',
    description: 'Comedy mode: idioms taken literally, jokes unacknowledged.',
  },
  {
    key: 'dialects',
    label: 'Dialects',
    description: 'Regional speech textures for new voices.',
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
const MOMENTUM_MODES = new Set<string>(MOMENTUM_OPTIONS.map((option) => option.value));
const TENSE_MODES = new Set<string>(TENSE_OPTIONS.map((option) => option.value));
const SHOW_TELL_MODES = new Set<string>(SHOW_TELL_OPTIONS.map((option) => option.value));
const DISTANCE_MODES = new Set<string>(DISTANCE_OPTIONS.map((option) => option.value));
const LENGTH_MODES = new Set<string>(LENGTH_OPTIONS.map((option) => option.value));
const DENSITY_MODES = new Set<string>(DENSITY_OPTIONS.map((option) => option.value));
const RHYTHM_MODES = new Set<string>(RHYTHM_OPTIONS.map((option) => option.value));
const FIGURATIVE_MODES = new Set<string>(FIGURATIVE_OPTIONS.map((option) => option.value));
const VOCABULARY_MODES = new Set<string>(VOCABULARY_OPTIONS.map((option) => option.value));
const PROFANITY_MODES = new Set<string>(PROFANITY_OPTIONS.map((option) => option.value));
const DIALOGUE_FREQUENCY_MODES = new Set<string>(
  DIALOGUE_FREQUENCY_OPTIONS.map((option) => option.value),
);
const DIALOGUE_NATURALISM_MODES = new Set<string>(
  DIALOGUE_NATURALISM_OPTIONS.map((option) => option.value),
);
const DIALOGUE_DEPTH_MODES = new Set<string>(DIALOGUE_DEPTH_OPTIONS.map((option) => option.value));
const CHANGE_RESISTANCE_MODES = new Set<string>(
  CHANGE_RESISTANCE_OPTIONS.map((option) => option.value),
);
const TRAIT_ADHERENCE_MODES = new Set<string>(
  TRAIT_ADHERENCE_OPTIONS.map((option) => option.value),
);
const CONSEQUENCE_MODES = new Set<string>(CONSEQUENCE_OPTIONS.map((option) => option.value));

/** One row's shape in the craft panel: a label, a hint and a dropdown. */
interface CraftEnumRow {
  key: keyof Craft;
  label: string;
  description: string;
  options: Array<{ value: string; label: string; description: string }>;
}

/**
 * Every enum-valued craft control, in panel order. `pov` and `register` are the first two
 * entries; rendering them through the same map as the rest is what keeps one row pattern
 * in the panel instead of two.
 */
export const CRAFT_ENUMS: CraftEnumRow[] = [
  {
    key: 'pov',
    label: 'Narrative person',
    description: 'How the narrator addresses the reader.',
    options: POV_OPTIONS,
  },
  {
    key: 'register',
    label: 'Prose register',
    description: 'How the prose is weighted.',
    options: REGISTER_OPTIONS,
  },
  {
    key: 'momentum',
    label: 'Plot momentum',
    description: 'How far a reply may go past your input.',
    options: MOMENTUM_OPTIONS,
  },
  { key: 'tense', label: 'Tense', description: 'Narration tense.', options: TENSE_OPTIONS },
  {
    key: 'showTell',
    label: 'Show vs tell',
    description: 'How directly emotion is stated.',
    options: SHOW_TELL_OPTIONS,
  },
  {
    key: 'narrativeDistance',
    label: 'Narrative distance',
    description: 'How close narration sits to the POV character.',
    options: DISTANCE_OPTIONS,
  },
  {
    key: 'responseLength',
    label: 'Response length',
    description: 'How long a reply runs.',
    options: LENGTH_OPTIONS,
  },
  {
    key: 'density',
    label: 'Paragraph density',
    description: 'Sentences per paragraph.',
    options: DENSITY_OPTIONS,
  },
  {
    key: 'rhythm',
    label: 'Sentence rhythm',
    description: 'Sentence length and shape.',
    options: RHYTHM_OPTIONS,
  },
  {
    key: 'figurative',
    label: 'Figurative language',
    description: 'How much imagery the prose uses.',
    options: FIGURATIVE_OPTIONS,
  },
  {
    key: 'vocabulary',
    label: 'Vocabulary',
    description: 'Word choice level.',
    options: VOCABULARY_OPTIONS,
  },
  {
    key: 'profanity',
    label: 'Profanity',
    description: 'How much the narration swears.',
    options: PROFANITY_OPTIONS,
  },
  {
    key: 'dialogueFrequency',
    label: 'Dialogue frequency',
    description: 'How much of a reply is dialogue.',
    options: DIALOGUE_FREQUENCY_OPTIONS,
  },
  {
    key: 'dialogueNaturalism',
    label: 'Dialogue naturalism',
    description: 'How clean speech is.',
    options: DIALOGUE_NATURALISM_OPTIONS,
  },
  {
    key: 'dialogueDepth',
    label: 'Dialogue depth',
    description: 'How deep conversations go.',
    options: DIALOGUE_DEPTH_OPTIONS,
  },
  {
    key: 'changeResistance',
    label: 'Change resistance',
    description: 'How hard characters are to move.',
    options: CHANGE_RESISTANCE_OPTIONS,
  },
  {
    key: 'traitAdherence',
    label: 'Trait adherence',
    description: 'How hard card traits show.',
    options: TRAIT_ADHERENCE_OPTIONS,
  },
  {
    key: 'consequence',
    label: 'Consequence persistence',
    description: 'How injuries and damage carry over.',
    options: CONSEQUENCE_OPTIONS,
  },
];

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
    vocalisation: flag('vocalisation'),
    antiParrot: flag('antiParrot'),
    stagnation: flag('stagnation'),
    impulseFirst: flag('impulseFirst'),
    subtext: flag('subtext'),
    dialogueState: flag('dialogueState'),
    livingWorld: flag('livingWorld'),
    sideCharacters: flag('sideCharacters'),
    nomenclature: flag('nomenclature'),
    wordplay: flag('wordplay'),
    dialects: flag('dialects'),
    momentum: oneOf('momentum', MOMENTUM_MODES),
    tense: oneOf('tense', TENSE_MODES),
    showTell: oneOf('showTell', SHOW_TELL_MODES),
    narrativeDistance: oneOf('narrativeDistance', DISTANCE_MODES),
    responseLength: oneOf('responseLength', LENGTH_MODES),
    density: oneOf('density', DENSITY_MODES),
    rhythm: oneOf('rhythm', RHYTHM_MODES),
    figurative: oneOf('figurative', FIGURATIVE_MODES),
    vocabulary: oneOf('vocabulary', VOCABULARY_MODES),
    profanity: oneOf('profanity', PROFANITY_MODES),
    dialogueFrequency: oneOf('dialogueFrequency', DIALOGUE_FREQUENCY_MODES),
    dialogueNaturalism: oneOf('dialogueNaturalism', DIALOGUE_NATURALISM_MODES),
    dialogueDepth: oneOf('dialogueDepth', DIALOGUE_DEPTH_MODES),
    changeResistance: oneOf('changeResistance', CHANGE_RESISTANCE_MODES),
    traitAdherence: oneOf('traitAdherence', TRAIT_ADHERENCE_MODES),
    consequence: oneOf('consequence', CONSEQUENCE_MODES),
    bonds: flag('bonds'),
    threads: flag('threads'),
  };
}
