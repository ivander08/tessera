/**
 * Memory + cache soak: a long chat against the real dev server and provider.
 *
 * Plants two specific details early (turns 2 and 40), fills the window with filler until
 * both plants and the mid-run probe's own answer have re-anchored out of the history
 * window, then asks for both details again. The model can only answer from the memory
 * block (recalled message/summary/fact hits), never from context.
 *
 * Also records per-turn prompt/cached token telemetry from the `done` frame, which is the
 * evidence for the cache-levels check: caching engages, the cached prefix never shrinks
 * between window re-anchors, and re-anchors are the only drops.
 *
 * Usage: bun run scripts/eval/memory-soak.ts [turns=120]
 *
 * Prerequisites: dev server on :8787, TESSERA_TOKEN in .dev.vars, kenari key stored.
 * The narrator model, reasoning setting, knobs and contextBudget are changed for the run
 * and restored from the saved values in a finally block.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.TESSERA_BASE ?? 'http://localhost:8787';
const TURNS = Number(process.argv[2] ?? 120) || 120;

const devVars = readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8');
const TOKEN = /TESSERA_TOKEN=(\S+)/.exec(devVars)![1];

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  connection: 'close',
};

interface Usage {
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
}

interface TurnRecord {
  turn: number;
  kind: 'greeting-response' | 'plant' | 'filler' | 'probe-mid' | 'probe-final';
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reply: string;
}

const PLANT_1 =
  'Before anything else, a fact about me: my old mentor was Elias Marlowe. He kept a brass astrolabe with seven arms, and he called it the Perihelion. Remember that.';
const PLANT_2 =
  'Another fact: I keep my finished maps in a cedar case lined with violet silk. The case has a broken clasp on the left side.';
const PROBE = 'What did my mentor Marlowe call his brass astrolabe, and where do I keep my finished maps? Answer in one short sentence.';

/** One-line scene prompts, varied so the transcript is not one repeated string. */
function fillerPrompt(i: number): string {
  const shelves = ['east', 'west', 'flooded', 'iron', 'upper', 'collapsed', 'hidden', 'reading'];
  const things = [
    'logbook', 'lantern', 'catalogue', 'drying rack', 'ink pot', 'ladder', 'index drawer',
    'paper press', 'map weight', 'quill jar', 'lamp oil', 'sea chart', 'desalination bath',
  ];
  const verbs = ['Describe', 'Inspect', 'Tidy', 'Read from', 'Point to', 'Move', 'Open', 'Light'];
  return `${verbs[i % verbs.length]} the ${things[i % things.length]} on the ${shelves[(i * 3) % shelves.length]} level. One or two sentences.`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** One turn over SSE; throws on an error frame, returns reply text and usage. */
async function turn(chatId: string, content: string, mode = 'send'): Promise<{ text: string; usage: Usage }> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ chatId, content, mode }),
  });
  const raw = await res.text();
  let text = '';
  const usage: Usage = { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0 };
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
    if (frame.type === 'done' && frame.usage) {
      usage.promptTokens = frame.usage.promptTokens ?? 0;
      usage.cachedTokens = frame.usage.cachedTokens ?? 0;
      usage.cacheWriteTokens = frame.usage.cacheWriteTokens ?? 0;
      usage.completionTokens = frame.usage.completionTokens ?? 0;
    }
    if (frame.type === 'error') throw new Error(frame.message ?? 'turn error');
  }
  return { text, usage };
}

async function turnWithRetry(chatId: string, content: string, mode = 'send'): Promise<{ text: string; usage: Usage }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await turn(chatId, content, mode);
    } catch (error) {
      if (attempt >= 3) throw error;
      console.log(`retry ${attempt} after: ${error instanceof Error ? error.message : String(error)}`);
      await delay(2000 * attempt);
    }
  }
}

const settingsBefore = await api<Record<string, string>>('/api/settings');
try {
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        model: 'gpt-oss-120b',
        contextBudget: '6000',
      },
    }),
  });

  const persona = await api<{ id: string }>('/api/personas', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ivan Soak', description: 'A wandering cartographer with a bad knee.' }),
  });
  const card = await api<{ id: string }>('/api/characters', {
    method: 'POST',
    body: JSON.stringify({
      card: {
        name: 'Vesper',
        description: 'Vesper keeps a drowned-library archive below the tide line. She catalogues whatever the sea gives back.',
        personality: 'Dry, precise, quietly fond of order.',
        scenario: 'The flooded archive of Silt Harbour, lit by storm lanterns.',
        firstMes: '*Vesper stamps a wet ledger shut.* You are punctual, for once.',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        creatorNotes: '',
        tags: [],
        sourceFormat: 'ccv2',
      },
    }),
  });
  const chat = await api<{ id: string }>('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ characterId: card.id, personaId: persona.id }),
  });
  console.log(`chat ${chat.id}`);

  const records: TurnRecord[] = [];
  const pushRecord = (n: number, kind: TurnRecord['kind'], r: { text: string; usage: Usage }): void => {
    records.push({ turn: n, kind, ...r.usage, reply: r.text.trim().slice(0, 240) });
    console.log(
      `turn ${String(n).padStart(3)} ${kind.padEnd(18)} prompt=${String(r.usage.promptTokens).padStart(5)} cached=${String(r.usage.cachedTokens).padStart(5)} write=${String(r.usage.cacheWriteTokens).padStart(4)}`,
    );
  };

  let n = 0;
  pushRecord(++n, 'greeting-response', await turnWithRetry(chat.id, '*I hang my oilcoat on the peg.* Evening, Vesper.'));
  pushRecord(++n, 'plant', await turnWithRetry(chat.id, PLANT_1));

  const midProbeTurn = 15;
  const plant2Turn = 40;
  let midAnswer = '';
  for (; n < TURNS; ) {
    n++;
    if (n === midProbeTurn) {
      const r = await turnWithRetry(chat.id, 'What did my mentor call his brass astrolabe? One short sentence.');
      midAnswer = r.text.trim();
      pushRecord(n, 'probe-mid', r);
    } else if (n === plant2Turn) {
      pushRecord(n, 'plant', await turnWithRetry(chat.id, PLANT_2));
    } else if (n === TURNS) {
      const r = await turnWithRetry(chat.id, PROBE);
      pushRecord(n, 'probe-final', r);
      writeFileSync('scripts/eval/soak-last-run.json',
        JSON.stringify({ chatId: chat.id, records, midAnswer, finalAnswer: r.text.trim() }, null, 2));
    } else {
      pushRecord(n, 'filler', await turnWithRetry(chat.id, fillerPrompt(n)));
    }
  }

  const memory = await api<{ summaries: Array<{ content: string }>; facts: Array<{ text: string }> }>(
    `/api/chats/${chat.id}/memory`,
  );
  const summaryHits = memory.summaries.filter((s) => /Perihelion|Marlowe|cedar|violet/i.test(s.content));
  const factHits = memory.facts.filter((f) => /Perihelion|Marlowe|cedar|violet/i.test(f.text));
  console.log(`\nsummaries=${memory.summaries.length} summaryHits=${summaryHits.length} facts=${memory.facts.length} factHits=${factHits.length}`);
  for (const s of summaryHits) console.log(`  [summary] ${s.content.slice(0, 200)}`);
  for (const f of factHits) console.log(`  [fact] ${f.text.slice(0, 200)}`);

  // Cache analysis between re-anchors: the cached prefix must never shrink except where
  // the history window re-anchored (prompt composition jump).
  const reanchors: Array<{ afterTurn: number; cached: number; prevCached: number; prompt: number; prevPrompt: number }> = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const cur = records[i];
    if (cur.cachedTokens < prev.cachedTokens - 64 && cur.promptTokens > prev.promptTokens) {
      reanchors.push({
        afterTurn: cur.turn,
        cached: cur.cachedTokens,
        prevCached: prev.cachedTokens,
        prompt: cur.promptTokens,
        prevPrompt: prev.promptTokens,
      });
    }
  }
  console.log(`\ncache drops (suspected re-anchors): ${reanchors.length}`);
  for (const r of reanchors) {
    console.log(`  after turn ${r.afterTurn}: cached ${r.prevCached} -> ${r.cached}, prompt ${r.prevPrompt} -> ${r.prompt}`);
  }
  const warm = records.slice(2);
  const meanCachedShare = warm.reduce((acc, r) => acc + r.cachedTokens / Math.max(1, r.promptTokens), 0) / warm.length;
  console.log(`mean cached share after warmup: ${(meanCachedShare * 100).toFixed(1)}%`);
  console.log(`final prompt: ${records[records.length - 1].promptTokens} tokens`);
} finally {
  const restore: Record<string, string> = {};
  for (const key of ['model', 'reasoning', 'knobs', 'contextBudget']) {
    if (settingsBefore[key] !== undefined) restore[key] = settingsBefore[key];
  }
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: restore }) });
  console.log('settings restored');
}
