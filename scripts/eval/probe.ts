/**
 * A fast A/B harness for the craft prompt blocks.
 *
 * The full eval runs 28 scenarios x 4 turns per model and takes ~15 minutes. Iterating on
 * a prompt needs a much tighter loop: one scenario, a handful of turns, and the raw prose
 * printed so the block can be judged by reading it rather than by a regex count.
 *
 * Usage:
 *   bun run scripts/eval/probe.ts --block vocalisation --text path/to/candidate.txt
 *
 * `--text` supplies a candidate block body. It is injected through the chat's scene setup
 * the same way the app does — so this measures the real path, not a simulation — by
 * PATCHing the craft toggle and writing the candidate into the global author's note, which
 * lands in the prompt TAIL where the vocalisation block now lives.
 *
 * Prints the replies and a sound count, so a change is judged on what it produced.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { EVAL_CARD, EVAL_CHARACTER_NAME } from './card';

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

/**
 * The probe's character: the eval's own `Ada` card, created on first use.
 *
 * This used to be `characters[0]` — Seed Probe in the live DB, a lighthouse-keeper card
 * whose `nickname` is Wren — so every beat written about Ada was answered by a different
 * character. A category probe measured that collision rather than the category. Shared
 * with `run.ts`; see `./card`.
 */
async function resolveCharacter(): Promise<string> {
  const characters = await api<Array<{ id: string; name: string }>>('/api/characters');
  const existing = characters.find((character) => character.name === EVAL_CHARACTER_NAME);
  if (existing) return existing.id;
  const created = await api<{ id: string }>('/api/characters', {
    method: 'POST',
    body: JSON.stringify({ card: EVAL_CARD }),
  });
  return created.id;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${TOKEN}`);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function sendTurn(chatId: string, content: string): Promise<string> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, content, mode: 'send' }),
  });
  if (!res.ok || !res.body) throw new Error(`chat -> ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const parsed = JSON.parse(line.slice(5).trim()) as
        | { type: 'delta'; text: string }
        | { type: 'done' }
        | { type: 'error'; message: string };
      if (parsed.type === 'delta') reply += parsed.text;
      else if (parsed.type === 'error') throw new Error(parsed.message);
    }
  }
  return reply;
}

/** Every candidate sound device, counted so a change is visible as a number too. */
function soundStats(text: string): Record<string, number> {
  const count = (re: RegExp): number => (text.match(re) ?? []).length;
  return {
    // A break in a word: "T-The", "Th-there", "W-What". The repeated prefix is the signal,
    // which is why this is a backreference and not just "any hyphenated word".
    stutter: count(/\b([A-Za-z]{1,3})-\1[A-Za-z]/gi),
    // A vowel stretched: "Haaaaa", "Nooo", "Bruuuuuuh". Three or more of the same letter.
    elongation: count(/([A-Za-z])\1\1/gi),
    interjection: count(
      /\b(Nngh|Nnn|Ngh|Haa+|Haaa+|Ah+|A-ah|Mmh|Mmm+|Mh|Nn|Tsk|Hah|Heh|Pfft|Hmph|Ugh|Eep|Oi|Grah|Khh|Fff|Hnn|Hnnn|Glk)\b/gi,
    ),
    caps: count(/\b[A-Z]{2,}\b/g),
    multiPunct: count(/[!?]{2,}|!\?|…{1,}|\.{3,}/g),
    ellipsis: count(/\.{3,}|…/g),
    emDash: count(/[A-Za-z]—/g),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const at = argv.indexOf(name);
    return at >= 0 ? (argv[at + 1] ?? '') : null;
  };

  const blockText = flag('--text') ? readFileSync(flag('--text')!, 'utf8') : '';
  const craft: Record<string, unknown> = {};
  const craftFlag = flag('--craft');
  if (craftFlag) for (const pair of craftFlag.split(',')) {
    const [k, v] = pair.split('=');
    craft[k] = v !== 'false';
  }

  const turns = (flag('--turns') ?? '').split('|').filter(Boolean);
  const turnsFile = flag('--turns-file');
  // A category file is one beat per line, `name: prompt`. The name is only a label for the
  // transcript; the prompt is what is sent.
  const fromFile = turnsFile
    ? readFileSync(turnsFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('---'))
        .map((line) => line.replace(/^[a-z-]+:\s*/i, ''))
    : [];
  const defaultTurns = [
    'Ada and I have been circling each other for weeks. Tonight she shuts the studio door and comes at me without a word.',
    'I lift her onto the workbench and she pulls me in by the collar. The tools go off the edge onto the floor.',
    'Write the scene through — her body against mine, what she does, what she says. Explicit, and let the sounds the scene calls for be on the page.',
    'Continue to the end.',
  ];
  const script = fromFile.length > 0 ? fromFile : turns.length > 0 ? turns : defaultTurns;

  const repeat = Number(flag('--repeat') ?? '1') || 1;
  // `--each` opens a fresh chat for every line. Category probes need that: run as one
  // continuing scene, the beats bleed into each other and a category that fired on line 3
  // changes what line 4 is even about.
  const each = argv.includes('--each');
  const runs: Array<Record<string, number>> = [];

  // The candidate block goes in through the author's note, which the prompt builder places
  // in the TAIL — the same position the real vocalisation block now occupies. Written once,
  // before the runs, so every run sees the same prompt.
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ key: 'authorsNote', value: blockText }),
  });

  if (each) {
    const characterId = await resolveCharacter();
    let all = '';
    for (const [index, turn] of script.entries()) {
      const chat = await api<{ id: string }>('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ characterId }),
      });
      if (Object.keys(craft).length > 0) {
        await api(`/api/chats/${encodeURIComponent(chat.id)}/scene`, {
          method: 'PATCH',
          body: JSON.stringify({ craft }),
        });
      }
      const reply = await sendTurn(chat.id, turn);
      all += `\n=== ${index + 1}. ${turn.slice(0, 60)} ===\n${reply}\n`;
      process.stdout.write(`\n=== ${index + 1}. ${turn.slice(0, 60)} ===\n${reply}\n`);
    }
    const stats = soundStats(all);
    process.stdout.write(`\ntotal devices: ${Object.values(stats).reduce((a, b) => a + b, 0)}\n`);
    process.stdout.write(`stats: ${JSON.stringify(stats)}\n`);
    const outPath = flag('--out');
    if (outPath) writeFileSync(outPath, all, 'utf8');
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'authorsNote', value: '' }) });
    return;
  }

  const characterId = await resolveCharacter();
  for (let run = 0; run < repeat; run += 1) {
    const chat = await api<{ id: string }>('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ characterId }),
    });

    if (Object.keys(craft).length > 0) {
      await api(`/api/chats/${encodeURIComponent(chat.id)}/scene`, {
        method: 'PATCH',
        body: JSON.stringify({ craft }),
      });
    }

    let all = '';
    for (const [index, turn] of script.entries()) {
      const reply = await sendTurn(chat.id, turn);
      all += `${reply}\n`;
      if (repeat === 1) process.stdout.write(`\n=== turn ${index + 1} ===\n${reply}\n`);
    }
    runs.push(soundStats(all));

    const outPath = flag('--out');
    if (outPath) {
      const name = repeat === 1 ? outPath : outPath.replace(/\.txt$/, `.${run + 1}.txt`);
      writeFileSync(name, all, 'utf8');
    }
  }

  // Aggregated across runs: a single run swings widely, so the mean is the number a
  // prompt change is judged on.
  const keys = Object.keys(runs[0]);
  const mean = Object.fromEntries(
    keys.map((key) => [
      key,
      Number((runs.reduce((sum, run) => sum + run[key], 0) / runs.length).toFixed(1)),
    ]),
  );
  const totals = runs.map((run) => Object.values(run).reduce((a, b) => a + b, 0));
  process.stdout.write(`\nper-run totals: ${totals.join(', ')}\n`);
  process.stdout.write(`mean devices: ${(totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1)}\n`);
  process.stdout.write(`mean stats: ${JSON.stringify(mean)}\n`);

  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ key: 'authorsNote', value: '' }),
  });
}

await main();
