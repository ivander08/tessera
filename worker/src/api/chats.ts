import { badRequest, json, notFound, readJson } from '../http';
import { getChat, getCharacter, getPersona as loadPersonaRow } from '../db';
import { substituteHead } from '../../../src/lib/prompt/macros';
import { EMPTY_STATE, validatePatch } from '../../../src/lib/state/schema';
import { seedOpeningState } from '../state/update';
import { loadSceneSetup } from '../scene';

/** `GET`/`POST /api/chats`. */
export async function chatsRoute(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const method = req.method;
  if (method === 'GET') return listChats(env);
  if (method === 'POST') return createChat(env, req, ctx);
  return notFound();
}

async function listChats(env: Env): Promise<Response> {
  // The preview is the last message the reader can actually SEE, not the last row
  // written. `ORDER BY seq DESC` would show a reply from an abandoned branch — text that
  // is not on screen — which is exactly the confusion branching exists to avoid.
  //
  // "Last row with no active child" is not the same thing: after a swipe back, the
  // abandoned continuation keeps `active = 1` on its rows, so its leaf is still an active
  // row with no active child and it would win. The walk below is the same walk the
  // transcript uses — down from the active root, newest active child at each step — and
  // the preview is its last row.
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE path(chat_id, seq, id, parent_id, content, depth) AS (
       SELECT c.id, m.seq, m.id, m.parent_id, m.content, 0
         FROM chats c
         JOIN messages m
           ON m.chat_id = c.id AND m.parent_id IS NULL AND m.active = 1 AND m.deleted = 0
       UNION ALL
       SELECT path.chat_id, m.seq, m.id, m.parent_id, m.content, path.depth + 1
         FROM path
         JOIN messages m ON m.seq = (
           SELECT MAX(c2.seq) FROM messages c2
            WHERE c2.chat_id = path.chat_id AND c2.parent_id = path.id
              AND c2.active = 1 AND c2.deleted = 0
         )
     )
     SELECT c.id, c.title, c.updated_at, c.character_id,
            ch.name AS character_name, ch.avatar AS character_avatar,
            (SELECT substr(p.content, 1, 140) FROM path p
              WHERE p.chat_id = c.id
              ORDER BY p.depth DESC LIMIT 1) AS preview
       FROM chats c
       LEFT JOIN characters ch ON ch.id = c.character_id
      ORDER BY c.updated_at DESC`,
  ).all();
  return json(results);
}

async function createChat(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{
    characterId?: string;
    personaId?: string;
    title?: string;
    /** Which opening to start from: 0 is `first_mes`, then the alternates in order. */
    greetingIndex?: number;
  }>(req);
  if (!body?.characterId) return badRequest('characterId required');

  const character = await getCharacter(env, body.characterId);
  if (!character) return notFound('character not found');

  const now = Date.now();
  const id = crypto.randomUUID();
  const card = JSON.parse(character.card_json) as {
    firstMes?: string;
    alternateGreetings?: string[];
    greetingStates?: Array<{ time?: string; location?: string; weather?: string }>;
    nickname?: string;
    description?: string;
  };

  await env.DB.prepare(
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      body.characterId,
      body.personaId ?? null,
      // The chat's own title is the card's title, not the shown name — the library lists
      // chats by the card, while the transcript calls the character by their nickname.
      body.title ?? character.name,
      // Minted once and reused for the chat's life. Without it OpenRouter only
      // pins a provider AFTER it has already seen a cache hit — the turn that missed.
      crypto.randomUUID(),
      now,
      now,
    )
    .run();

  // Which opening the scene starts from. Index 0 is `first_mes`; the alternates follow in
  // their stored order, which is the order the card editor lets you arrange them in.
  //
  // Macros are substituted HERE, at the point the text is stored, because the stored
  // value is what the reader sees. Substituting only on the way to the model left the
  // reader looking at a literal `{{user}}` in the opening line — the one message that is
  // guaranteed to be read. The persona is fixed for the chat's life, so baking it in
  // here cannot go stale.
  // Each opening with the scene the card gives it. Zipped BEFORE the empty filter, so an
  // opening that is dropped takes its own scene with it instead of shifting every later
  // scene onto the wrong opening. The state list is index-aligned with the card's own
  // `[firstMes, ...alternateGreetings]`; carrying the scene alongside the content means
  // the pick below cannot select one opening's prose and another's scene.
  const candidates = [card.firstMes ?? '', ...(card.alternateGreetings ?? [])].map(
    (content, index) => ({ content, state: card.greetingStates?.[index] ?? null }),
  );
  const openings = candidates.filter((entry) => entry.content.trim().length > 0);
  const picked = openings[body.greetingIndex ?? 0] ?? openings[0];
  const chosen = picked?.content;

  if (chosen) {
    const persona = body.personaId ? await loadPersonaRow(env, body.personaId) : null;
    // The shown name is what the narrator should call itself, so `{{char}}` resolves to
    // the nickname when there is one — otherwise a card titled "Quill 25/09/2026" would
    // have the character introduce itself by a date.
    const greeting = substituteHead(chosen, {
      char: card.nickname || character.name,
      user: persona?.name ?? null,
      persona: persona?.name ?? null,
    });

    const greetingId = crypto.randomUUID();
    // The opening's own scene, when the card states one. A card can carry an entry with
    // every field blank — the editor writes `{}` for an opening the reader gave no scene —
    // and that is "nothing stated", not "a scene of empty strings": it must not skip the
    // model seed, and it must not put empty fields into the document.
    const stated = Object.entries(picked?.state ?? {}).filter(
      ([, value]) => typeof value === 'string' && value.trim().length > 0,
    );
    const openingStatePatch = stated.length > 0 ? Object.fromEntries(stated) : null;

    await env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
       VALUES (?, ?, NULL, 'assistant', ?, ?)`,
    )
      .bind(greetingId, id, greeting, now)
      .run();

    // A card that states its opening scene is taken at its word: the reader wrote the
    // time and place themselves, so asking a model to infer them from the greeting would
    // spend a call to overwrite an answer with a guess. The values are applied through
    // `validatePatch`, the same choke point every other state write uses, and attached to
    // the greeting row so the first turn can show its scene line.
    const explicit = openingStatePatch ? validatePatch({ ...EMPTY_STATE }, openingStatePatch) : null;

    if (explicit?.ok) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        ).bind(id, JSON.stringify(explicit.next), now),
        env.DB.prepare('UPDATE messages SET state_json = ? WHERE id = ?')
          .bind(JSON.stringify(explicit.next), greetingId),
      ]);
    } else {
      // The opening seed, if the reader asked for it. Behind `waitUntil` so creating a chat
      // does not wait on a model call, and failing silently: a scene with no opening state
      // is perfectly workable, and the first completed turn will establish one anyway.
      //
      // The greeting is substituted BEFORE it is passed, so the seed reads the same text
      // the reader sees rather than a literal `{{user}}`.
      ctx.waitUntil(
        loadSceneSetup(env, id)
          .then((setup) => {
            if (!setup.generateOpeningState) return { applied: false, reason: 'disabled' };
            return seedOpeningState(
              env,
              id,
              greeting,
              {
                name: card.nickname || character.name,
                description: typeof card.description === 'string' ? card.description : '',
              },
              setup,
              greetingId,
            );
          })
          .catch((error: unknown) => {
            console.warn(`[state] opening seed failed for chat=${id}: ${String(error)}`);
          }),
      );
    }
  }

  return json(await getChat(env, id), 201);
}
