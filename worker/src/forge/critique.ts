import { complete, parseJsonReply } from '../cheap';
import { asRecord, asString, asStringArray } from '../../../src/lib/json';
import type { ParsedCard } from '../../../src/lib/cards/types';

/**
 * Directives that belong in `systemPrompt` or `postHistoryInstructions`, not in a
 * description. Every pattern is directive-shaped: it needs a second-person
 * construction ("you must", "do not"), a clause that OPENS with `always`/`never`, or
 * `never` + a base-form verb. Plain `always`/`never` is not enough — "her eyes never
 * left the door" is description, and flagging it would make the scan noise.
 */
const DIRECTIVE_PATTERNS: RegExp[] = [
  // An imperative clause: "Always stay in character." / "Never break character."
  /^\s*(always|never)\b/i,
  /\byou\s+(must|should|shall|will|need to|have to|are to|can only|may not)\b/i,
  /(?:^|\byou\s+)do\s+(?:n't|not)\b/i,
  /\brespond\s+(with|in|as)\b/i,
  /\banswer\s+(with|in|as)\b/i,
  /\breply\s+(with|in|as)\b/i,
  /\bwrite\s+(in|your|the|only)\b/i,
  /\bspeak\s+(in|only|as)\b/i,
  /\bkeep\s+(your|it|the|responses?|replies?|answers?)\b/i,
  /\bmake sure\b/i,
  /\bensure\s+(that|you)\b/i,
  /\bremember to\b/i,
  /\bavoid\b/i,
  /\bstay in character\b/i,
  /\bbreak character\b/i,
  /\bact as\b/i,
  /\b(?:use|include|omit|mention)\s+(?:the\s+)?(?:following|these|{{user}}|{{char}})\b/i,
  // `never` + a base-form verb. Past/third-person forms ("never left", "never
  // speaks") are narrative and deliberately do not match.
  /\bnever\s+(break|stay|speak|use|write|mention|describe|act|refer|address|assume|ignore|forget|reveal|repeat|echo|narrate|roleplay|initiate|control|decide|invent|add|include|omit|summarize|quote|apologize|ask|tell|say|do|be|let|make|end|start)\b/i,
];

/** Only the free-text prose fields a directive can hide in. */
const SCANNED_FIELDS = ['description', 'personality'] as const;

const MAX_EXCERPT = 300;

/** Case and punctuation must not make two spellings of one rule count twice. */
function dedupKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Deterministic, local, model-free. The model's own findings are merged on top, but
 * this is the part that is reproducible: the same card always yields the same list,
 * so a caller can assert on it and a user can re-run it without spending a call.
 *
 * Exported because it is the guaranteed half of the critique and is useful on its
 * own — `critiqueCard` needs a configured model, this does not.
 */
export function findSmuggledInstructions(card: ParsedCard): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const field of SCANNED_FIELDS) {
    // Split on sentence enders and newlines, so a bullet list of rules yields one
    // excerpt per rule rather than one giant one.
    for (const raw of card[field].split(/[.!?\n]+/)) {
      const sentence = raw.replace(/^[\s\-*•\d.)]+/, '').trim();
      if (sentence.length === 0) continue;
      if (!DIRECTIVE_PATTERNS.some((pattern) => pattern.test(sentence))) continue;

      const excerpt =
        sentence.length > MAX_EXCERPT ? `${sentence.slice(0, MAX_EXCERPT - 1)}…` : sentence;
      const key = dedupKey(excerpt);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(excerpt);
    }
  }

  return found;
}

const CRITIQUE_SYSTEM = `You review character cards for a roleplay client. The user sends you one card as JSON. You return a review as JSON.

Return ONLY a JSON object:
{
  "critique": string,
  "smuggledInstructions": string[]
}

"smuggledInstructions" lists behavioural instructions found in the "description" or "personality" fields — second-person imperatives such as "always", "never", "you must", "do not", "respond with". Those belong in "system_prompt" or "post_history_instructions", and they are the loudest complaint about published cards: dozens of instructions that end up being half the tokens of padding. Quote each offending excerpt verbatim, one per array entry. Return an empty array when there are none.

"critique" is prose covering the card as a whole: what the character is, whether the voice is specific enough to write from, whether description and personality overlap, whether the scenario gives the opening something to act on, whether the opening message leaves room for the user, and what is missing. Two short paragraphs at most. Judge the writing; do not rewrite the card.

No prose outside the JSON. No code fences.`;

/**
 * Reviews an existing card.
 *
 * The smuggled-instruction finding is deliberately computed twice: once by the
 * deterministic local scan and once by the model. The local scan is merged FIRST and
 * the model's additions follow, so the reproducible findings always appear even when
 * the model overlooks them.
 */
export async function critiqueCard(
  env: Env,
  card: ParsedCard,
): Promise<{ critique: string; smuggledInstructions: string[] }> {
  if (!card || typeof card.name !== 'string' || card.name.length === 0) {
    throw new Error('critiqueCard: a card with a name is required.');
  }

  const { text } = await complete(env, {
    system: CRITIQUE_SYSTEM,
    user: JSON.stringify(cardForPrompt(card)),
    maxTokens: 2048,
    json: true,
  });

  // A model that answers in prose despite `json: true` has still produced a critique;
  // its text is used as-is rather than discarded. Only an empty reply is a failure.
  const parsed = tryParseReply(text);
  const critique = (parsed ? asString(parsed.critique) : text).trim();
  if (critique.length === 0) {
    throw new Error('critiqueCard: the model returned no critique.');
  }

  // The local findings come first: they are the reproducible half, so they must
  // survive a model that overlooks them.
  const smuggledInstructions = findSmuggledInstructions(card);
  const seen = new Set(smuggledInstructions.map(dedupKey));

  for (const item of parsed ? asStringArray(parsed.smuggledInstructions) : []) {
    const excerpt = item.trim();
    if (excerpt.length === 0 || seen.has(dedupKey(excerpt))) continue;
    seen.add(dedupKey(excerpt));
    smuggledInstructions.push(excerpt);
  }

  return { critique, smuggledInstructions };
}

/** Fenced JSON is accepted; prose returns null so the caller can fall back to it. */
function tryParseReply(text: string): Record<string, unknown> | null {
  try {
    return asRecord(parseJsonReply<unknown>(text));
  } catch {
    return null;
  }
}

/**
 * The prompt carries the fields a review can act on, minus `raw` — the untouched
 * source object can hold anything the source format allowed, and it is noise the
 * model would waste tokens reading.
 */
function cardForPrompt(card: ParsedCard): Record<string, unknown> {
  return {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.firstMes,
    mes_example: card.mesExample,
    system_prompt: card.systemPrompt,
    post_history_instructions: card.postHistoryInstructions,
    alternate_greetings: card.alternateGreetings,
    creator_notes: card.creatorNotes,
    tags: card.tags,
  };
}
