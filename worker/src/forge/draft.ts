import { complete, parseJsonReply } from '../cheap';
import { asRecord, asString, asStringArray } from '../../../src/lib/json';
import type { ParsedCard } from '../../../src/lib/cards/types';

/**
 * The field shape the model must return. Card field names (`first_mes`,
 * `mes_example`, …) are the wire names, not the stored camelCase ones — the model
 * has seen thousands of character cards and reproduces the spec names far more
 * reliably than names invented for this codebase.
 */
const DRAFT_SYSTEM = `You write character cards for a roleplay client. The user gives you a one-line premise; you return a complete, self-consistent character card as JSON.

Return ONLY a JSON object with exactly these keys:
{
  "name": string,
  "description": string,
  "personality": string,
  "scenario": string,
  "first_mes": string,
  "mes_example": string,
  "system_prompt": string,
  "post_history_instructions": string,
  "alternate_greetings": string[],
  "creator_notes": string,
  "tags": string[]
}

Rules:
- "name" is required and must be non-empty.
- "description" and "personality" are DESCRIPTION. Write who the character is: appearance, history, voice, mannerisms, contradictions. Do NOT put behavioural instructions here ("always", "never", "you must", "do not") — those belong in "system_prompt" or "post_history_instructions". Instructions smuggled into the description are the single most common defect in published cards.
- "system_prompt" holds the behavioural instructions: how the character speaks, what the narrator should and should not do.
- "post_history_instructions" is a short reminder re-asserted after the history. Keep it to one or two sentences.
- "first_mes" is the character's opening message. Give the user something concrete to react to — a question, a situation, an object, a gesture — without dictating what the user does, says, thinks, or feels. Never write {{user}}'s words or actions. Write it in {{char}}'s voice, present tense, prose, no stage directions outside asterisks.
- "mes_example" uses the {{user}}: / {{char}}: block format, two or three short exchanges, showing voice rather than describing it.
- "alternate_greetings" holds two or three alternative openings of the same kind.
- "tags" holds five to ten short lowercase tags.
- "creator_notes" is one or two sentences of authorial intent.

No prose outside the JSON. No code fences.`;

/**
 * Turns a one-line premise into a card that imports and chats without manual editing.
 *
 * Retries ONCE on a parse or validation failure — a model that emitted prose around
 * the JSON often gets it right on a second, more insistent attempt. Transport and
 * configuration errors are not retried: they will fail identically the second time,
 * and the first error is the informative one.
 */
export async function draftCard(env: Env, oneLine: string): Promise<ParsedCard> {
  const brief = oneLine.trim();
  if (brief.length === 0) {
    throw new Error('draftCard: a one-line description is required.');
  }

  let lastFailure = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await complete(env, {
      system: DRAFT_SYSTEM,
      user: brief,
      maxTokens: 2048,
      json: true,
    });

    try {
      return toParsedCard(parseJsonReply<unknown>(text));
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`draftCard: the model did not return a usable card (${lastFailure}).`);
}

/**
 * Validates and maps a model reply onto the stored card shape.
 *
 * A missing name is an error rather than a default, for the same reason it is at
 * import time: a card with no name cannot be filed. Every other field defaults,
 * because a card missing its scenario still chats.
 */
function toParsedCard(value: unknown): ParsedCard {
  const record = asRecord(value);
  if (!record) throw new Error('reply was not a JSON object');

  const name = asString(record.name).trim();
  if (name.length === 0) throw new Error('reply had no name');

  return {
    name,
    description: asString(record.description),
    personality: asString(record.personality),
    scenario: asString(record.scenario),
    firstMes: asString(record.first_mes),
    mesExample: asString(record.mes_example),
    systemPrompt: asString(record.system_prompt),
    postHistoryInstructions: asString(record.post_history_instructions),
    alternateGreetings: asStringArray(record.alternate_greetings),
    creatorNotes: asString(record.creator_notes),
    tags: asStringArray(record.tags),
    characterBook: null,
    sourceFormat: 'ccv2',
    raw: value,
  };
}
