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
 * own — the consultant is handed its findings, and it needs no configured model.
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

/**
 * The card's fields, minus `raw` — the untouched source object can hold anything the
 * source format allowed, and it is noise the model would waste tokens reading.
 *
 * Wire names (`first_mes`, `mes_example`) on the way out as well as in: the model has
 * seen thousands of cards in that shape, and `asRecord`-reading helpers here would
 * otherwise have to know both spellings.
 *
 * `nickname` and `greeting_states` are here for the same reason: the consultant can only
 * change a field it has been shown. Without them "call her Syd" and "make the second opening
 * a morning scene" were unanswerable — the model could not see the field it was being asked
 * about, so it either invented a change somewhere else or claimed it had made one.
 */
export function cardForPrompt(card: ParsedCard): Record<string, unknown> {
  return {
    name: card.name,
    ...(card.nickname ? { nickname: card.nickname } : {}),
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.firstMes,
    alternate_greetings: card.alternateGreetings,
    // One entry per opening, index-aligned, so the model can name the one it means.
    greeting_states: (card.greetingStates ?? []).slice(
      0,
      card.alternateGreetings.length + 1,
    ),
    mes_example: card.mesExample,
    system_prompt: card.systemPrompt,
    post_history_instructions: card.postHistoryInstructions,
    creator_notes: card.creatorNotes,
    tags: card.tags,
  };
}
