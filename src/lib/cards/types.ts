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
  /** v3 only. */
  nickname?: string;
  /** v3 only. */
  creatorNotesMultilingual?: unknown;
}

export interface ParsedCard extends CharacterCardJson {
  sourceFormat: 'ccv2' | 'ccv3' | 'charx' | 'byaf';
  /** The untouched source object, kept so nothing is ever unrecoverable. */
  raw: unknown;
}
