import { visiblePathCte } from '../branch';
import { parseStateTime } from '../state/time';

/**
 * In-world dates for memory.
 *
 * The clock the narrator keeps lives in `messages.state_json.time` — BESIDE a message, not
 * inside it. Extraction and summarisation were handed `role: content` only, so the date was
 * on disk and never in the transcript the model read. Measured: 792 messages carried a full
 * clock reading, and zero of the 47 facts and 28 summaries contained any date at all.
 *
 * Everything here reads that one field. Nothing invents a date: a range with no recorded
 * clock returns null, and null is rendered as "no date" rather than as a guess.
 */

/** One message with its recorded clock reading, when it has one. */
export interface DatedMessage {
  seq: number;
  role: string;
  content: string;
  /** The in-world clock at this turn, verbatim, or null when none was recorded. */
  at: string | null;
}

/**
 * The clock readings bounding a seq range: the first and the last that exist.
 *
 * Not `clockAt(fromSeq)` / `clockAt(toSeq)`: a greeting has no snapshot, and a turn whose
 * state update failed carries none either. Scanning the range for the outermost readings
 * that DO exist is what makes a summary's date survive a sparse range instead of being lost
 * to one missing row.
 */
export async function clockRange(
  env: Env,
  chatId: string,
  fromSeq: number,
  toSeq: number,
): Promise<{ from: string | null; to: string | null }> {
  const row = await env.DB.prepare(
    `${visiblePathCte('path', 'seq, id, state_json')}
     SELECT
       (SELECT json_extract(state_json, '$.time') FROM path
         WHERE seq BETWEEN ?2 AND ?3 AND json_extract(state_json, '$.time') IS NOT NULL
         ORDER BY seq ASC LIMIT 1) AS first_at,
       (SELECT json_extract(state_json, '$.time') FROM path
         WHERE seq BETWEEN ?2 AND ?3 AND json_extract(state_json, '$.time') IS NOT NULL
         ORDER BY seq DESC LIMIT 1) AS last_at`,
  )
    .bind(chatId, fromSeq, toSeq)
    .first<{ first_at: string | null; last_at: string | null }>();

  return { from: clean(row?.first_at ?? null), to: clean(row?.last_at ?? null) };
}

/**
 * A transcript line for a model, with the in-world clock on it.
 *
 * `[Wednesday, 30 September 2026, 05:34] assistant: ...` — the date leads because the
 * question being asked of the transcript is "when did this become true", and a date that
 * trails a 900-character reply is a date the model has to hunt for.
 *
 * A turn with no recorded clock is rendered WITHOUT a bracket rather than with an empty
 * one: `[]` reads as "the date is nothing", while no bracket reads as "no date was
 * recorded", which is what is true.
 */
export function datedLine(message: DatedMessage): string {
  const at = clean(message.at);
  const body = `${message.role}: ${message.content}`;
  return at ? `[${at}] ${body}` : body;
}

/** Empty and whitespace-only readings are the same thing: no date. */
function clean(value: string | null): string | null {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : null;
}

/**
 * A sortable instant for an in-world reading, falling back to insertion order.
 *
 * `parseStateTime` returns null for the free-text readings the manual pace allows ("late
 * evening"), and those must not sort as if they were the epoch — a chat written in free
 * text would then read in an arbitrary order. The caller passes the row's own position as
 * the fallback, so an unparseable date keeps the order it was recorded in, which is the
 * best available answer rather than a wrong one.
 */
export function dateOrder(at: string | null, fallback: number): number {
  const parsed = at ? parseStateTime(at) : null;
  return parsed ?? fallback;
}
