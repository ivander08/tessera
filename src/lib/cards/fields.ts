/**
 * Default textarea heights for the card's long fields.
 *
 * One table for both card screens. They previously carried their own numbers and
 * disagreed about the same field — `description` was 4 rows when editing an existing card
 * and 22 when authoring a new one — so a field that read fine in one screen was unusable
 * in the other. Heights are a starting point only: every box is `resize: vertical`
 * (`src/index.css` `textarea.field`).
 *
 * Sizes follow how much text each field actually holds in a real card: `description` is
 * routinely several hundred tokens, while `creator_notes` is a sentence or two.
 */
export const CARD_FIELD_ROWS: Record<string, number> = {
  name: 1,
  nickname: 1,
  description: 14,
  personality: 8,
  scenario: 7,
  systemPrompt: 5,
  mesExample: 10,
  postHistoryInstructions: 5,
  firstMes: 12,
  creatorNotes: 4,
};
