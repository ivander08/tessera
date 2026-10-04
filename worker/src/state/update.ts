import { complete, parseJsonReply } from '../cheap';
import { EMPTY_STATE, validatePatch } from '../../../src/lib/state/schema';
import { parseStateTime } from './time';
import { loadPathTail, visiblePathCte } from '../branch';
import type { WorldState } from '../../../src/lib/state/schema';
import type { SceneSetup } from '../../../src/lib/scene/setup';
import type { StatePoint } from '../turn';

/**
 * M5 — world state tracking.
 *
 * THE RULE THAT PREVENTS THE WORST BUG: state changes come ONLY from validated model
 * proposals. Never let a prose scanner manufacture state. Horde Studio's regex read
 * *"Ada refuses to leave the room"* as Ada departing and nulled her location.
 *
 * A regex or keyword scanner reads the narrator's prose and guesses at intent. Prose
 * is full of negation, hypotheticals, quoted speech, and metaphor, so the scanner is
 * wrong exactly when the writing is interesting. A model reading the same exchange
 * with the schema in front of it can say "no change" or "I am not sure", which a
 * scanner cannot.
 *
 * The narrator model must NEVER see the state schema and must never be asked to emit
 * JSON — a side-channel in the main reply leaks into visible prose and measurably
 * degrades writing quality. This function is a separate call for exactly that reason.
 */

/**
 * The patch schema is described to the CHEAP model only, and this text never reaches
 * the narrator. The cheap model's whole job is to answer "what, if anything, about the
 * world changed in this exchange?" and emit nothing else.
 */
const SYSTEM = [
  'You maintain a small world-state record for a roleplay scene.',
  '',
  'You are given the current state as JSON and the most recent exchange between the',
  'user and the narrator. Reply with a JSON object containing ONLY the keys whose',
  'value changed. An empty object {} is a correct and common answer: most exchanges',
  'change nothing about where anyone is or what they carry.',
  '',
  'Allowed keys:',
  '{{TIME_KEY}}',
  '  "location"   string  — where the scene is, as specifically as the exchange says:',
  '                "Sydney, on the coast" or "the scriptorium, sitting on the bed" is',
  '                better than "indoors". Name the city or region when it is known. Never',
  '                replace a specific stored location with a vaguer one — "gym" is a',
  '                regression from "campus gymnasium bleachers, Universitas Tarumanagara".',
  '                When the scene moves, name the new place at the same specificity.',
  '  "weather"    string  — the sky and the air: temperature, wind, cloud, rain, humidity.',
  '                Never smells, sounds, traffic or a market stall — those belong to the',
  '                location, not the weather, and a smell recorded here is carried for the',
  '                rest of the scene. When the scene changes place or moves to another day',
  '                or night, restate "weather" if it would plausibly differ (indoors vs',
  '                outdoors, midnight vs noon); otherwise leave it alone.',
  '  "present"    array of character NAMES currently in the scene',
  '  "away"       object mapping a character name -> where they are instead, for',
  '                anyone who has left the scene. Use this when someone departs:',
  '                move them out of "present" and into "away" in the same reply.',
  '  "conditions" object mapping character name -> short condition, e.g. {"Ada":"bleeding"}.',
  '                Include only the characters whose condition changed. Set an entry to',
  '                null to remove it once it no longer applies.',
  '  "outfits"    object mapping character name -> what they are wearing right now, e.g.',
  '                {"Sydney":"school uniform, blazer open"}. Include a character only when',
  '                their clothing is established or changes. Record what the text says:',
  '                colours, layers, notable items. Do not invent an outfit, and do not',
  '                restate one that has not changed.{{BONDS_KEY}}{{THREADS_KEY}}',
  '',
  'Rules:',
  '- Emit a key ONLY when the exchange actually establishes a new value for it.',
  '- To clear a key, set it to null. Do not clear a key merely because the exchange',
  '  did not mention it.',
  '- Report what is stated, not what is implied. If a character says they will leave,',
  '  that is not yet a departure. If the text is ambiguous, change nothing.',
  '- Never invent names, places, or items that do not appear in the exchange or state.',
  '{{TIME_BULLET}}',
  '- "present" holds names only. Never put a pronoun or a role there: "me", "you",',
  '  "the user" and "someone" are not names, and they make the cast list useless.',
  '- A character cannot be both present and away. Leaving is one change: remove them',
  '  from "present" and add them to "away". Returning is the reverse.',
  '- "outfits" is what a character is WEARING, not what they own or what is in the room.',
  '  A character who changes clothes gets a new entry; one who does not is left alone.',
  '- "conditions" and "outfits" MERGE with what is already recorded: an entry you do not',
  '  mention is left exactly as it was, so never restate an unchanged one. To remove an',
  '  entry, set it to null. To remove the whole field, set the field to null.',
  '- "present" replaces the previous list entirely when present.',
  '- Reply with the JSON object only. No prose, no explanation, no markdown fence.',
].join('\n');

/**
 * Everything the model is told about `time`, per pace.
 *
 * Two rules used to describe `time` unconditionally — the key description said to advance
 * it, and a Rules bullet said to record any clock the text gave — while the pace rule was
 * appended afterwards. The specific instruction won, so `manual` advanced the clock anyway
 * (measured: 04:00 -> 09:30, while `minute` and `hour` behaved correctly). The instructions
 * have to agree, and they only agree if they are written together.
 *
 * Each entry is the Allowed-keys line it replaces, including its indentation.
 */
const TIME_KEY: Record<SceneSetup['timePace'], string> = {
  auto: [
    '  "time"       string  — the real-world clock time of the scene, as a full date and',
    '                24-hour time: "Friday, April 11, 2025, 22:12". ALWAYS emit this key, on',
    '                every reply: the clock always moves, even when nobody mentions time.',
    '                Compute the new value from the stored one:',
    '                  - stated duration: add it ("10 minutes pass" -> +10 minutes;',
    '                    "three hours later" -> +3 hours)',
    '                  - stated clock time: use it, and take am/pm from the scene — in the',
    '                    evening "at eight" means 20:00, not 08:00',
    '                  - vague time of day: make it concrete, keeping the stored date unless',
    '                    the scene moves to another day — "late evening" -> 21:00, "night" ->',
    '                    23:00, "dawn" -> 06:00, "morning" -> 09:00, "afternoon" -> 15:00',
    '                  - nothing stated: add 1 minute. A longer reply is still 1-3 minutes;',
    '                    only a scene that CLEARLY moves on — a walk across campus, a meal, a',
    '                    stated skip — goes to 10-20 minutes, and a night\'s sleep is the next',
    '                    morning. Without a stated time, never add more than 5 minutes.',
    '                ALWAYS write it in exactly this format: "Weekday, Month D, YYYY, HH:MM"',
  '                with a 24-hour clock — e.g. "Friday, April 11, 2025, 22:12". Never',
  '                shorten it, never drop the year or the weekday, never use am/pm.',
  '                Do not invent a fantasy calendar.',
  '                The clock NEVER moves backwards. A weekday, date or time of day the',
  '                reader names that would land before the stored reading means its NEXT',
  '                occurrence: from a stored "Friday, April 11, 2025, 22:38", a reader who',
  '                says "On Thursday evening" means Thursday, April 17, 2025 — the coming',
  '                Thursday, never the one that has already passed. Same for "tomorrow",',
  '                "next week" and "the next morning": always forward from the stored',
  '                reading. If the reader truly wants an earlier moment, they will set the',
  '                clock by hand; never write one.',
  ].join('\n'),
  manual: [
    '  "time"       string  — the reader maintains this clock. Include the key ONLY when the',
    '                exchange states a time that is not already recorded. Never advance it,',
    '                and never rewrite a time already stored.',
  ].join('\n'),
};

/**
 * The `bonds` key description, spliced in only when `craft.bonds` is on.
 *
 * An instruction the model is not being asked to follow must not be in the prompt: a
 * described key with no consumer invites the model to fill it, and the renderer would then
 * have to throw the result away.
 */
const BONDS_KEY = [
  '\n  "bonds"      object mapping "Name|Name" — the two names SORTED alphabetically, joined',
  '                by a pipe — to {"bond": -20..20, "sparks": 0..20, "grudge": 0..20}.',
  '                bond is trust and affection, sparks is attraction, grudge is resentment.',
  '                Include a pair only when the exchange changes it, and include only the',
  '                value that changed. A pair you do not mention keeps its recorded values.',
].join('\n');

/** The `threads` key description, spliced in only when `craft.threads` is on. */
const THREADS_KEY = [
  '\n  "threads"    array of {"text": "...", "status": "open"|"paid"|"dropped"}. A thread is',
  '                something the scene raised and has not resolved: an unanswered question,',
  '                a promised meeting, an object that will matter. Add one when the',
  '                exchange raises it; set "paid" when it is resolved, "dropped" when it',
  '                is abandoned. Keep the text short and factual. Threads merge by their',
  '                text, so a thread you do not mention is kept — never restate one',
  '                unchanged, and never repeat the list to keep it alive.',
].join('\n');

/** The recording rule for the Rules block, per pace. */
const TIME_BULLET: Record<SceneSetup['timePace'], string> = {
  auto: [
    '- "time" is the exception to "emit a key only when it changes": it is ALWAYS emitted.',
    '  The clock moves forward on every exchange, including a quiet one, but it moves at the',
    '  pace of the scene: a few exchanged lines is one minute, not three. Read the stored',
    '  value and work out the new one from what the exchange says — add a stated duration,',
    '  use a stated clock time, turn a vague time of day into a concrete one, or add a',
    '  minute or two when nothing was said.',
  ].join('\n'),
  manual: [
    '- "time" belongs to the reader. Never change a stored value, and do not add one unless',
    '  the exchange states a time and no time is recorded yet.',
  ].join('\n'),
};

/**
 * Applies to every pace, including `manual`.
 *
 * The per-pace rules above say how the clock ADVANCES, and they were written as though the
 * model were the only one who could move it. A reader who writes "Later, at eight o'clock"
 * has stated the time themselves, and a pace rule telling the model to add a minute would
 * quietly overrule the author of the scene.
 */
const EXPLICIT_TIME_RULE: Record<SceneSetup['timePace'], string> = {
  auto: [
    "Regardless of the rule above: if the READER's own message states a clock time or a date",
    '("at eight o\'clock", "the next morning"), that stated time is the truth. Work it into',
    '"time" as the new clock reading rather than adding to it. It still never lands before',
    'the stored reading: a weekday that has already passed this week means the coming one.',
  ].join('\n'),
  manual: [
    "Regardless of the rule above: if the READER's own message states a clock time or a date",
    '("at eight o\'clock", "the next morning"), record it verbatim in "time" — the reader',
    'authored it. Never advance a stored clock.',
  ].join('\n'),
};

/**
 * The system prompt for one setup: `SYSTEM` with the time key, its rule, and the optional
 * bonds/threads keys spliced in.
 *
 * `SYSTEM` keeps a placeholder for each, so the rest of the prompt is written once and the
 * varying lines are the only part that differs. An unset placeholder becomes '', which is
 * why each optional key carries its own leading newline.
 */
function buildSystemPrompt(setup: SceneSetup): string {
  return SYSTEM.replace('{{TIME_KEY}}', TIME_KEY[setup.timePace])
    .replace('{{TIME_BULLET}}', TIME_BULLET[setup.timePace])
    .replace('{{BONDS_KEY}}', setup.craft.bonds ? BONDS_KEY : '')
    .replace('{{THREADS_KEY}}', setup.craft.threads ? THREADS_KEY : '')
    .concat('\n', EXPLICIT_TIME_RULE[setup.timePace]);
}

/**
 * Read the last exchange, ask the cheap model for a state patch, validate it, and
 * store the result.
 *
 * Never throws: this runs behind a chat turn, and a failed state update must not
 * surface as a failed reply. Every error path returns `{ applied: false, reason }`.
 */
export async function updateState(
  env: Env,
  chatId: string,
  lastExchange: { user: string; assistant: string },
  setup: SceneSetup,
  /** The assistant row this state describes, so a snapshot can be attached to it. */
  messageId?: string | null,
  /**
   * Where the state is read from — the turn's anchor on the visible path. Never the live
   * document except for a chat with no rows yet: a deleted or regenerated turn must not
   * poison what the next turn computes from. Reported: the reader deleted the turn that
   * had jumped the clock to 22:21, so the live row said 22:21 while the path said 22:01 —
   * and the resent turn computed 22:21 + 20. Reading from the path is the same rule the
   * prompt applies, so the narrator and the state engine cannot disagree about "now".
   */
  point?: StatePoint | null,
): Promise<{ applied: boolean; reason?: string }> {
  try {
    const current = await loadStateForTurn(env, chatId, point ?? { seq: null, inclusive: true });

    const reply = await complete(env, {
      system: buildSystemPrompt(setup),
      user: [
        'Current state:',
        JSON.stringify(current),
        '',
        'Most recent exchange:',
        `user: ${lastExchange.user}`,
        `narrator: ${lastExchange.assistant}`,
        '',
        'Reply with the JSON patch object only.',
      ].join('\n'),
      maxTokens: 2048,
      json: true,
    });

    // Fences are stripped by `parseJsonReply`. A model that wraps valid JSON in a
    // fence has still answered correctly; throwing it away over formatting would
    // waste the call and skip a legitimate update.
    let patch: unknown;
    try {
      patch = parseJsonReply<unknown>(reply.text);
    } catch (error) {
      return { applied: false, reason: `reply was not JSON: ${messageOf(error)}` };
    }

    // The model writes the clock itself, including turning a vague time of day ("late
    // evening") into a concrete reading, and is told to emit `time` on every reply. The
    // earlier design split the job — the model counted elapsed minutes and code added
    // them — which was more moving parts than the problem needs, and left a free-text
    // stored value permanently un-advanceable because there was nothing to add to.
    const result = validatePatch(current, patch);
    if (!result.ok) return { applied: false, reason: result.reason };

    // The clock never runs backwards. The prompt says so, but a model doing weekday
    // arithmetic cannot be trusted to follow it — measured on the reported chat: from a
    // stored "Friday, April 11, 2025, 22:38" the reader's "On Thursday evening" was
    // recorded as Thursday, April 10, a day in the past. So the rule is enforced here,
    // where it cannot be talked out of it, and only under the managed pace: `manual` means
    // the reader owns the clock and may legitimately state an earlier moment, and a
    // hand-edited document goes through `patchState`, never through this function.
    //
    // Only the time key is dropped; the rest of the patch still applies, because one bad
    // field must not cost the exchange's real changes. A clock that will not parse (free
    // text under `manual`, or an older document) cannot be compared, so the guard stands
    // aside rather than rejecting a legitimate normalisation.
    let next = result.next;
    if (setup.timePace === 'auto' && next.time !== undefined && current.time !== undefined) {
      const stored = parseStateTime(current.time);
      const proposed = parseStateTime(next.time);
      if (stored !== null && proposed !== null && proposed < stored) {
        console.warn(
          `[state] dropped a clock that moved backwards for chat=${chatId}: ` +
            `"${current.time}" -> "${next.time}"`,
        );
        const withoutTime = { ...(patch as Record<string, unknown>) };
        delete withoutTime.time;
        const retried = validatePatch(current, withoutTime);
        if (retried.ok) next = retried.next;
      }
    }

    await env.DB.prepare(
      `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
      .bind(chatId, JSON.stringify(next), Date.now())
      .run();

    // Snapshot onto the turn this state describes, so "where was I when this happened" is
    // answerable later. The live document is overwritten every turn; this is not.
    //
    // Only when the caller named a row. An opening seed has no message to attach to, and
    // null is the honest answer for "this state belongs to no turn".
    if (messageId) {
      await env.DB.prepare('UPDATE messages SET state_json = ? WHERE id = ?')
        .bind(JSON.stringify(next), messageId)
        .run();
    }

    return { applied: true };
  } catch (error) {
    // Missing cheap model, no API key, provider down, D1 unavailable: all of it is
    // "no update this turn", not a broken chat.
    return { applied: false, reason: messageOf(error) };
  }
}

/**
 * The one-shot opening seed.
 *
 * A scene that opens with a time, a place and an outfit already recorded reads correctly
 * from the first turn instead of the narrator discovering where it is three exchanges in.
 * The greeting is the only text that exists at this point, so it is the only source —
 * which is why the instruction is explicit that anything the greeting does not establish
 * must be omitted rather than invented.
 *
 * Never throws, and never blocks: the caller runs it behind the response. A scene with no
 * opening state is fine; a chat creation that waits on a model call is not.
 */
export async function seedOpeningState(
  env: Env,
  chatId: string,
  openingContent: string,
  card: { name: string; description: string },
  setup: SceneSetup,
  /** The greeting row, so the seed lands ON the visible path. See the snapshot below. */
  greetingId?: string | null,
): Promise<{ applied: boolean; reason?: string }> {
  try {
    // Nothing to seed from, and a call with no user text is a wasted one.
    if (openingContent.trim().length === 0) return { applied: false, reason: 'no greeting' };

    const reply = await complete(env, {
      system: `${buildSystemPrompt(setup)}\n${OPENING_RULE}`,
      user: [
        'Current state:',
        '{}',
        '',
        "The character's card:",
        `name: ${card.name}`,
        `description: ${card.description}`,
        '',
        'The opening of the scene:',
        openingContent,
        '',
        'Reply with the JSON patch object only.',
      ].join('\n'),
      maxTokens: 2048,
      json: true,
    });

    let patch: unknown;
    try {
      patch = parseJsonReply<unknown>(reply.text);
    } catch (error) {
      return { applied: false, reason: `reply was not JSON: ${messageOf(error)}` };
    }

    const result = validatePatch({ ...EMPTY_STATE }, patch);
    if (!result.ok) return { applied: false, reason: result.reason };

    // An empty patch is a legitimate answer — a greeting that establishes nothing gets
    // no state — and writing `{}` over a row that does not exist is a write with no
    // information in it.
    if (Object.keys(result.next).length === 0) return { applied: false, reason: 'nothing established' };

    await env.DB.prepare(
      `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
      .bind(chatId, JSON.stringify(result.next), Date.now())
      .run();

    // The seed must exist ON the visible path, not only in the live row: every turn reads
    // the path at its anchor, and a seed that lives only in the live document is invisible
    // to them — the first turn would re-derive time, place and outfit from nothing.
    // The greeting is the anchor every early turn reads back to, so the snapshot goes there.
    if (greetingId) {
      await env.DB.prepare('UPDATE messages SET state_json = ? WHERE id = ?')
        .bind(JSON.stringify(result.next), greetingId)
        .run();
    }

    return { applied: true };
  } catch (error) {
    return { applied: false, reason: messageOf(error) };
  }
}

const OPENING_RULE = [
  'This is the OPENING of a scene. Nothing has happened yet. Establish the initial "time",',
  '"location", "weather" and "outfits" that the greeting implies, and leave everything else',
  'empty. If the greeting does not establish something, omit it rather than inventing it.',
  'Emit "time" as a full date and 24-hour clock reading when the greeting implies one,',
  'including when it only gives a time of day ("late evening" -> 21:00).',
  // A greeting rarely states a clock, and under `manual` the reader owns it — seeding one
  // would hand them a time they did not choose.
  'When the pace is manual, omit "time" entirely.',
].join('\n');

/**
 * The world state to write one turn against, read from the turn's anchor on the visible
 * path (see `statePointFor`).
 *
 * `point.seq === null` — a chat with no visible rows yet, which only the very first turn
 * of a fresh chat can produce — falls back to the live document, which at that moment is
 * either empty or the opening seed.
 *
 * Inclusive anchors need the newest snapshot at or before the anchor row. `seq` is a
 * global autoincrement, so `seq <= anchor` is expressed as `seq < anchor + 1`: the walk
 * itself stays strictly-before, one query for both cases.
 */
export async function loadStateForTurn(
  env: Env,
  chatId: string,
  point: StatePoint,
): Promise<WorldState> {
  if (point.seq === null) return await loadState(env, chatId);
  return await loadStateAt(env, chatId, point.inclusive ? point.seq + 1 : point.seq);
}

/**
 * The state as of the end of the visible path — the same document the next turn will read,
 * which is what the viewer and a hand edit must operate on.
 *
 * The live row is a convenience copy, not the truth: every turn writes the path and reads
 * the path, so after a swipe the live document can describe a version that is no longer on
 * screen. Showing the reader the live row while the transcript's scene line shows the path
 * is exactly the disagreement that made a corrected clock look unpersisted.
 *
 * Falls back to the live row only when the path records no snapshot at all — a chat whose
 * rows predate snapshots, or whose newest snapshot was deleted. An empty document is the
 * honest answer only when nothing anywhere records one.
 */
export async function loadStateForViewer(env: Env, chatId: string): Promise<WorldState> {
  const [tail] = await loadPathTail(env, chatId, 1);
  if (!tail) return await loadState(env, chatId);
  const state = await loadStateAt(env, chatId, tail.seq + 1);
  return Object.keys(state).length > 0 ? state : await loadState(env, chatId);
}

/**
 * The row a hand edit is written onto: the newest scene line on the visible path.
 *
 * The scene line is drawn on the character's replies, so the correction belongs on the
 * newest assistant row — not on the tail, which is the reader's own row between a send and
 * its reply, and not on whatever row happens to hold the highest `seq`, which can be a row
 * of a branch that was swiped away and is no longer on the path at all.
 */
export async function stateAnchor(env: Env, chatId: string): Promise<{ id: string } | null> {
  // The walk is recursive over the whole path regardless of the limit, so a wide window
  // costs no more than a narrow one and covers a run of reader rows (impersonation).
  const rows = await loadPathTail(env, chatId, 400);
  const newestFirst = [...rows].reverse();
  const anchor = newestFirst.find((row) => row.role === 'assistant') ?? rows[rows.length - 1];
  return anchor ? { id: anchor.id } : null;
}

/**
 * Load the stored document.
 *
 * Only this module writes the row, but it is still parsed through the SAME validator
 * the patches go through: a hand-edited row, a partially written one, or a document
 * from an older schema must degrade to "start over" rather than becoming a base that
 * accepts garbage or silently drops keys on the next merge. `validatePatch` returns a
 * fresh object, so the caller cannot mutate anything shared.
 */
export async function loadState(env: Env, chatId: string): Promise<WorldState> {
  const row = await env.DB.prepare('SELECT json FROM state WHERE chat_id = ?')
    .bind(chatId)
    .first<{ json: string }>();
  if (!row) return { ...EMPTY_STATE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.json);
  } catch {
    return { ...EMPTY_STATE };
  }

  const result = validatePatch(EMPTY_STATE, parsed);
  return result.ok ? result.next : { ...EMPTY_STATE };
}

/**
 * The world state to write one turn against.
 *
 * `beforeSeq === null` means "now": the live document, which is what a step forward needs.
 *
 * A number means "re-roll the row at this seq", and the state is read from BEFORE it. The
 * snapshot on a row is the state its own turn PRODUCED (`updateState` snapshots onto the
 * reply it just wrote), so including that row would hand the model the outcome of the very
 * reply being rewritten. The reported failure was a character being walked back INTO a room
 * by a regenerate: the scene said she had left it, that fact came from the turn being
 * re-rolled, and feeding it back made her re-enter. Strictly-before is what excludes it.
 *
 * The snapshot is the newest one on the visible path strictly before `beforeSeq`. That is
 * the rule migration `0011` documents ("a reader sees the most recent snapshot at or before
 * it, which is exactly what was true at the time") applied to the prompt, which never did it.
 *
 * Walks the path rather than filtering by `seq` alone. `seq` is a global insert counter, not
 * a transcript position, so an alternative written later can carry a HIGHER seq while
 * sitting EARLIER on the path. Filtering by seq would return a snapshot from further down
 * the scene. The walk takes the active chain, exactly as the history window does.
 *
 * A point with no snapshot — before the first recorded turn, or on rows written before
 * snapshots existed — is answered with the EMPTY state, never the live one. The live
 * document describes the END of the scene, and offering it as "what was true then" is the
 * bug being fixed. `{ ...EMPTY_STATE }` is the honest answer for "nothing recorded yet", and
 * the prompt renders no state block for it.
 */
export async function loadStateAt(
  env: Env,
  chatId: string,
  beforeSeq: number | null,
): Promise<WorldState> {
  if (beforeSeq === null) return await loadState(env, chatId);

  const row = await env.DB.prepare(
    `${visiblePathCte('path', 'id, seq, parent_id, state_json')}
     SELECT state_json FROM path
      WHERE state_json IS NOT NULL AND seq < ?2
      ORDER BY depth DESC
      LIMIT 1`,
  )
    .bind(chatId, beforeSeq)
    .first<{ state_json: string }>();

  if (!row) return { ...EMPTY_STATE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    return { ...EMPTY_STATE };
  }

  const result = validatePatch(EMPTY_STATE, parsed);
  return result.ok ? result.next : { ...EMPTY_STATE };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
