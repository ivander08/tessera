import { getCharacter } from './db';
import { VISIBLE_PATH_SEQ_CTE } from './branch';
import { VOICE_SLOTS } from '../../src/lib/theme';
import { speakersIn } from '../../src/lib/transcript/speakers';

/**
 * Who is in a scene.
 *
 * A cast is a list of SPEAKERS, not of characters. The narrator may write any name into
 * the scene, and it appears immediately with a letter avatar and a voice colour; the
 * reader may later promote it to a real card. That ordering is the point — waiting for a
 * card before a character can speak would make an introduced character impossible.
 *
 * The chat's own character is the PRIMARY member. A chat with no cast rows at all still
 * has a cast: one synthetic primary row, derived from `chats.character_id`. That is what
 * keeps every single-character scene working with no rows, no migration and no change in
 * behaviour.
 */
export interface CastRow {
  chat_id: string;
  id: string;
  character_id: string | null;
  name: string;
  color: string | null;
  is_primary: number;
  created_at: number;
}

/**
 * The cast, primary first then by creation.
 *
 * The chat's own character is ALWAYS a member, whether or not a row exists for it. When
 * the table is empty for this chat the whole cast is that one synthetic row; when rows
 * exist but none is the primary — which is the state after the first introduced speaker is
 * added — the synthetic row is prepended.
 *
 * Deriving it rather than writing it is what keeps a `GET` a read. It is also what makes
 * "has the reader configured a cast?" answerable: the table holds exactly the members the
 * narrator or the reader added, and the character is implicit.
 *
 * Getting this wrong is subtle and was: returning only the stored rows dropped the
 * character from the cast the moment anyone else spoke, which re-added the character as a
 * SUPPORTING member on the next reply and removed them from the prompt's cast block.
 */
export async function loadCast(
  env: Env,
  chatId: string,
  /**
   * Only members introduced before this turn, and whose introducing turn is still on the
   * visible path. `null` means "now" and returns the whole cast.
   *
   * A member added by a reply that has since been regenerated away was never in this scene,
   * so injecting them puts a stranger in the room. Same two bounds the summary read uses.
   */
  beforeSeq: number | null = null,
): Promise<CastRow[]> {
  const { results } = await env.DB.prepare(
    // `joined_seq = 0` is the primary character and anything predating provenance: always
    // visible, because it belongs to the chat rather than to a turn.
    `${VISIBLE_PATH_SEQ_CTE}
     SELECT chat_id, id, character_id, name, color, is_primary, created_at
       FROM chat_cast
      WHERE chat_id = ?1
        AND (
          joined_seq = 0
          OR (
            (?2 IS NULL OR joined_seq < ?2)
            AND EXISTS (SELECT 1 FROM path WHERE path.seq = chat_cast.joined_seq)
          )
        )
      ORDER BY is_primary DESC, created_at`,
  )
    .bind(chatId, beforeSeq)
    .all<CastRow>();

  if (results.some((row) => row.is_primary === 1)) return results;

  // No stored primary: derive it from the chat's own character and put it first, because
  // every reader of this function treats index 0 as the character the scene is written
  // from.
  const primary = await primaryRow(env, chatId);
  return primary ? [primary, ...results] : results;
}

/** The chat's own character as a cast member, or null when the chat has no character. */
async function primaryRow(env: Env, chatId: string): Promise<CastRow | null> {
  const chat = await env.DB.prepare('SELECT character_id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ character_id: string | null }>();
  if (!chat?.character_id) return null;

  const character = await getCharacter(env, chat.character_id);
  if (!character) return null;

  return {
    chat_id: chatId,
    // The character's own id, so a caller that treats cast ids as opaque still gets a
    // stable one — and a promoted row written later lands on the same id.
    id: character.id,
    character_id: character.id,
    name: shownNameOf(character.card_json) || character.name,
    color: null,
    is_primary: 1,
    created_at: 0,
  };
}

/**
 * The cast as the narrator should see it: the shown name of each member, primary first.
 *
 * Reads the SAME source `loadCast` does, so what the prompt is told and what the
 * transcript renders cannot disagree.
 */
export async function castNames(env: Env, chatId: string): Promise<string[]> {
  const cast = await loadCast(env, chatId);
  return cast.map((row) => row.name);
}

/**
 * Adds a speaker.
 *
 * Matching is case-insensitive on the trimmed name: the narrator writes `olivia` and
 * `Olivia` and they are the same person, and a cast with both would render as two
 * speakers with two colours. The cast is a handful of rows and is already loaded, so this
 * compares in memory rather than adding a `COLLATE NOCASE` index.
 *
 * Returns the EXISTING row when the name is already present, so a caller can add freely
 * without checking first.
 */
export async function addCastMember(
  env: Env,
  chatId: string,
  name: string,
  /** The turn that introduced this speaker; 0 for one that predates any message. */
  joinedSeq = 0,
): Promise<CastRow> {
  const trimmed = name.trim();
  const existing = await loadCast(env, chatId);
  const already = existing.find((row) => row.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (already) return already;

  // The palette slot is the size of the cast, wrapped — and then advanced past any slot
  // already in use, so two speakers never share a colour while slots remain.
  const used = new Set(existing.map((row) => row.color).filter((color): color is string => !!color));
  let slot = existing.length % VOICE_SLOTS;
  for (let step = 0; step < VOICE_SLOTS; step += 1) {
    const candidate = `--voice-${((slot + step) % VOICE_SLOTS) + 1}`;
    if (!used.has(candidate)) {
      slot = (slot + step) % VOICE_SLOTS;
      break;
    }
  }

  const row: CastRow = {
    chat_id: chatId,
    id: crypto.randomUUID(),
    character_id: null,
    name: trimmed,
    color: `--voice-${slot + 1}`,
    is_primary: 0,
    created_at: Date.now(),
  };

  await env.DB.prepare(
    `INSERT INTO chat_cast (chat_id, id, character_id, name, color, is_primary, joined_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.chat_id,
      row.id,
      row.character_id,
      row.name,
      row.color,
      row.is_primary,
      joinedSeq,
      row.created_at,
    )
    .run();

  return row;
}

/**
 * Attaches a real card to a cast member and renames it to the card's shown name.
 *
 * The transcript keeps whatever the row said at the time it was written — `messages.speaker`
 * stores a name, not a cast id — so promoting changes future attribution and the cast list,
 * never history.
 */
export async function promoteCastMember(
  env: Env,
  chatId: string,
  id: string,
  characterId: string,
): Promise<CastRow | null> {
  const character = await getCharacter(env, characterId);
  if (!character) return null;

  const name = shownNameOf(character.card_json) || character.name;

  const result = await env.DB.prepare(
    'UPDATE chat_cast SET character_id = ?, name = ? WHERE chat_id = ? AND id = ?',
  )
    .bind(characterId, name, chatId, id)
    .run();

  if ((result.meta.changes ?? 0) === 0) return null;
  return await castMember(env, chatId, id);
}

export async function removeCastMember(env: Env, chatId: string, id: string): Promise<void> {
  // The primary member is the chat's own character; removing it would leave a scene with
  // no narrator. The caller hides the control rather than relying on this, but the guard
  // is what makes the rule true rather than merely stated.
  await env.DB.prepare('DELETE FROM chat_cast WHERE chat_id = ? AND id = ? AND is_primary = 0')
    .bind(chatId, id)
    .run();
}

/** One member, or null. */
export async function castMember(
  env: Env,
  chatId: string,
  id: string,
): Promise<CastRow | null> {
  const cast = await loadCast(env, chatId);
  return cast.find((row) => row.id === id) ?? null;
}

/**
 * Records anyone the narrator introduced in a reply.
 *
 * Called after a `send`, behind the response. Reads the script form the narrator was told
 * to write and adds each new name to the cast, so an introduced character has a voice
 * colour and appears in the cast panel from the moment they speak.
 *
 * The exclusions are the whole point: the reader's persona and the chat's own character
 * are already accounted for, and a false positive invents a cast member who then renders
 * as a speaker with a colour and an avatar. `speakersIn` handles the pronouns.
 *
 * Returns the names it added, which is what the tests assert against.
 */
export async function recordSpeakers(
  env: Env,
  chatId: string,
  content: string,
  /** The turn this reply occupies, so the cast member is scoped to it. */
  atSeq: number,
): Promise<string[]> {
  // Read UNBOUNDED — not `loadCast`, which is path-filtered for the prompt. This is a
  // deduplication question ("have we ever recorded this person?"), not a visibility one.
  // Using the visibility read here would make a member whose introducing turn is off the
  // visible path look new, and re-add them with a second colour.
  const { results: stored } = await env.DB.prepare(
    'SELECT name FROM chat_cast WHERE chat_id = ?',
  )
    .bind(chatId)
    .all<{ name: string }>();

  // Everyone already known, so the reply's existing speakers are not re-added.
  //
  // The stored rows are not the whole cast: the chat's own character is DERIVED by
  // `loadCast` when no row claims `is_primary`, so reading the table alone would leave the
  // primary out of `known` and the narrator's own name would be re-added as a supporting
  // member on every reply.
  const known = stored.map((row) => row.name);
  const primary = await primaryRow(env, chatId);
  if (!primary) return [];
  if (!known.some((name) => name.trim().toLowerCase() === primary.name.trim().toLowerCase())) {
    known.push(primary.name);
  }

  // The persona is the reader. The narrator naming them in a script is the model
  // overstepping, and it must not become a cast member.
  const persona = await env.DB.prepare('SELECT name FROM personas WHERE id = (SELECT persona_id FROM chats WHERE id = ?)')
    .bind(chatId)
    .first<{ name: string }>();
  if (persona?.name) known.push(persona.name);

  const found = speakersIn(content, known);

  const added: string[] = [];
  for (const name of found) {
    const row = await addCastMember(env, chatId, name, atSeq);
    added.push(row.name);
  }
  return added;
}

/** CCv3's `nickname` — the name the reader sees — falling back to nothing. */
function shownNameOf(cardJson: string): string {
  try {
    const card = JSON.parse(cardJson) as { nickname?: unknown };
    return typeof card.nickname === 'string' ? card.nickname : '';
  } catch {
    return '';
  }
}
