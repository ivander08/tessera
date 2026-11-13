import { settingsForChat } from './settings';
import { complete, parseJsonReply } from '../cheap';
import { asRecord, asString } from '../../../src/lib/json';
import type { DbStatement } from '../db/driver';

/**
 * Fact compaction: the manual cleanup the automatic extractor cannot do for itself.
 *
 * `extract.ts` shows the cheap model only sixty existing facts when it decides what to
 * supersede, so on a long chat the store grows monotonically — measured on one chat: 796
 * active facts, 13 superseded. That is not a prompt-cost problem (recall returns eight
 * ranked hits and the pins), it is a maintenance problem: near-duplicates and stale
 * versions compete for the same eight slots.
 *
 * This proposes the cleanup and writes nothing. The reader sees the diff and applies it,
 * which is the same rule every other destructive action in the app follows.
 */

export interface CompactOp {
  op: 'merge' | 'rewrite' | 'supersede';
  /** The rows involved. `merge` keeps the first and supersedes the rest. */
  ids: string[];
  /** The new text, for `merge` and `rewrite`. Empty for `supersede`. */
  text: string;
  /** Why, in the model's own words. Shown beside the op. */
  reason: string;
}

export interface CompactProposal {
  ops: CompactOp[];
  /** How many active facts were read in this pass. */
  examined: number;
  /** Active facts left unread, oldest-first batched. Zero means the store is covered. */
  remaining: number;
}

/** How many facts one pass reads. A batch the cheap model can hold without losing the list. */
export const COMPACT_BATCH = 80;

const SYSTEM = [
  'You maintain a memory store for a long roleplay. Each entry is one fact the narrator',
  'may be told later. You are auditing a numbered batch of them and proposing cleanup.',
  '',
  'Allowed operations:',
  '- "merge": two or more entries that say the same thing, or one that is fully contained',
  '  in another, become ONE entry. The merged text must keep every detail that still',
  '  matters — names, dates, quantities, promises, injuries.',
  '- "rewrite": one entry that is wordy, vague, or written in the wrong person. Sharpen it',
  '  without changing its meaning.',
  '- "supersede": one entry that is now FALSE or no longer applies — the story moved past',
  '  it, someone returned, an object was lost. Superseding removes it from the narrator\'s',
  '  memory; it is not a merge.',
  '',
  'Rules:',
  '- Never invent a fact, a name, a date, or a detail that is not already in the batch.',
  '- Do not merge entries that merely share a topic. "She likes vinyl" and "she owns a',
  '  crate of vinyl" are one entry; "she likes vinyl" and "she works at a record store"',
  '  are two.',
  '- Do not supersede something just because it is old. Only when the batch shows it is no',
  '  longer true.',
  '- If the batch is clean, reply {"ops":[]}. That is the common answer and is correct.',
  '',
  'Reply with JSON only, no prose and no fence:',
  '{"ops":[',
  '  {"op":"merge","ids":[1,4,9],"text":"...","reason":"..."},',
  '  {"op":"rewrite","ids":[3],"text":"...","reason":"..."},',
  '  {"op":"supersede","ids":[7],"reason":"..."}',
  ']}',
].join('\n');

/**
 * Reads one batch of active facts and asks for a cleanup proposal.
 *
 * Oldest first, because the oldest entries are the ones the extractor has stopped being
 * able to see. The model refers to facts by their line number — it is unreliable with
 * UUIDs and reliable with small integers — and the numbers are mapped back here.
 */
export async function proposeCompaction(
  env: Env,
  chatId: string,
  batch = COMPACT_BATCH,
): Promise<CompactProposal> {
  const { results } = await env.DB.prepare(
    `SELECT id, text FROM facts
      WHERE chat_id = ? AND status = 'active' AND deleted = 0
      ORDER BY created_at, id
      LIMIT ?`,
  )
    .bind(chatId, batch + 1)
    .all<{ id: string; text: string }>();

  const settings = await settingsForChat(env, chatId);
  const examined = results.slice(0, batch);
  if (examined.length === 0) return { ops: [], examined: 0, remaining: 0 };

  // Two attempts: the batch as asked for, then a short one. A long batch produces a long
  // answer, and a cheap model asked for thirty merges can run past its output cap mid-JSON
  // — measured on the live chat, which failed at 120 facts. The short retry is the same
  // question over fewer rows, which is cheap and usually enough to get a usable pass.
  const attempts = [examined, examined.slice(0, 40)];
  let reason = 'the compaction reply was not JSON';

  for (const rows of attempts) {
    const reply = await complete(env, {
      settings,
      system: SYSTEM,
      user: [
        `The batch, ${rows.length} entries. The ids are the line numbers:`,
        rows.map((row, index) => `${index + 1}. ${row.text}`).join('\n'),
        '',
        'Reply with the JSON object only.',
      ].join('\n'),
      maxTokens: 2400,
      json: true,
    });

    try {
      const parsed = parseOpsReply(reply.text);
      return {
        ops: readOps(parsed, rows.map((row) => row.id)),
        examined: rows.length,
        remaining: Math.max(0, results.length - rows.length),
      };
    } catch {
      reason =
        reply.finishReason === 'length'
          ? 'the reply ran out of output budget before it finished'
          : 'the reply was not JSON';
    }
  }

  throw new Error(reason);
}

/**
 * The reply as a parsed value.
 *
 * Two tolerances the strict parse does not have, both measured habits of the cheap model:
 * prose before or after the object, and a fence it was told not to add. A balanced `{…}`
 * is tried at each opening brace, tracking strings and escapes so a brace inside a `text`
 * field is not counted as structure.
 */
function parseOpsReply(text: string): unknown {
  try {
    return parseJsonReply<unknown>(text);
  } catch {
    // fall through to the scan
  }

  const trimmed = text.trim();
  for (let start = trimmed.indexOf('{'); start >= 0; start = trimmed.indexOf('{', start + 1)) {
    const end = balancedEnd(trimmed, start);
    if (end === null) break;
    try {
      return JSON.parse(trimmed.slice(start, end));
    } catch {
      // try the next opening brace
    }
  }
  throw new Error('not JSON');
}

/** The index just past the first balanced `{…}` starting at `start`, or null. */
function balancedEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return at + 1;
    }
  }
  return null;
}

/**
 * The proposal, validated against the batch it was made from.
 *
 * An op naming a number outside the batch, a merge of one thing, or a rewrite with no text
 * is dropped rather than rejected: one malformed line must not throw away a batch of
 * otherwise usable cleanup. Nothing here can name a fact the model was not shown.
 */
function readOps(value: unknown, ids: string[]): CompactOp[] {
  const record = asRecord(value);
  const raw = record?.ops;
  if (!Array.isArray(raw)) return [];

  const ops: CompactOp[] = [];
  for (const entry of raw) {
    const op = asRecord(entry);
    if (!op) continue;
    const kind = op.op;
    if (kind !== 'merge' && kind !== 'rewrite' && kind !== 'supersede') continue;

    const numbers = Array.isArray(op.ids) ? op.ids : [];
    const resolved: string[] = [];
    let valid = true;
    for (const number of numbers) {
      const index = typeof number === 'number' ? Math.floor(number) : Number.NaN;
      if (!Number.isFinite(index) || index < 1 || index > ids.length) {
        valid = false;
        break;
      }
      resolved.push(ids[index - 1]);
    }
    if (!valid || resolved.length === 0) continue;
    if (new Set(resolved).size !== resolved.length) continue;

    const text = asString(op.text).trim();
    const reason = asString(op.reason).trim();

    if (kind === 'merge' && (resolved.length < 2 || text.length === 0)) continue;
    if (kind === 'rewrite' && (resolved.length !== 1 || text.length === 0)) continue;
    if (kind === 'supersede' && resolved.length !== 1) continue;

    ops.push({
      op: kind,
      ids: resolved,
      text: kind === 'supersede' ? '' : text,
      reason,
    });
  }
  return ops;
}

/**
 * Applies a proposal.
 *
 * Every id is re-checked against the chat and its current status: a proposal is client-held
 * between the two calls, and a fact may have been deleted or superseded in the panel while
 * the reader read the diff. An op that no longer applies is skipped, not forced.
 *
 * `superseded_at_seq = 0` is the manual form of "definitively superseded": `factIsTrueSql`
 * treats a superseded row with no live turn behind it as no longer true, which is exactly
 * what the reader just decided.
 */
export async function applyCompaction(
  env: Env,
  chatId: string,
  ops: CompactOp[],
): Promise<{ applied: number; skipped: number }> {
  const statements: DbStatement[] = [];
  let applied = 0;
  let skipped = 0;

  for (const op of ops) {
    const current = await env.DB.prepare(
      `SELECT id, status, deleted FROM facts WHERE chat_id = ? AND id IN (${op.ids.map(() => '?').join(',')})`,
    )
      .bind(chatId, ...op.ids)
      .all<{ id: string; status: string; deleted: number }>();

    const live = current.results.filter((row) => row.status === 'active' && row.deleted === 0);
    if (live.length !== op.ids.length) {
      skipped += 1;
      continue;
    }

    if (op.op === 'merge') {
      const keep = op.ids[0];
      statements.push(
        env.DB.prepare('UPDATE facts SET text = ? WHERE id = ? AND chat_id = ?').bind(
          op.text,
          keep,
          chatId,
        ),
      );
      for (const id of op.ids.slice(1)) {
        statements.push(
          env.DB.prepare(
            `UPDATE facts SET status = 'superseded', superseded_by = ?, superseded_at_seq = 0
              WHERE id = ? AND chat_id = ?`,
          ).bind(keep, id, chatId),
        );
      }
      applied += 1;
      continue;
    }

    if (op.op === 'rewrite') {
      statements.push(
        env.DB.prepare('UPDATE facts SET text = ? WHERE id = ? AND chat_id = ?').bind(
          op.text,
          op.ids[0],
          chatId,
        ),
      );
      applied += 1;
      continue;
    }

    statements.push(
      env.DB.prepare(
        `UPDATE facts SET status = 'superseded', superseded_by = NULL, superseded_at_seq = 0
          WHERE id = ? AND chat_id = ?`,
      ).bind(op.ids[0], chatId),
    );
    applied += 1;
  }

  if (statements.length > 0) {
    // One batch: D1's all-or-nothing round trip, so a half-applied cleanup cannot land.
    await env.DB.batch(statements);
  }
  return { applied, skipped };
}

/**
 * A proposal coming back from the browser, validated as untrusted input.
 *
 * The two calls are separate, so the ops make a round trip through the client. They are
 * checked for shape here and for ownership and status in `applyCompaction`; neither check
 * is optional, and the second is what stops a stale proposal from superseding a fact the
 * reader has since pinned or restored.
 */
export function parseClientOps(value: unknown): CompactOp[] | null {
  if (!Array.isArray(value)) return null;
  const ops: CompactOp[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) return null;
    const kind = record.op;
    if (kind !== 'merge' && kind !== 'rewrite' && kind !== 'supersede') return null;
    if (!Array.isArray(record.ids) || record.ids.length === 0) return null;
    if (record.ids.some((id) => typeof id !== 'string' || id.length === 0)) return null;
    if (kind === 'merge' && record.ids.length < 2) return null;
    if (kind !== 'merge' && record.ids.length !== 1) return null;

    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (kind !== 'supersede' && text.length === 0) return null;

    ops.push({
      op: kind,
      ids: record.ids as string[],
      text: kind === 'supersede' ? '' : text,
      reason: typeof record.reason === 'string' ? record.reason.trim() : '',
    });
  }
  return ops;
}
