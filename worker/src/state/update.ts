import { complete, parseJsonReply } from '../cheap';
import { EMPTY_STATE, validatePatch } from '../../../src/lib/state/schema';
import type { WorldState } from '../../../src/lib/state/schema';

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
  '  "time"       string  — the real-world clock time of the scene, as a full date and',
  '                time: "Wednesday, 30 September 2026, 05:34 AM". Use the actual date',
  '                and time when the exchange establishes one, and advance it as the',
  '                scene moves. Do not invent a fantasy calendar.',
  '  "location"   string  — where the scene is, as specifically as the exchange says:',
  '                "Sydney, on the coast" or "the scriptorium, sitting on the bed" is',
  '                better than "indoors". Name the city or region when it is known.',
  '  "weather"    string  — current weather, only when the exchange establishes it',
  '  "present"    array of character NAMES currently in the scene',
  '  "away"       object mapping a character name -> where they are instead, for',
  '                anyone who has left the scene. Use this when someone departs:',
  '                move them out of "present" and into "away" in the same reply.',
  '  "inventory"  array of notable items a character is carrying',
  '  "conditions" object mapping character name -> short condition, e.g. {"Ada":"bleeding"}',
  '  "notes"      array of short factual notes worth remembering',
  '',
  'Rules:',
  '- Emit a key ONLY when the exchange actually establishes a new value for it.',
  '- To clear a key, set it to null. Do not clear a key merely because the exchange',
  '  did not mention it.',
  '- Report what is stated, not what is implied. If a character says they will leave,',
  '  that is not yet a departure. If the text is ambiguous, change nothing.',
  '- Never invent names, places, or items that do not appear in the exchange or state.',
  '- "time" is the reader\'s real-world time, not an in-fiction day count. If the',
  '  exchange gives a date, a clock time, or a day of the week, record it in full.',
  '- "present" holds names only. Never put a pronoun or a role there: "me", "you",',
  '  "the user" and "someone" are not names, and they make the cast list useless.',
  '- A character cannot be both present and away. Leaving is one change: remove them',
  '  from "present" and add them to "away". Returning is the reverse.',
  '- "inventory" is what someone is CARRYING, not what happens to be in the room.',
  '- Arrays replace the previous array entirely when present.',
  '- Reply with the JSON object only. No prose, no explanation, no markdown fence.',
].join('\n');

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
): Promise<{ applied: boolean; reason?: string }> {
  try {
    const current = await loadState(env, chatId);

    const reply = await complete(env, {
      system: SYSTEM,
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
      maxTokens: 400,
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

    const result = validatePatch(current, patch);
    if (!result.ok) return { applied: false, reason: result.reason };

    await env.DB.prepare(
      `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
      .bind(chatId, JSON.stringify(result.next), Date.now())
      .run();

    return { applied: true };
  } catch (error) {
    // Missing cheap model, no API key, provider down, D1 unavailable: all of it is
    // "no update this turn", not a broken chat.
    return { applied: false, reason: messageOf(error) };
  }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
