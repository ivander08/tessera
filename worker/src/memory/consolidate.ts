import { complete } from '../cheap';
import { estimateTokens } from '../../../src/lib/tokenEstimate';

export interface ConsolidateResult {
  id: string;
}

interface SceneRow {
  id: string;
  covers_from: number;
  covers_to: number;
  content: string;
}

/** How many scenes fold into one arc. */
export const SCENES_PER_ARC = 10;

const SYSTEM = [
  'You compress a sequence of scene summaries from one long roleplay into a single',
  'arc summary that preserves everything still likely to matter much later.',
  '',
  'Rules:',
  '- Report only what the scene summaries state. Never invent or infer.',
  '- Keep concrete specifics: names, places, objects, numbers, promises, injuries,',
  '  debts, and anything a character learned or believes (including wrong beliefs).',
  '- Keep unresolved threads; drop resolved ones that no longer bear on the story.',
  '- Prefer continuity over atmosphere: what changed, and what is still owed.',
  '- Write in the third person, past tense, as prose. No lists, no headings, no preamble.',
].join('\n');

/**
 * Fold every 10 consecutive unconsumed `scene` summaries of a chat into one `arc`.
 *
 * Returns null while fewer than ten unconsumed scenes exist.
 *
 * Consumption is tracked by RANGE, not by a column: an arc's `covers_to` claims every
 * scene whose own `covers_to` is at or below it. That is why the schema needs no
 * `consumed_by` column — and why scenes are always folded oldest-first, contiguously,
 * so the claimed range stays a single interval.
 *
 * WHY FOLDING SUMMARIES IS ALLOWED HERE BUT FORBIDDEN IN `summarize`:
 * `summarize` refuses to feed a previous summary back in because re-summarizing the
 * SAME thing compounds its error without bound — summary of a summary of a summary,
 * each pass losing detail and gaining invention. This is different: scenes are lossy
 * extracts of the messages, and an arc is the next level of a fixed-depth hierarchy
 * (messages -> scene -> arc), folded at most once. The error is bounded by the depth,
 * and the source at each level is fully present in the prompt rather than being an
 * earlier pass over the same material.
 */
export async function consolidate(env: Env, chatId: string): Promise<ConsolidateResult | null> {
  // Everything at or below the newest arc's `covers_to` has already been folded.
  const lastArc = await env.DB.prepare(
    'SELECT MAX(covers_to) AS covered FROM summaries WHERE chat_id = ? AND tier = ?',
  )
    .bind(chatId, 'arc')
    .first<{ covered: number | null }>();
  const covered = lastArc?.covered ?? 0;

  const { results: scenes } = await env.DB.prepare(
    `SELECT id, covers_from, covers_to, content FROM summaries
      WHERE chat_id = ? AND tier = 'scene' AND covers_to > ?
      ORDER BY covers_from
      LIMIT ?`,
  )
    .bind(chatId, covered, SCENES_PER_ARC)
    .all<SceneRow>();

  if (scenes.length < SCENES_PER_ARC) return null;

  const first = scenes[0];
  const last = scenes[scenes.length - 1];

  // The scene texts are the source at this level. Their seq ranges are included so
  // the arc records what it actually covers, and so a gap in the sequence is visible.
  const transcript = scenes
    .map((scene) => `[${scene.covers_from}-${scene.covers_to}] ${scene.content}`)
    .join('\n\n');

  const reply = await complete(env, { system: SYSTEM, user: transcript, maxTokens: 900 });
  const content = reply.text.trim();
  if (content.length === 0) throw new Error('arc consolidation returned no content');

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO summaries (id, chat_id, tier, covers_from, covers_to, content, tokens, created_at)
     VALUES (?, ?, 'arc', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      chatId,
      first.covers_from,
      last.covers_to,
      content,
      estimateTokens(content),
      Date.now(),
    )
    .run();

  return { id };
}
