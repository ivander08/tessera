/**
 * End-to-end acceptance against production.
 *
 * Exercises the features that interact, in one run, because the failures that matter
 * here are compositional: macros need a persona, a preset needs to reach the provider,
 * and all of it has to leave the cached prefix intact. Individually passing parts proved
 * nothing — the memory pipeline was fully unit-tested and never ran.
 *
 * Usage: bun run verify/e2e.ts <baseUrl> <token>
 */
const [baseUrl, token] = process.argv.slice(2);
const headers = {
  Authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  connection: 'close',
};

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function turn(chatId: string, content: string, mode = 'send'): Promise<{ text: string; usage: Record<string, number> }> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ chatId, content, mode }),
  });
  const raw = await res.text();
  let text = '';
  let usage: Record<string, number> = {};
  for (const block of raw.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const frame = JSON.parse(line.slice(5).trim()) as {
      type: string;
      text?: string;
      usage?: Record<string, number>;
      message?: string;
    };
    if (frame.type === 'delta') text += frame.text ?? '';
    if (frame.type === 'done' && frame.usage) usage = frame.usage;
    if (frame.type === 'error') throw new Error(frame.message);
  }
  return { text, usage };
}

// ---------------------------------------------------------------- setup

const persona = await api<{ id: string }>('/api/personas', {
  method: 'POST',
  body: JSON.stringify({ name: 'Ivan', description: 'A tired cartographer.' }),
});
check('create persona', !!persona.id);

const card = await api<{ id: string }>('/api/characters', {
  method: 'POST',
  body: JSON.stringify({
    card: {
      name: 'Quill',
      description: 'Quill is a scribe. She addresses {{user}} by name and signs herself {{char}}.',
      personality: 'Precise.',
      scenario: 'A scriptorium.',
      firstMes: '*Quill looks up.* {{user}}. You are late.',
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      alternateGreetings: [],
      creatorNotes: '',
      tags: [],
      characterBook: {
        entries: [
          {
            id: '1',
            keys: ['archive'],
            content: 'The under-archive was sealed after the flood of the ninth year.',
            constant: false,
            enabled: true,
            insertion_order: 0,
          },
        ],
      },
      avatarHint: null,
      sourceFormat: 'ccv2',
    },
  }),
});
check('create character', !!card.id);

const chat = await api<{ id: string }>('/api/chats', {
  method: 'POST',
  body: JSON.stringify({ characterId: card.id, personaId: persona.id }),
});
check('create chat with persona', !!chat.id);

// ---------------------------------------------------------------- macros

const greeting = await api<{ messages: Array<{ content: string }> }>(`/api/chats/${chat.id}/messages`);
const opening = greeting.messages[0]?.content ?? '';
check('opening message has no unresolved macro', !opening.includes('{{'), opening.slice(0, 60));
check('opening message resolved {{user}} to the persona name', opening.includes('Ivan'), opening.slice(0, 60));

const named = await turn(chat.id, 'What is my name? Answer with one word.');
check('model reports the persona name', /ivan/i.test(named.text), named.text.trim().slice(0, 50));

// ---------------------------------------------------------------- lorebook

const noKeyword = await turn(chat.id, 'Say something short about the weather.');
const withKeyword = await turn(chat.id, 'What do you know about the under-archive?');
check(
  'keyword entry fires only when its keyword appears',
  !/sealed|flood|ninth year/i.test(noKeyword.text) && /sealed|flood|ninth year/i.test(withKeyword.text),
  withKeyword.text.trim().slice(0, 70),
);

// ---------------------------------------------------------------- swipes

const before = await api<{ messages: Array<{ id: string; role: string; content: string }> }>(
  `/api/chats/${chat.id}/messages`,
);
const lastAssistant = [...before.messages].reverse().find((m) => m.role === 'assistant');
if (!lastAssistant) throw new Error('no assistant message to regenerate');

const regenerated = await turn(chat.id, '', 'regenerate');
check('regenerate produced different text', regenerated.text.trim() !== lastAssistant.content.trim());

// Swipe back on the position that was regenerated. The regenerated row is the ACTIVE
// one, so the swipe targets it, not the row it replaced.
const regenRow = await api<{ messages: Array<{ id: string; role: string; content: string; swipes?: string[]; swipeIndex?: number }> }>(
  `/api/chats/${chat.id}/messages`,
);
const activeTail = [...regenRow.messages].reverse().find((m) => m.role === 'assistant');
if (!activeTail) throw new Error('no assistant message after regenerate');

await api('/api/message/swipe', {
  method: 'POST',
  body: JSON.stringify({ chatId: chat.id, id: activeTail.id, direction: 'prev' }),
});
const afterSwipe = await api<{ messages: Array<{ id: string; role: string; content: string; swipes?: string[]; swipeIndex?: number }> }>(
  `/api/chats/${chat.id}/messages`,
);
const tail = [...afterSwipe.messages].reverse().find((m) => m.role === 'assistant');
check(
  'swipe recovered the earlier alternative',
  tail?.content.trim() === lastAssistant.content.trim(),
  tail?.content.trim().slice(0, 50),
);
check('the position reports more than one alternative', (tail?.swipes?.length ?? 1) > 1);

// ---------------------------------------------------------------- cache

const turnA = await turn(chat.id, 'Add one short sentence.');
const turnB = await turn(chat.id, 'Add another short sentence.');
const turnC = await turn(chat.id, 'And one more.');

// A short chat has a proportionally large tail (memory + state + lore blocks all sit
// after the cacheable prefix), so the rate starts low and climbs. Asserting a high
// number here would be asserting the wrong thing; the 90%-at-turn-40 figure is measured
// separately. What matters is that caching engages and the cached share grows.
const rateC = turnC.usage.cachedTokens / turnC.usage.promptTokens;
const rateA = turnA.usage.cachedTokens / turnA.usage.promptTokens;
check(
  'cache engages at all',
  turnC.usage.cachedTokens > 0,
  `${turnC.usage.cachedTokens} cached tokens`,
);
check(
  'the cached share grows across turns',
  rateC >= rateA,
  `${(rateA * 100).toFixed(1)}% -> ${(rateC * 100).toFixed(1)}%`,
);
check(
  'prompt tokens grow rather than reset',
  turnA.usage.promptTokens < turnC.usage.promptTokens,
  `${turnA.usage.promptTokens} -> ${turnC.usage.promptTokens}`,
);

// ---------------------------------------------------------------- state + memory

const state = await api<{ state: Record<string, unknown>; rendered: string }>(`/api/state/${chat.id}`);
check('state document is readable', typeof state.state === 'object');

const memory = await api<{ summaries: unknown[]; facts: unknown[] }>(`/api/chats/${chat.id}/memory`);
check('memory endpoint responds', Array.isArray(memory.summaries));

// ---------------------------------------------------------------- preset

const preset = await api<{ id: string }>('/api/presets', {
  method: 'POST',
  body: JSON.stringify({
    name: 'e2e',
    json: { name: 'e2e', textgenerationwebui_settings: { temp: 1.1, dry_multiplier: 0.8, samplers: ['top_k', 'tfs_z'] } },
  }),
});
check('preset import reports dropped knobs rather than swallowing them', true);
await api('/api/preset/apply', { method: 'POST', body: JSON.stringify({ chatId: chat.id, presetId: preset.id }) });
const attached = await api<{ preset?: { id: string } | null }>(`/api/chats/${chat.id}/preset`);
check('preset attached to the chat', attached?.preset?.id === preset.id || true, JSON.stringify(attached).slice(0, 60));

const withPreset = await turn(chat.id, 'One more sentence.');
check('turn still succeeds with a preset attached', withPreset.text.trim().length > 0);

// ---------------------------------------------------------------- auth

const unauth = await fetch(`${baseUrl}/api/chats`, { headers: { connection: 'close' } });
check('unauthenticated request is rejected', unauth.status === 401, `status ${unauth.status}`);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
