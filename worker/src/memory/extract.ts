import { complete, parseJsonReply } from '../cheap';
import { asRecord } from '../../../src/lib/json';

/**
 * Extracting durable facts from a scene.
 *
 * ## Why this exists
 *
 * `facts` was a table with a viewer, an FTS index, a pinned flag, a superseded status, and
 * no writer. The extraction pass was deferred and never built, so the memory block's
 * "Established facts" section could never render and `facts_fts` was dead weight in the
 * prompt path. Measured on a real 157-turn chat: **zero** facts after 157 turns, including
 * twelve turns phrased as direct instructions to remember something.
 *
 * ## What a fact is, and what it is not
 *
 * A fact is something that stays true and matters later: a name, a debt, an allergy, a
 * promise, a physical detail that was established. It is NOT a summary — the transcript
 * already has one of those — and it is NOT a mood or a guess. The distinction is the
 * whole reason this is a separate model call with its own instructions rather than a
 * second question bolted onto the summarizer.
 *
 * ## Superseding, not accumulating
 *
 * The reason `facts` has a `status` column is that stories contradict themselves on
 * purpose: a debt goes from forty crowns to sixty, brass turns out to be iron. Keeping
 * both would put two contradictory statements in the prompt and let the narrator pick —
 * which is worse than either. The model is asked which existing facts the new text
 * FALSIFIES, and those are marked superseded rather than deleted, so the history stays
 * auditable.
 *
 * The model may only name ids it was given. A hallucinated id is dropped rather than
 * trusted, because superseding the wrong fact silently removes a true one from the prompt.
 */

const SYSTEM = [
  'You extract durable facts from a roleplay transcript.',
  '',
  'A FACT is a concrete, persistent detail that will still matter many scenes later: a',
  'name, a place, a debt, an injury, an allergy, a promise, an object and its markings, a',
  'relationship, a thing a character knows or does not know.',
  '',
  'A fact is NOT: a mood, an intention, an action in progress, a description of the',
  'current moment, or anything you inferred rather than read. If the transcript does not',
  'state it plainly, it is not a fact.',
  '',
  'Reply with a JSON object:',
  '  {"facts": [{"text": "...", "subject": "..."}], "supersede": [{"id": "...", "reason": "..."}]}',
  '',
  '  "facts"     new facts this transcript establishes. Empty array if none. Each "text"',
  '              is one self-contained sentence a reader could act on without the',
  '              transcript. "subject" is the character or thing it is about, or null.',
  '  "supersede" numbers of existing facts this transcript proves FALSE — a number that',
  '              changed, a description corrected, a belief shown to be wrong. Use ONLY',
  '              the numbers you were given, from the list below. A fact that is merely',
  '              old, or that this transcript does not mention, is NOT superseded.',
  '',
  'Rules:',
  '- Report only what the transcript states. Never invent, infer, or embellish.',
  '- Prefer few, precise facts over many vague ones. Five good facts beat twenty.',
  '- Do not restate a fact that is already in the existing list, even reworded.',
  '- Do not extract anything that is only true for this moment ("she is standing").',
  '- Reply with the JSON object only. No prose, no explanation, no markdown fence.',
].join('\n');

/** How many existing facts are shown to the model. Bounds the prompt and the id space. */
const MAX_EXISTING = 60;

export interface ExtractionResult {
  added: number;
  superseded: number;
}

interface ExistingFact {
  id: string;
  text: string;
  subject: string | null;
}

/**
 * Extract facts from the inclusive `messages.seq` range `[fromSeq, toSeq]`.
 *
 * Reads the ORIGINAL messages, never an existing summary, for the same reason
 * `summarize` does: a summary's own misreading would otherwise be re-extracted as fact
 * and become permanent.
 */
export async function extractFacts(
  env: Env,
  chatId: string,
  fromSeq: number,
  toSeq: number,
): Promise<ExtractionResult> {
  const { results: messages } = await env.DB.prepare(
    `SELECT seq, role, content FROM messages
      WHERE chat_id = ? AND seq BETWEEN ? AND ?
      ORDER BY seq`,
  )
    .bind(chatId, fromSeq, toSeq)
    .all<{ seq: number; role: string; content: string }>();

  if (messages.length === 0) return { added: 0, superseded: 0 };

  const { results: existing } = await env.DB.prepare(
    `SELECT id, text, subject FROM facts
      WHERE chat_id = ? AND status = 'active'
      ORDER BY created_at LIMIT ?`,
  )
    .bind(chatId, MAX_EXISTING)
    .all<ExistingFact>();

  const transcript = messages.map((row) => `${row.role}: ${row.content}`).join('\n\n');
  // Numbered, not id'd. The model has to name which existing facts a transcript falsifies,
  // and asking it to reproduce a 36-character UUID verbatim was unreliable once the list
  // grew — measured on a real chat, the sixty-crown correction was added while the
  // forty-crown fact it replaced stayed active. A small integer is a thing a model can
  // copy correctly, and the id is recovered here.
  const known = existing.length > 0
    ? existing.map((fact, index) => `[${index + 1}] ${fact.text}`).join('\n')
    : '(none yet)';

  const reply = await complete(env, {
    system: SYSTEM,
    user: [
      'Existing facts:',
      known,
      '',
      'Transcript:',
      transcript,
      '',
      'Reply with the JSON object only.',
    ].join('\n'),
    maxTokens: 700,
    json: true,
  });

  let parsed: unknown;
  try {
    parsed = parseJsonReply<unknown>(reply.text);
  } catch {
    // A malformed reply is a missed extraction, not a broken job. Returning zero keeps
    // the range marked as covered so the next block still runs.
    return { added: 0, superseded: 0 };
  }

  const record = asRecord(parsed);
  if (!record) return { added: 0, superseded: 0 };

  const now = Date.now();

  // Supersede FIRST, so a fact this transcript replaces is already inactive when the new
  // one lands. Doing it the other way round leaves a window where both are active.
  let superseded = 0;
  for (const entry of asArray(record.supersede)) {
    const item = asRecord(entry);
    // The number the model was shown, not an id. A number outside the list is dropped:
    // superseding the wrong fact silently removes a true one from the prompt.
    const index = typeof item?.id === 'number' ? item.id : Number(item?.id);
    const target = Number.isInteger(index) ? existing[index - 1] : undefined;
    if (!target) continue;
    await env.DB.prepare(
      `UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ? AND chat_id = ?`,
    )
      .bind(target.id, target.id, chatId)
      .run();
    superseded += 1;
  }

  // New facts. `subject` is optional and only ever a label, so a missing one is null
  // rather than a reason to drop the fact.
  const seen = new Set(existing.map((fact) => normalise(fact.text)));
  let added = 0;
  for (const entry of asArray(record.facts)) {
    const item = asRecord(entry);
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (text.length === 0) continue;
    // Deduplicated here as well as in the prompt: a model that repeats itself would
    // otherwise put the same sentence in the prompt twice.
    const key = normalise(text);
    if (seen.has(key)) continue;
    seen.add(key);

    await env.DB.prepare(
      `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
       VALUES (?, ?, ?, ?, 'active', 0, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        chatId,
        text,
        typeof item?.subject === 'string' && item.subject.trim().length > 0
          ? item.subject.trim()
          : null,
        now,
      )
      .run();
    added += 1;
  }

  return { added, superseded };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Case, punctuation and whitespace are not differences. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}
