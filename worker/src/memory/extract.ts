import { complete, parseJsonReply } from '../cheap';
import { asRecord } from '../../../src/lib/json';
import { visiblePathCte } from '../branch';
import { datedLine, type DatedMessage } from './dates';

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
  'A DATED EVENT is something that happened at a specific moment and will be asked about',
  'later: a first meeting, a discovery, a confession, a betrayal, a promise made, a',
  'promise broken, a death. It is NOT a fact — a fact stays true ("they are married"), an',
  'event happened on a day ("they married on 3 May"). Report it as an event so it keeps',
  'its date.',
  '',
  'A fact is NOT: a mood, an intention, an action in progress, a description of the',
  'current moment, or anything you inferred rather than read. If the transcript does not',
  'state it plainly, it is not a fact.',
  '',
  'Every line of the transcript is prefixed with the in-world date and time it happened,',
  'like "[Wednesday, 30 September 2026, 05:34]". Use those prefixes for "when" and "at".',
  'If a line has no prefix, no clock was recorded for it — use null, never guess.',
  '',
  'Reply with a JSON object:',
  '  {"facts": [{"text": "...", "subject": "...", "at": "..."}],',
  '   "events": [{"text": "...", "subject": "...", "at": "..."}],',
  '   "supersede": [{"id": 1, "reason": "..."}]}',
  '',
  '  "facts"     new facts this transcript establishes. Empty array if none. Each "text"',
  '              is one self-contained sentence a reader could act on without the',
  '              transcript. "subject" is the character or thing it is about, or null.',
  '              "at" is the date this became true, copied from a line prefix, or null.',
  '  "events"    things that HAPPENED at a moment, with the date they happened. Write',
  '              "text" as one sentence in the past tense naming what happened and who',
  '              was involved. An event is never superseded and is never restated.',
  '  "supersede" numbers of existing facts this transcript proves FALSE — a number that',
  '              changed, a description corrected, a belief shown to be wrong. Use ONLY',
  '              the numbers you were given, from the list below. A fact that is merely',
  '              old, or that this transcript does not mention, is NOT superseded. Never',
  '              supersede an EVENT: an event cannot become false, it only happened.',
  '',
  'Rules:',
  '- Report only what the transcript states. Never invent, infer, or embellish.',
  '- Prefer few, precise facts over many vague ones. Five good facts beat twenty.',
  '- Do not restate a fact that is already in the existing list, even reworded.',
  '- Do not restate an event that is already in the existing list, even reworded.',
  '- Do not extract anything that is only true for this moment ("she is standing").',
  '- Copy "at" exactly as it appears in the line prefix. Do not reformat it, and do not',
  '  write a date you did not read.',
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
  /** The in-world date, when one is on file. Shown to the model so it can place the fact. */
  at: string | null;
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
    // `state_json` rides along so each line can carry the in-world clock. It lives BESIDE
    // the message, not in its content, which is why every fact extracted before this
    // carried no date at all — the model was reading a transcript with the clock stripped
    // out of it.
    `${visiblePathCte('path', 'seq, id, role, content, state_json')}
     SELECT seq, role, content, json_extract(state_json, '$.time') AS at FROM path
      WHERE seq BETWEEN ?2 AND ?3
      ORDER BY seq`,
  )
    .bind(chatId, fromSeq, toSeq)
    .all<DatedMessage>();

  if (messages.length === 0) return { added: 0, superseded: 0 };

  const { results: existing } = await env.DB.prepare(
    // `at` is selected because it is shown to the model: a fact already on file as of a
    // date is one the model can place, and the Memory panel sorts by the same value.
    `SELECT id, text, subject, at FROM facts
      WHERE chat_id = ? AND status = 'active'
      ORDER BY created_at LIMIT ?`,
  )
    .bind(chatId, MAX_EXISTING)
    .all<ExistingFact>();

  const transcript = messages.map(datedLine).join('\n\n');
  // Numbered, not id'd. The model has to name which existing facts a transcript falsifies,
  // and asking it to reproduce a 36-character UUID verbatim was unreliable once the list
  // grew — measured on a real chat, the sixty-crown correction was added while the
  // forty-crown fact it replaced stayed active. A small integer is a thing a model can
  // copy correctly, and the id is recovered here.
  const known = existing.length > 0
    ? existing.map((fact, index) => `[${index + 1}] ${fact.text}`).join('\n')
    : '(none yet)';

  // 1400, not 700. A cheap model that reasons before answering spends its allowance in
  // `reasoning_content` and returns an empty `content`; 700 was exhausted by every
  // extract on a real chat (see `scheduleMemory` for what that cost). The floor leaves
  // headroom for a model that still thinks past the flag.
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
    maxTokens: 1400,
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

  // Which existing facts this transcript replaces. Resolved before any write, because the
  // replacement's id is only known once the new facts are inserted — and `superseded_by`
  // is meant to name the replacement.
  const targets: ExistingFact[] = [];
  for (const entry of asArray(record.supersede)) {
    const item = asRecord(entry);
    // The number the model was shown, not an id. A number outside the list is dropped:
    // superseding the wrong fact silently removes a true one from the prompt.
    const index = typeof item?.id === 'number' ? item.id : Number(item?.id);
    const target = Number.isInteger(index) ? existing[index - 1] : undefined;
    if (target) targets.push(target);
  }

  // New facts and events. `subject` is optional and only ever a label, so a missing one is
  // null rather than a reason to drop the row. `at` is copied from a transcript line prefix
  // or null — never invented, and never defaulted to the range's end, because "this fact has
  // no date" and "this fact is true as of the last turn" are different claims.
  const seen = new Set(existing.map((fact) => normalise(fact.text)));
  const inserts: Array<{
    id: string;
    text: string;
    subject: string | null;
    at: string | null;
    kind: 'fact' | 'event';
  }> = [];

  /** The two reply fields that produce rows, and the kind each one writes. */
  const KIND_BY_FIELD: Record<string, 'fact' | 'event'> = {
    facts: 'fact',
    events: 'event',
  };

  for (const [field, kind] of Object.entries(KIND_BY_FIELD)) {
    for (const entry of asArray(record[field])) {
      const item = asRecord(entry);
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      if (text.length === 0) continue;
      // Deduplicated here as well as in the prompt: a model that repeats itself would
      // otherwise put the same sentence in the prompt twice. Shared across both lists, so
      // the same sentence cannot land once as a fact and once as an event.
      const key = normalise(text);
      if (seen.has(key)) continue;
      seen.add(key);
      inserts.push({
        id: crypto.randomUUID(),
        text,
        subject:
          typeof item?.subject === 'string' && item.subject.trim().length > 0
            ? item.subject.trim()
            : null,
        at: typeof item?.at === 'string' && item.at.trim().length > 0 ? item.at.trim() : null,
        kind,
      });
    }
  }

  // `superseded_by` names the replacement. When exactly one new fact was extracted it is
  // unambiguous; with zero or several there is no single replacement, so the column stays
  // null rather than pointing at an arbitrary one. Previously it was bound to the
  // superseded fact's OWN id, which the Memory viewer renders as user-visible prose —
  // "superseded by <its own id>".
  const replacementId = inserts.length === 1 ? inserts[0].id : null;

  // Insert-then-update inside ONE batch, which D1 runs as a transaction. Superseding still
  // happens in the same atomic step as the insert, so there is never a committed state
  // where both facts are active — the reason supersede ran first — while the update can
  // now reference an id that exists.
  //
  // `learned_at_seq` is the turn that produced these facts. It is what lets a read ask "was
  // this true at the point I am writing?", and it is the same coordinate the summary read
  // uses. Without it a fact recorded by a turn that is later regenerated away keeps being
  // injected, so an early scene is written with knowledge of an event that has not happened.
  const statements = [
    ...inserts.map((fact) =>
      env.DB.prepare(
        `INSERT INTO facts (id, chat_id, text, subject, at, kind, status, pinned, learned_at_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
      ).bind(fact.id, chatId, fact.text, fact.subject, fact.at, fact.kind, toSeq, now),
    ),
    ...targets.map((target) =>
      env.DB.prepare(
        `UPDATE facts SET status = 'superseded', superseded_by = ?, superseded_at_seq = ?
          WHERE id = ? AND chat_id = ?`,
      ).bind(replacementId, toSeq, target.id, chatId),
    ),
  ];

  if (statements.length > 0) await env.DB.batch(statements);

  return { added: inserts.length, superseded: targets.length };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Case, punctuation and whitespace are not differences. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}
