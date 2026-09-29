import { complete } from '../cheap';
import { estimateTokens } from '../../../src/lib/tokenEstimate';

export interface Summary {
  id: string;
  content: string;
}

interface SourceRow {
  seq: number;
  role: string;
  content: string;
}

/**
 * The summarizer is told to read the transcript and nothing else.
 *
 * SillyTavern's shipped summarization prompt says "use that as a base and expand",
 * feeding the previous summary back in as an input. That carries the model's own
 * early misreading forward: by message 40 the summary describes a summary of a
 * misremembered scene, and nothing later can correct it because the source messages
 * are no longer in the prompt. Every summary here is generated from the ORIGINAL
 * messages in `[fromSeq, toSeq]`, re-read from the database, so an error stays local
 * to its own scene instead of compounding forever.
 */
const SYSTEM = [
  'You compress a roleplay transcript into a factual scene summary.',
  '',
  'Rules:',
  '- Report only what the transcript states. Never invent, infer, or embellish.',
  '- Preserve concrete specifics: names, places, objects, numbers, and any change in',
  '  a character\'s circumstances, knowledge, or emotional state.',
  '- Note unresolved threads and open questions; they matter more later than mood.',
  '- Write in the third person, past tense, as prose. No bullet lists, no headings,',
  '  no preamble, no closing remarks.',
  '- If the transcript contradicts itself, state both readings rather than choosing.',
].join('\n');

/**
 * Summarize the inclusive `messages.seq` range `[fromSeq, toSeq]` of one chat into a
 * single `scene` row and return it.
 *
 * The source is always the messages themselves — never an existing summary. See the
 * note on `SYSTEM`.
 */
export async function summarize(
  env: Env,
  chatId: string,
  fromSeq: number,
  toSeq: number,
): Promise<Summary> {
  const { results } = await env.DB.prepare(
    `SELECT seq, role, content FROM messages
      WHERE chat_id = ? AND seq BETWEEN ? AND ?
      ORDER BY seq`,
  )
    .bind(chatId, fromSeq, toSeq)
    .all<SourceRow>();

  if (results.length === 0) {
    throw new Error(`no messages in chat ${chatId} between seq ${fromSeq} and ${toSeq}`);
  }

  // The seq is kept in the transcript so the model can anchor a claim to a turn, and
  // so a range that silently spans a gap (a deleted branch) is visible in the text.
  const transcript = results.map((row) => `[${row.seq}] ${row.role}: ${row.content}`).join('\n\n');

  // Throws a clear "no cheap model configured" / "no API key" error before any write,
  // so a failed summarization never leaves a half-written row behind.
  const reply = await complete(env, { system: SYSTEM, user: transcript, maxTokens: 700 });

  const content = reply.text.trim();
  if (content.length === 0) throw new Error('summarization returned no content');

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO summaries (id, chat_id, tier, covers_from, covers_to, content, tokens, created_at)
     VALUES (?, ?, 'scene', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      chatId,
      results[0].seq,
      results[results.length - 1].seq,
      content,
      estimateTokens(content),
      Date.now(),
    )
    .run();

  return { id, content };
}
