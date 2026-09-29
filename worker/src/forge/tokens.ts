import { complete, parseJsonReply } from '../cheap';
import { asRecord, asStringArray } from '../../../src/lib/json';
import type { ParsedCard } from '../../../src/lib/cards/types';

export type SuggestField = 'tags' | 'alternate_greetings' | 'first_mes';

/**
 * Each helper is a separate call rather than one call with a mode switch: the three
 * want different instructions, and one merged prompt produces a compromise answer for
 * all three.
 */
const SYSTEMS: Record<SuggestField, string> = {
  tags: `You write tags for character cards. The user sends you a card as JSON. Return ONLY a JSON object: {"suggestions": string[]}.

Five to ten tags. Lowercase, one to three words each, no punctuation, no duplicates. Tag what the card actually is — archetype, setting, tone, relationship dynamic, genre — not the character's name and not adjectives that fit anything ("interesting", "well-written"). Existing tags are given; do not repeat them.

No prose outside the JSON. No code fences.`,

  alternate_greetings: `You write alternate opening messages for character cards. The user sends you a card as JSON. Return ONLY a JSON object: {"suggestions": string[]}.

Three openings. Each is a different situation that drops the user into the same character at a different moment — a different place, a different mood, a different reason the two of them are in the same room. Each is written in {{char}}'s voice, present tense, prose, roughly the length of the card's existing first_mes.

The rule that matters: give the user something concrete to react to — a question, an object, a gesture, a decision pending — WITHOUT dictating what the user does, says, thinks, or feels. Never write {{user}}'s words, actions, or reactions, and never narrate the user's interior state. The opening ends with the situation open, not resolved.

No prose outside the JSON. No code fences.`,

  first_mes: `You write the opening message of a character card. The user sends you a card as JSON. Return ONLY a JSON object: {"suggestions": string[]}.

One or two openings, in {{char}}'s voice, present tense, prose, roughly the length of the card's existing first_mes.

The rule that matters, stated explicitly because it is the failure mode: the opening must give the user something to react to WITHOUT dictating their response. Put a question, an object, a gesture, or an unresolved situation in front of them, then stop. Do NOT write {{user}}'s words, actions, thoughts, or feelings, and do not narrate their interior state. Do not decide how they react, and do not assume a history with them the card does not establish. No railroading: the user must be free to walk away, refuse, or change the subject.

No prose outside the JSON. No code fences.`,
};

/** Which card field the request is about, so an existing value can be sent as context. */
const EXISTING_KEY: Record<SuggestField, 'tags' | 'alternateGreetings' | 'firstMes'> = {
  tags: 'tags',
  alternate_greetings: 'alternateGreetings',
  first_mes: 'firstMes',
};

/**
 * Helpers for tags, alternate greetings, and a non-railroading first message.
 *
 * Returns whatever the model proposed as a list of strings; callers decide which to
 * keep. A field with no suggestions is returned as an empty array rather than an
 * error, because "nothing to add" is a legitimate answer for a card that is already
 * complete.
 */
export async function suggestField(
  env: Env,
  card: ParsedCard,
  field: SuggestField,
): Promise<string[]> {
  if (!card || typeof card.name !== 'string' || card.name.length === 0) {
    throw new Error('suggestField: a card with a name is required.');
  }
  const system = SYSTEMS[field];
  if (!system) throw new Error(`suggestField: unknown field "${String(field)}".`);

  const { text } = await complete(env, {
    system,
    user: JSON.stringify({
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.firstMes,
      mes_example: card.mesExample,
      system_prompt: card.systemPrompt,
      tags: card.tags,
      alternate_greetings: card.alternateGreetings,
      creator_notes: card.creatorNotes,
      /** What the card already has for the requested field, so a suggestion is not a duplicate. */
      existing: card[EXISTING_KEY[field]],
    }),
    maxTokens: 1536,
    json: true,
  });

  const parsed = parseSuggestions(text);
  if (!parsed) throw new Error('suggestField: the model did not return a JSON object.');

  return asStringArray(parsed.suggestions)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Fenced JSON is accepted; a prose reply is a failure with a readable message. */
function parseSuggestions(text: string): Record<string, unknown> | null {
  try {
    return asRecord(parseJsonReply<unknown>(text));
  } catch {
    return null;
  }
}
