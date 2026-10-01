/**
 * Repro: a turn stopped before any reply arrives leaves the chat stuck.
 *
 * The reader sends a message, presses Stop before the provider produces any text, and is
 * then unable to Continue: the button is present but does nothing.
 *
 * This drives the real HTTP API the browser drives, so it exercises the same path the
 * abort takes — including the part that a unit test cannot reach, which is what the
 * Worker does when the client disconnects mid-stream.
 *
 *   bun run scripts/debug/repro-stuck-turn.ts
 *
 * Prints the tail row's role after the abort, then the result of a continue against it.
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.TESSERA_BASE ?? 'http://localhost:8787';

function loadToken(): string {
  const raw = readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*TESSERA_TOKEN\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('TESSERA_TOKEN not found in .dev.vars');
}

const TOKEN = loadToken();

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${TOKEN}`);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Row {
  id: string;
  role: string;
  content: string;
  active: number;
  parent_id: string | null;
}

async function main(): Promise<void> {
  const characters = await api<Array<{ id: string }>>('/api/characters');
  if (characters.length === 0) throw new Error('no characters');
  const chat = await api<{ id: string }>('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ characterId: characters[0].id }),
  });
  console.log(`chat ${chat.id}`);

  // Send, then abort before the provider has produced anything — exactly what pressing
  // Stop in the first second does.
  const controller = new AbortController();
  const sendRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: chat.id, content: 'Fast forward a scene where they had sex.', mode: 'send' }),
    signal: controller.signal,
  });
  console.log(`send -> ${sendRes.status}`);

  // Read one chunk at most, then abort — the reader stopped before the reply came.
  const reader = sendRes.body?.getReader();
  if (reader) {
    const timeout = Promise.withResolvers<void>();
    setTimeout(() => timeout.resolve(), 150);
    await Promise.race([reader.read(), timeout.promise]);
  }
  controller.abort();
  console.log('aborted');

  // Give the Worker a moment to run (or not run) its cleanup.
  const settle = Promise.withResolvers<void>();
  setTimeout(() => settle.resolve(), 15000);
  await settle.promise;

  const transcript = await api<{ messages: Row[] }>(`/api/chats/${chat.id}/messages`);
  console.log('\n--- transcript ---');
  for (const row of transcript.messages) {
    console.log(`  ${row.role.padEnd(9)} active=${row.active} ${JSON.stringify(row.content.slice(0, 50))}`);
  }

  const tail = transcript.messages[transcript.messages.length - 1];
  console.log(`\ntail role = ${tail?.role ?? '(none)'}`);

  if (!tail) {
    console.log('VERDICT: no tail');
    return;
  }

  // What the Continue button does: an empty send carrying the tail's id.
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: chat.id, content: '', mode: 'continue', targetId: tail.id }),
  });
  const text = await res.text();
  const errorFrame = text.split('\n\n').find((frame) => frame.includes('"type":"error"'));
  const deltaFrames = text.split('\n\n').filter((frame) => frame.includes('"type":"delta"')).length;

  console.log(`continue -> ${res.status}; delta frames: ${deltaFrames}`);
  if (errorFrame) console.log(`  error frame: ${errorFrame.replace(/^data: /, '').trim()}`);

  const after = await api<{ messages: Row[] }>(`/api/chats/${chat.id}/messages`);
  console.log('\n--- transcript after continue ---');
  for (const row of after.messages) {
    console.log(`  ${row.role.padEnd(9)} ${JSON.stringify(row.content.slice(0, 60))}`);
  }
  const users = after.messages.filter((row) => row.role === 'user');
  const dupes = users.length !== new Set(users.map((r) => r.content)).size;
  console.log(`\nuser rows: ${users.length}, duplicate text: ${dupes}`);

  const verdict =
    deltaFrames > 0 && !dupes
      ? 'GREEN: continue produced a reply, no duplicate user row'
      : 'RED: continue failed or duplicated the reader\'s message';
  console.log(`\nVERDICT: ${verdict}`);
}

await main();
