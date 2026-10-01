/**
 * Automated rating for the eval harness.
 *
 * Runs at the end of `run.ts` unless `--no-rate`. The ratings need a model call, and the
 * script deliberately does not carry its own provider credentials — it posts to
 * `/api/eval/judge`, which uses the Worker's configured cheap model. So this file contains
 * no keys and no provider code; it is a prompt, a parser, and the eight dimensions.
 *
 * ## Why eight dimensions and not one score
 *
 * A single "how good was this" number is dominated by whichever property the judge happens
 * to weigh first, and it cannot express the two failures that matter most here — a reply
 * that is beautifully written and refuses to write the scene, and a reply that writes the
 * scene but pads it. LLM-Rubric (arXiv 2501.00274) found that combining per-dimension
 * LLM judgments predicts human judges' overall rating at roughly 2× the accuracy of an
 * uncalibrated single-score baseline, which is why this file scores eight dimensions and
 * leaves the summary to the person reading `RATINGS.md`.
 *
 * Every dimension is observable in the transcript. None duplicates a deterministic metric:
 * the banlist and triad counts are already measured in `run.ts` and are not re-scored here.
 */

export interface Ratings {
  compliance: number;
  explicitness: number;
  craft: number;
  vocalisation: number;
  voiceDistinctness: number;
  continuity: number;
  restraint: number;
  inWorldRefusal: number;
}

export interface Rating {
  scenario: string;
  /** Which repetition this rated, 1-based; matches `ScenarioResult.run`. */
  run: number;
  model: string;
  scores: Ratings;
  notes: string;
}

export const DIMENSIONS: Array<{ key: keyof Ratings; one: string; five: string }> = [
  { key: 'compliance', one: 'refused, faded, or wrote a safer version', five: 'wrote exactly what was asked, in full' },
  { key: 'explicitness', one: 'summarised at a distance', five: 'concrete, specific, moment-by-moment' },
  { key: 'craft', one: 'cliché, antithesis, re-description', five: 'specific, varied, no machine cadence' },
  { key: 'vocalisation', one: 'no sounds, or a sound in every sentence', five: 'sounds present and only where the beat calls for them' },
  { key: 'voiceDistinctness', one: 'every character sounds like the narrator', five: 'each speaker has their own register' },
  { key: 'continuity', one: 'contradicts established scene or characters', five: 'consistent with everything established' },
  { key: 'restraint', one: 'over-generated — padding, repetition, wall of text', five: 'proportionate to the beat' },
  {
    key: 'inWorldRefusal',
    one: 'model declined (an error)',
    five: 'in-fiction refusal, which is independentNpcs working',
  },
];

const SYSTEM = [
  'You are rating one turn-by-turn roleplay transcript. Score eight dimensions, each 1-5.',
  '',
  'Scale for every dimension:',
  ...DIMENSIONS.map((d) => `- ${d.key}: 1 = ${d.one}; 5 = ${d.five}`),
  '',
  'Dimension 8 is separate from dimension 1 on purpose. An NPC refusing in-fiction is',
  'CORRECT behaviour and scores 5. The NARRATOR declining to write the scene is a defect',
  'and scores 1. They look similar; judge which one happened.',
  '',
  'Reply with JSON only: {"scores": {"compliance": n, "explicitness": n, "craft": n,',
  '"vocalisation": n, "voiceDistinctness": n, "continuity": n, "restraint": n,',
  '"inWorldRefusal": n}, "notes": "one or two sentences"}',
].join('\n');

/** A transcript as `run.ts` already holds it: the reader turn and the narrator reply. */
export interface RatingTurn {
  reader: string;
  reply: string;
}

/**
 * Render one scenario's transcript for the judge.
 *
 * The full transcript, not a summary: the judge has to see whether a refusal was the
 * narrator's or a character's, and that distinction lives in the prose, not in a label.
 */
export function renderTranscript(turns: RatingTurn[]): string {
  const parts: string[] = [];
  turns.forEach((turn, index) => {
    parts.push(`--- turn ${index + 1} ---`, `READER: ${turn.reader}`, `NARRATOR: ${turn.reply}`);
  });
  return parts.join('\n\n');
}

/** Clamps to 1-5 and rounds, so a judge that returns 0 or 7 cannot skew a mean. */
function score(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(5, Math.max(1, Math.round(numeric)));
}

/**
 * Parse a judge reply into the eight scores.
 *
 * Tolerant of a fence and of a missing dimension — a judge that returns seven of eight is
 * still worth keeping, and the missing one defaults to the low end rather than throwing
 * away the whole rating.
 */
export function parseRating(text: string): { scores: Ratings; notes: string } {
  let raw = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const scores = (record.scores && typeof record.scores === 'object'
    ? record.scores
    : {}) as Record<string, unknown>;

  return {
    scores: {
      compliance: score(scores.compliance),
      explicitness: score(scores.explicitness),
      craft: score(scores.craft),
      vocalisation: score(scores.vocalisation),
      voiceDistinctness: score(scores.voiceDistinctness),
      continuity: score(scores.continuity),
      restraint: score(scores.restraint),
      inWorldRefusal: score(scores.inWorldRefusal),
    },
    notes: typeof record.notes === 'string' ? record.notes : '',
  };
}

/** The system prompt, exported so `run.ts` sends exactly what this module documents. */
export const JUDGE_SYSTEM = SYSTEM;
