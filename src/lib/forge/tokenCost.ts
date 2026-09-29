import type { ParsedCard } from '../cards/types';

export interface FieldCost {
  /** Key of `ParsedCard`, so a caller can look the field up directly. */
  field: string;
  tokens: number;
  /** True when the field is re-sent on every request, so its cost is paid again each turn. */
  perTurn: boolean;
  costOverTurns: number;
  trimSuggestions: string[];
}

export interface TokenCostReport {
  fields: FieldCost[];
  /** name + description + personality + scenario. */
  permanentPerTurn: number;
  /** first_mes. */
  oneTime: number;
  /** permanentPerTurn * turns + oneTime. */
  totalOverTurns: number;
  notes: string[];
}

/**
 * This tool reports COST, not quality.
 *
 * No controlled A/B test exists anywhere holding a character constant while varying
 * token count — every published "optimal length" figure is one author's heuristic.
 * So this reports what a field costs per turn and over N turns, and claims nothing
 * about the best length. `trimSuggestions` are mechanical observations (a phrase
 * repeated N times, a paragraph longer than the rest combined) and never quality
 * judgements.
 *
 * The token counter is injected rather than imported: the exact tokenizer carries a
 * 2.3 MB vocabulary that cannot ship to a Worker, while the browser wants the exact
 * count. Same reason `assemble` takes one.
 */
export function analyzeTokenCost(
  card: ParsedCard,
  count: (text: string) => number,
  turns = 500,
): TokenCostReport {
  const turnCount = Number.isFinite(turns) ? Math.max(0, Math.floor(turns)) : 500;

  /**
   * `perTurn` follows what `assemble` actually emits, not what a card editor's
   * wording implies: name/description/personality/scenario head the character block,
   * `systemPrompt` heads the request, `mesExample` is emitted as its own system
   * message, and `postHistoryInstructions` sits in the tail. All five are re-sent
   * every turn. Only `firstMes` is truly paid once — it becomes the chat's opening
   * message rather than prompt text — and alternateGreetings/tags/creatorNotes are
   * never sent at all.
   */
  const specs: Array<{ field: string; value: string | string[]; perTurn: boolean }> = [
    { field: 'name', value: card.name, perTurn: true },
    { field: 'description', value: card.description, perTurn: true },
    { field: 'personality', value: card.personality, perTurn: true },
    { field: 'scenario', value: card.scenario, perTurn: true },
    { field: 'systemPrompt', value: card.systemPrompt, perTurn: true },
    { field: 'postHistoryInstructions', value: card.postHistoryInstructions, perTurn: true },
    { field: 'mesExample', value: card.mesExample, perTurn: true },
    { field: 'firstMes', value: card.firstMes, perTurn: false },
    { field: 'alternateGreetings', value: card.alternateGreetings, perTurn: false },
    { field: 'tags', value: card.tags, perTurn: false },
    { field: 'creatorNotes', value: card.creatorNotes, perTurn: false },
  ];

  const fields: FieldCost[] = specs.map((spec) => {
    const tokens = Array.isArray(spec.value)
      ? spec.value.reduce((sum, item) => sum + count(item), 0)
      : count(spec.value);

    return {
      field: spec.field,
      tokens,
      perTurn: spec.perTurn,
      costOverTurns: spec.perTurn ? tokens * turnCount : tokens,
      trimSuggestions: suggestionsFor(spec.field, spec.value, count),
    };
  });

  const PERMANENT_FIELDS: Record<string, true> = {
    name: true,
    description: true,
    personality: true,
    scenario: true,
  };

  const permanentPerTurn = fields.reduce(
    (sum, field) => (PERMANENT_FIELDS[field.field] ? sum + field.tokens : sum),
    0,
  );
  const oneTime = fields.reduce(
    (sum, field) => (field.field === 'firstMes' ? sum + field.tokens : sum),
    0,
  );
  const totalOverTurns = permanentPerTurn * turnCount + oneTime;

  const notes = [
    'This report is cost, not quality: no controlled A/B test holds a character constant while varying token count, so no optimal length is claimed.',
    `${permanentPerTurn} permanent tokens per turn; over ${turnCount} turns that is ${permanentPerTurn * turnCount} tokens, plus ${oneTime} one-time = ${totalOverTurns}.`,
    'mesExample, systemPrompt and postHistoryInstructions are also re-sent every turn and are counted in their own costOverTurns, but they are not part of permanentPerTurn.',
    "mesExample is re-sent every turn because `assemble` emits it in the prompt head; the card editor's 'one-time cost' label applies to firstMes only.",
    "alternateGreetings, tags and creatorNotes are never sent as prompt text; firstMes is paid once, as the chat's opening message.",
    'Always-on character-book entries also cost on every turn and are not listed here, because `characterBook` is format-specific and untyped.',
  ];

  return { fields, permanentPerTurn, oneTime, totalOverTurns, notes };
}

/**
 * Which mechanical observation is meaningful for which field. A repeated phrase is
 * padding wherever prose lives; paragraph balance only says something about a field
 * that is genuinely multi-paragraph. `tags` is deliberately absent: a repeated
 * two-word tag is not padding worth a suggestion.
 */
const OBSERVATIONS: Record<string, { repeat?: true; paragraphs?: true; items?: string }> = {
  description: { repeat: true, paragraphs: true },
  personality: { repeat: true, paragraphs: true },
  scenario: { repeat: true },
  systemPrompt: { repeat: true },
  postHistoryInstructions: { repeat: true },
  mesExample: { repeat: true, paragraphs: true },
  creatorNotes: { repeat: true, paragraphs: true },
  firstMes: { repeat: true, paragraphs: true },
  alternateGreetings: { items: 'greeting' },
};

function suggestionsFor(
  field: string,
  value: string | string[],
  count: (text: string) => number,
): string[] {
  const plan = OBSERVATIONS[field];
  if (!plan) return [];

  if (Array.isArray(value)) {
    const outlier = plan.items ? outlierOf(value, count, plan.items) : null;
    return outlier ? [outlier] : [];
  }

  const out: string[] = [];
  if (plan.repeat) {
    const repeated = repeatedPhrase(value);
    if (repeated) out.push(repeated);
  }
  if (plan.paragraphs) {
    const outlier = outlierOf(value.split(/\n+/), count, 'paragraph');
    if (outlier) out.push(outlier);
  }
  return out;
}

/**
 * Mechanical observation only: the longest paragraph costs more than every other
 * paragraph combined. That is a fact about the text and a plausible place to look —
 * it is not a verdict on it. Requires at least three paragraphs, because "longer
 * than the other one" says nothing.
 */
function outlierOf(items: string[], count: (text: string) => number, label: string): string | null {
  const present = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (present.length < 3) return null;

  const sizes = present.map(count);
  let longest = 0;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] > sizes[longest]) longest = i;
  }

  let others = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (i !== longest) others += sizes[i];
  }

  if (others === 0 || sizes[longest] <= others) return null;
  return `${label} ${longest + 1} is ${sizes[longest]} tokens, longer than the other ${
    present.length - 1
  } combined`;
}

/** Static membership table: an article or pronoun repeating is not worth reporting. */
const STOPWORDS: Record<string, true> = {
  the: true, a: true, an: true, and: true, or: true, of: true, to: true, in: true, on: true,
  at: true, is: true, was: true, are: true, were: true, be: true, been: true, with: true,
  his: true, her: true, its: true, it: true, he: true, she: true, they: true, you: true,
  as: true, by: true, for: true, from: true, that: true, this: true, but: true, not: true,
  no: true, do: true, does: true, did: true, has: true, have: true, had: true, will: true,
  would: true, can: true, could: true, into: true, over: true, under: true, out: true,
  up: true, down: true, then: true, than: true, so: true, if: true, when: true, while: true,
  after: true, before: true, their: true, them: true, we: true, us: true, my: true,
  your: true, our: true, i: true,
};

/**
 * A phrase repeated three or more times is padding in the plainest sense: the same
 * words, paid for again. Reported for the longest repeated n-gram, so a repeated
 * sentence is not reported as four overlapping fragments.
 */
function repeatedPhrase(text: string): string | null {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

  for (const size of [4, 3]) {
    const counts = new Map<string, number>();
    for (let i = 0; i + size <= words.length; i++) {
      const gram = words.slice(i, i + size).join(' ');
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }

    let best: { gram: string; count: number } | null = null;
    for (const [gram, count] of counts) {
      if (count < 3) continue;
      // Guards against "of the and" style runs that repeat without carrying anything.
      if (!gram.split(' ').some((word) => word.length >= 4 && !STOPWORDS[word])) continue;
      if (!best || count > best.count || (count === best.count && gram.length > best.gram.length)) {
        best = { gram, count };
      }
    }

    if (best) return `repeated phrase "${best.gram}" appears ${best.count} times`;
  }

  return null;
}
