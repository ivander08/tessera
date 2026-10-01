/** The opening scene for one greeting. Every field is optional. */
export interface GreetingState {
  time?: string;
  location?: string;
  weather?: string;
}

/**
 * The stored shape of `characters.card_json`.
 *
 * M2.1's known failure class is unwrapping the card envelope correctly and then
 * dropping fields on the floor. Every field below is written explicitly at import
 * time and asserted by the M2 verification query.
 */
export interface CharacterCardJson {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  creatorNotes: string;
  tags: string[];
  characterBook: unknown | null;
  /**
   * The scene each opening starts in, index-aligned with `[firstMes, ...alternateGreetings]`.
   *
   * Index-aligned rather than folded into the greeting text: the greeting is prose the
   * model reads, and a machine-readable time and place must not be part of it. An entry
   * may be absent, or may set only some of the three fields.
   */
  greetingStates?: GreetingState[];
  /** v3 only. */
  nickname?: string;
  /** v3 only. */
  creatorNotesMultilingual?: unknown;
}

export interface ParsedCard extends CharacterCardJson {
  sourceFormat: 'ccv2' | 'ccv3' | 'charx' | 'byaf';
  /**
   * The card's own `avatar` field, when it has one.
   *
   * Usually a remote URL rather than bytes, which is why it is a hint and not an image:
   * storing a URL would make the app fetch from a third party on every render. It is
   * only used when it is a `data:` URL that can be decoded inline.
   */
  avatarHint: string | null;
  /** The untouched source object, kept so nothing is ever unrecoverable. */
  raw: unknown;
}
