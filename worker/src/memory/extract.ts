import { complete, parseJsonReply } from '../cheap';
import { asRecord } from '../../../src/lib/json';
import { visiblePathCte } from '../branch';
import { buildMatchQuery } from './fts';
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

/**
 * How many existing facts are shown to the model. Bounds the prompt and the id space.
 *
 * The bound is necessary — a chat can accumulate hundreds of facts, and every one shown
 * costs prompt tokens on every extraction. What was wrong was HOW the bound was chosen:
 * the first version took the 60 OLDEST rows (`ORDER BY created_at LIMIT 60`), so a chat
 * past sixty facts could never supersede anything newer. The model was never shown the
 * fact its transcript contradicted, the contradiction was not reported, and both versions
 * stayed `active` — so recall could return "the debt is forty crowns" and "the debt is
 * sixty crowns" in the same block and let the narrator pick.
 *
 * Selection is now relevance-first: facts the block's own words match, then the most
 * recent facts (the ones a scene is most likely to extend or contradict). Old-but-relevant
 * facts still surface through the match, which is exactly the case the age window lost.
 */
const MAX_EXISTING = 60;

/** How many of the block's matching facts are taken before recency fills the rest. */
const MAX_MATCHED = 40;

/**
 * How many distinct terms of the block are used to find matching facts.
 *
 * The recall path caps at 24 because it is given ONE message and the cap only trims
 * prose. Extraction is given a whole 20-message block, where 24 terms is often just the
 * first message — a fact established halfway through the block would then be invisible
 * to the match that exists to find it.
 */
const MAX_MATCH_TERMS = 120;

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
 * The existing facts the model is shown, and the set it is deduplicated against.
 *
 * Two different sets on purpose:
 *
 *  - `candidates` is bounded, because it goes into the prompt. Relevance first (the words
 *    of the block), then recency, so the fact a scene is extending is present even in a
 *    chat with hundreds of them.
 *  - `allActive` is every active fact's normalised text, unbounded, because deduplication
 *    is a comparison against the whole store rather than against what fits on screen.
 *    Measured on the failure this fixes: past sixty facts the dedup set was the same
 *    sixty rows, so a restated later fact was inserted again.
 *
 * Superseded facts are excluded from both. They are the story's history, not its state,
 * and re-offering one lets the model re-retire something already retired — which also
 * makes the numbering it answers with drift.
 */
async function loadExistingFacts(
  env: Env,
  chatId: string,
  blockText: string,
): Promise<{ candidates: ExistingFact[]; allActive: Set<string> }> {
  const match = buildMatchQuery(blockText, MAX_MATCH_TERMS);

  const [matched, recent, active] = await Promise.all([
    match.length > 0
      ? env.DB.prepare(
          // `bm25` ascending is best-first, the same ordering recall uses. The join back to
          // `facts` is required: FTS5 stores only a rowid, and the chat filter has to come
          // from the base table or this matches every chat's facts.
          `SELECT f.id, f.text, f.subject, f.at
             FROM facts_fts
             JOIN facts f ON f.rowid = facts_fts.rowid
            WHERE facts_fts MATCH ?2 AND f.chat_id = ?1 AND f.status = 'active' AND f.deleted = 0
            ORDER BY bm25(facts_fts)
            LIMIT ?3`,
        )
          .bind(chatId, match, MAX_MATCHED)
          .all<ExistingFact>()
      : Promise.resolve({ results: [] as ExistingFact[] }),

    env.DB.prepare(
      // Newest first, not oldest. A new scene most often extends or contradicts something
      // recently established; the oldest facts reach the list through the match above.
      `SELECT id, text, subject, at FROM facts
        WHERE chat_id = ? AND status = 'active' AND deleted = 0
        ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(chatId, MAX_EXISTING)
      .all<ExistingFact>(),

    env.DB.prepare(`SELECT text FROM facts WHERE chat_id = ? AND status = 'active' AND deleted = 0`)
      .bind(chatId)
      .all<{ text: string }>(),
  ]);

  const candidates: ExistingFact[] = [];
  const seen = new Set<string>();
  for (const row of [...matched.results, ...recent.results]) {
    if (candidates.length >= MAX_EXISTING) break;
    const key = normalise(row.text);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(row);
  }

  return {
    candidates,
    allActive: new Set(active.results.map((row) => normalise(row.text))),
  };
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

  const transcript = messages.map(datedLine).join('\n\n');

  // Selected against the block's own text, so a fact this scene might contradict is shown
  // even when it is far older than the newest sixty. See `loadExistingFacts`.
  const { candidates: existing, allActive } = await loadExistingFacts(
    env,
    chatId,
    messages.map((message) => message.content).join('\n'),
  );
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
  const seen = new Set(allActive);
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

  // The clock readings that actually exist in the block, normalised. A date is kept only
  // when it names one of these. The instruction already said "use only dates you read in
  // the prefixes" and nothing enforced it — the value was copied straight from the reply
  // into `facts.at`, so a reformatted, guessed or invented date was written to the database
  // and presented by the Memory panel as the recorded clock.
  const recordedDates = new Set(
    messages.map((message) => normaliseDate(message.at)).filter((date): date is string => date !== null),
  );

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
      const claimedAt = typeof item?.at === 'string' && item.at.trim().length > 0
        ? item.at.trim()
        : null;
      // Kept as the model wrote it when it names a real reading, because that is what the
      // Memory panel shows and the reader can check against the transcript. Dropped to null
      // when it does not: an undated fact is honest, an invented date is a false claim about
      // when something became true.
      const at = claimedAt !== null && recordedDates.has(normaliseDate(claimedAt) ?? '')
        ? claimedAt
        : null;
      inserts.push({
        id: crypto.randomUUID(),
        text,
        subject:
          typeof item?.subject === 'string' && item.subject.trim().length > 0
            ? item.subject.trim()
            : null,
        at,
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

/**
 * A clock reading reduced to the numbers that identify the instant, or null.
 *
 * Models reformat a date even when told to copy it: the weekday is dropped, the comma
 * becomes a dash, "05:34" becomes "5:34". Those are the same reading and must match. What
 * must NOT match is a different instant, so only the numeric fields are compared — day,
 * month, year, hour, minute — and a reading with no numbers at all (a free-text clock like
 * "late evening") is not comparable and is therefore not accepted as a match.
 *
 * The month is resolved from its name rather than its position, because a model writing
 * "30 September 2026" and the transcript's "Wednesday, 30 September 2026" agree on the
 * instant but not on the word order.
 */
function normaliseDate(value: string | null): string | null {
  if (value === null) return null;
  const text = value.toLowerCase();
  const month = MONTHS.findIndex((name) => text.includes(name));
  const day = text.match(/\b(\d{1,2})\b/)?.[1];
  const year = text.match(/\b(1[89]\d{2}|2\d{3})\b/)?.[1];
  const time = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (month < 0 || day === undefined || year === undefined) return null;
  return [
    year,
    String(month + 1).padStart(2, '0'),
    day.padStart(2, '0'),
    time?.[1].padStart(2, '0') ?? '',
    time?.[2] ?? '',
  ].join('-');
}

/** Full and three-letter month names, in calendar order. */
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
