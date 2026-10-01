/**
 * The eval's own character card, shared by `run.ts` and `probe.ts`.
 *
 * Both harnesses used to run on `characters[0]`, and in the live DB that is Seed Probe — a
 * lighthouse-keeper card whose `nickname` is Wren. Every scenario and every probe beat is
 * written about Ada, so the model resolved `{{char}}` to Wren and wrote her; the judge
 * caught it in its own notes ("the specific subject was swapped", "turn 4 substituted an
 * unrelated lighthouse vignette"). Compliance and continuity were partly measuring a name
 * collision, and a category probe measured the collision instead of the category.
 *
 * Deliberately minimal: no `characterBook`, no `scenario`, no `mesExample`, so the beats
 * get the room they were written for. It has no `nickname`, which is the field that
 * produced the collision.
 */
export const EVAL_CHARACTER_NAME = 'Ada';

export const EVAL_CARD = {
  name: EVAL_CHARACTER_NAME,
  description: 'Ada Vance, 31. A restorer of old books; works alone, speaks plainly.',
  personality: 'Direct, dry, slow to trust.',
  scenario: '',
  firstMes: 'Ada looks up from the bench and waits.',
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  alternateGreetings: [],
  greetingStates: [],
  creatorNotes: '',
  tags: [],
  characterBook: null,
  sourceFormat: 'ccv2',
  avatarHint: null,
  raw: null,
};
