import { badRequest, notFound } from './http';
import { getChat, getCharacter, getPersona } from './db';
import { loadCast } from './cast';
import { loadPath } from './branch';
import { loadState } from './state/update';
import { substituteHead } from '../../src/lib/prompt/macros';

/**
 * Exporting a scene.
 *
 * The visible path only, walked by `loadPath` — never a flat `ORDER BY seq`, which would
 * include rows on abandoned branches. Exporting text the reader cannot see would be a
 * transcript that disagrees with the app, which is worse than no export.
 *
 * Both formats are built here rather than on the client: the endpoint already has the
 * character, the persona, the cast and the state, and a client-side export would need four
 * round trips and a second implementation of "who said this".
 */

/** CCv3's `nickname`, falling back to the card's title. */
function shownName(cardJson: string, fallback: string): string {
  try {
    const card = JSON.parse(cardJson) as { nickname?: unknown };
    return typeof card.nickname === 'string' && card.nickname.length > 0 ? card.nickname : fallback;
  } catch {
    return fallback;
  }
}

export async function exportChat(env: Env, chatId: string, url: URL): Promise<Response> {
  const chat = await getChat(env, chatId);
  if (!chat) return notFound('chat not found');

  const format = url.searchParams.get('format') ?? 'md';
  if (format !== 'md' && format !== 'json') return badRequest('format must be md or json');

  const [character, persona, cast, path, state] = await Promise.all([
    chat.character_id ? getCharacter(env, chat.character_id) : null,
    chat.persona_id ? getPersona(env, chat.persona_id) : null,
    loadCast(env, chatId),
    loadPath(env, chatId),
    loadState(env, chatId),
  ]);

  const characterName = character ? shownName(character.card_json, character.name) : 'Character';
  const personaName = persona?.name ?? 'You';

  const messages = path.map((row) => ({
    seq: row.seq,
    id: row.id,
    role: row.role,
    content: substituteHead(row.content, { char: characterName, user: personaName }),
    // Null means the chat's own character, which is every row in a single-character scene.
    speaker: row.speaker ?? (row.role === 'user' ? personaName : characterName),
    created_at: row.created_at,
  }));

  const filename = `${slug(chat.title ?? characterName)}-${new Date().toISOString().slice(0, 10)}`;
  const headers = {
    'content-disposition': `attachment; filename="${filename}.${format}"`,
  };

  if (format === 'json') {
    return new Response(
      JSON.stringify(
        {
          chat,
          character: character ? { id: character.id, name: character.name, shownName: characterName } : null,
          persona: persona ? { id: persona.id, name: persona.name } : null,
          cast,
          state,
          messages,
        },
        null,
        2,
      ),
      { headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } },
    );
  }

  return new Response(renderMarkdown({ chat, characterName, personaName, cast, state, messages }), {
    headers: { ...headers, 'content-type': 'text/markdown; charset=utf-8' },
  });
}

interface ExportMessage {
  seq: number;
  role: string;
  content: string;
  speaker: string;
}

/**
 * The markdown shape: a title, an italic line of where and when, then each message as
 * `**Speaker**` followed by its prose.
 *
 * World state is read for the scene line rather than being appended wholesale: the
 * document is a working record, and dumping it into a readable export would put the
 * narrator's bookkeeping in the middle of the story.
 */
function renderMarkdown(input: {
  chat: { title: string | null; created_at: number };
  characterName: string;
  personaName: string;
  cast: Array<{ name: string; is_primary: number }>;
  state: { location?: string; time?: string; weather?: string };
  messages: ExportMessage[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${input.chat.title ?? input.characterName}`);
  lines.push('');

  const where = [input.state.location, input.state.time, input.state.weather]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part && part.length > 0);
  if (where.length > 0) {
    lines.push(`*${where.join(' · ')}*`);
    lines.push('');
  }

  const cast = input.cast.map((member) => member.name).filter(Boolean);
  if (cast.length > 1) {
    lines.push(`*Cast: ${cast.join(', ')}*`);
    lines.push('');
  }

  for (const message of input.messages) {
    lines.push(`**${message.speaker}**`);
    lines.push('');
    lines.push(message.content);
    lines.push('');
  }

  return lines.join('\n');
}

/** A filename that survives every filesystem: lowercase, hyphens, nothing exotic. */
function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'scene';
}
