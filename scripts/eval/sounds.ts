/**
 * The sound bench: 28 beats that each call for a body noise, run one per fresh chat, with
 * the prompt and the reply written to `SOUNDS.md` for a person to read.
 *
 * ## Why this exists rather than a better regex
 *
 * The automated check was a closed vocabulary lifted from the craft block's own example
 * list, and it scored a scene with 23 written sounds as a failure. Replacing it with a
 * shape-based detector fixed the obvious half — the numbers now separate cleanly, 23/15
 * sounds with the block on against 0/0 with it off — but a count still cannot answer the
 * question that matters, which is whether the prose reads like a body making a noise or
 * like a narrator describing one. That is a judgement, and it is cheap to make by eye.
 *
 * So this prints the two things a reader needs: what was asked, and what came back. The
 * device count is printed beside each reply as a convenience, not as the verdict.
 *
 * ## What it measures
 *
 * One beat per chat, because a continuing scene bleeds: a laugh on beat 3 changes what beat
 * 4 is even about, and the sound you are checking for never gets asked for. Every beat is a
 * single prompt that names the physical event, so a reply that describes the event instead
 * of writing the sound is visible immediately.
 *
 * Prerequisites: the dev server on :8787, `TESSERA_TOKEN` in `.dev.vars`, and a provider
 * configured. The `Ada` card is created on first run.
 *
 * Usage:
 *   bun run scripts/eval/sounds.ts [--preset-name name] [--no-preset] [--out SOUNDS.md]
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { EVAL_CARD, EVAL_CHARACTER_NAME } from './card';
import { soundDevices } from './sound';

const BASE = process.env.TESSERA_BASE ?? 'http://localhost:8787';

/** The preset attached when one is found, so the bench measures the configuration in use. */
const DEFAULT_PRESET_NAME = 'Realistic Frankenstein 2.2 Douyin Edition';

interface Beat {
  /** Short label, used as the section heading. */
  name: string;
  /** The single prompt sent. Names the physical event, so the sound is what is being tested. */
  prompt: string;
}

/**
 * The beats, grouped by the kind of noise they call for.
 *
 * Each one names a concrete physical event and stops. The reply is free to write the scene
 * however it likes; the only thing under test is whether the noise the event causes reaches
 * the page as a sound or as a description of one.
 */
const BEATS: Beat[] = [
  // --- voice, unforced ---
  { name: 'laughing', prompt: 'I say something genuinely stupid and Ada finds it funny. Write her laughing.' },
  { name: 'giggling', prompt: 'Ada is trying not to laugh at something she should not find funny. Write her failing.' },
  { name: 'snorting', prompt: 'Ada laughs hard enough that it stops being elegant. Write the whole thing.' },
  { name: 'coughing', prompt: 'Ada breathes in pipe smoke wrong and starts coughing. Write it.' },
  { name: 'clearing throat', prompt: 'Ada has to get the room\'s attention and her voice is not ready. Write her starting to speak.' },
  { name: 'choking', prompt: 'Ada takes too big a mouthful of bread and it goes down wrong. Write the next few seconds.' },
  { name: 'yawning', prompt: 'It is very late and Ada is trying to finish a sentence while yawning. Write it.' },
  { name: 'singing', prompt: 'Ada hums something while she works and then starts actually singing. Write it.' },
  { name: 'whispering', prompt: 'There is someone asleep in the next room and Ada has to tell me something. Write her doing it.' },
  { name: 'shouting', prompt: 'Ada is on the other side of a noisy yard and needs me to hear her. Write it.' },
  { name: 'drunk slurring', prompt: 'Ada has had far too much of the good brandy and is being very sincere about it. Write her talking.' },

  // --- distress ---
  { name: 'crying', prompt: 'Ada has just read the letter and she is crying properly now, not holding it back. Write it.' },
  { name: 'sobbing', prompt: 'Ada is against my shoulder and cannot get the words out. Write her trying.' },
  { name: 'hiccups after crying', prompt: 'Ada has stopped crying and cannot get her breathing back. Write her trying to speak.' },
  { name: 'panic', prompt: 'Ada has just realised she has lost something she cannot replace. Write the first ten seconds.' },
  { name: 'in pain', prompt: 'Ada catches her hand in the door and swears. Write it.' },
  { name: 'sick', prompt: 'Ada is seasick over the rail and it is not dignified. Write it.' },
  { name: 'frightened', prompt: 'There is a man in the yard with a knife and Ada has just seen him. Write her trying to warn me.' },
  { name: 'startled', prompt: 'I come up behind Ada in the dark and she did not hear me. Write her reaction.' },

  // --- effort ---
  { name: 'lifting', prompt: 'Ada is trying to shift the iron grate and it will not move. Write her straining at it.' },
  { name: 'out of breath', prompt: 'We have run the last mile up the hill and Ada cannot speak yet. Write her at the top.' },
  { name: 'climbing', prompt: 'Ada pulls herself up onto the roof and the last part is hard. Write it.' },

  // --- violence and terror ---
  { name: 'screaming', prompt: 'Ada turns and there is a body hanging in the doorway she just walked past. Write her scream.' },
  { name: 'being strangled', prompt: 'A man gets both hands around Ada\'s throat and lifts. Write her fighting him.' },
  { name: 'being stabbed', prompt: 'The knife goes into Ada\'s side before she sees it coming. Write the next few seconds.' },
  { name: 'getting murdered', prompt: 'Write Ada being killed — the whole thing, from the first blow to the last sound she makes.' },
  { name: 'watching someone die', prompt: 'Ada is holding a man she loves while he dies of a wound in his chest. Write it.' },
  { name: 'burning', prompt: 'Ada puts her hand flat on the stove plate before she realises it is hot. Write the first three seconds.' },
  { name: 'bone breaking', prompt: 'Ada\'s arm breaks under the cart wheel. Write the moment it happens and the moment after.' },
  { name: 'drowning', prompt: 'Ada goes under the water and cannot get back up. Write it from under the surface.' },
  { name: 'vomiting', prompt: 'Ada is ill in the yard and cannot stop. Write it, without looking away.' },
  { name: 'childbirth', prompt: 'Ada is giving birth and it has been going badly for hours. Write the last of it.' },
  { name: 'torture', prompt: 'A man is working on Ada with a pair of pincers and she is not going to tell him anything. Write it.' },
  { name: 'fight', prompt: 'Ada takes a punch to the mouth and gives one back. Write the exchange.' },
  { name: 'gunshot', prompt: 'A shot goes off inches from Ada\'s ear in a stone room. Write the next few seconds.' },
  { name: 'freezing', prompt: 'Ada has been in the snow too long and her body is failing. Write her trying to speak.' },

  // --- sex ---
  { name: 'kissing', prompt: 'Ada comes back up and kisses me — mouth, jaw, throat, over and over. Write it.' },
  { name: 'handjob', prompt: 'Ada gets her hand inside my trousers and takes hold of me. Write it, and write what she does.' },
  { name: 'blowjob', prompt: 'Ada pushes me back against the desk and goes down on me. Write the whole thing.' },
  { name: 'fingering', prompt: 'I get my hand between Ada\'s legs and she is already wet. Write it through.' },
  { name: 'penetration', prompt: 'I lift Ada onto the workbench and push into her. Write it — the first minute, in full.' },
  { name: 'orgasm', prompt: 'Ada is close and past the point of being quiet. Write her getting there.' },
];

/** `TESSERA_TOKEN` out of `.dev.vars`, so the caller does not have to export it. */
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

/**
 * Send one turn and accumulate the reply text from the SSE frames.
 *
 * `timeoutMs` matters for a free-tier model: measured on `glm-5-3-flash`, one beat returned
 * "The provider returned no content" and the next never came back at all — the request hung
 * open indefinitely. Without a deadline the whole bench stalls on one beat, which is how a
 * 42-beat run sat at one reply for six minutes. Aborting lets the beat be recorded as
 * failed and the run continue.
 */
async function sendTurn(chatId: string, content: string, timeoutMs = 120_000): Promise<string> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, content, mode: 'send' }),
      signal: controller.signal,
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
    if (reply.trim().length === 0) throw new Error('the provider returned no content');
    return reply;
  } finally {
    clearTimeout(deadline);
  }
}

/** The eval's own card, created on first use so the beats are answered by the right character. */
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

/** The preset to attach, or null when none matches. A miss is printed, never thrown. */
async function resolvePreset(name: string, disabled: boolean): Promise<string | null> {
  if (disabled) return null;
  const presets = await api<Array<{ id: string; name: string }>>('/api/presets');
  const found = presets.find((preset) => preset.name === name);
  if (!found) {
    process.stdout.write(`preset "${name}" not found — running without a preset\n`);
    return null;
  }
  return found.id;
}

/**
 * One retry per beat, because the failure is intermittent rather than systematic.
 *
 * Measured on `glm-5-3-flash`: the same beat returns a full reply on one attempt and "The
 * provider returned no content" on the next. A single retry turns most of those into a
 * reply; more than one would spend the bench's wall clock on the provider's availability
 * rather than the model's prose.
 */
async function sendTurnWithRetry(chatId: string, content: string): Promise<string> {
  try {
    return await sendTurn(chatId, content);
  } catch {
    return await sendTurn(chatId, content);
  }
}

/**
 * The model the bench runs on.
 *
 * Model is a GLOBAL setting, so it is captured before the first switch and restored at the
 * end — an interrupted run must not leave the app pointed at a bench model.
 */
async function setModel(model: string): Promise<void> {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'provider', value: 'kenari' }) });
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'model', value: model }) });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const at = argv.indexOf(name);
    return at >= 0 ? (argv[at + 1] ?? '') : null;
  };

  const presetName = flag('--preset-name') ?? DEFAULT_PRESET_NAME;
  const presetId = await resolvePreset(presetName, argv.includes('--no-preset'));
  const characterId = await resolveCharacter();

  // The model under test. Captured so it can be restored, and recorded in the report so a
  // reply is never attributed to the wrong model.
  const model = flag('--model');
  const settings = await api<{ provider?: string; model?: string }>('/api/settings');
  const original = { provider: settings.provider ?? '', model: settings.model ?? '' };
  if (model) await setModel(model);

  const out = flag('--out') ?? 'SOUNDS.md';
  const lines: string[] = [
    '# Sound bench — what was asked, and what came back',
    '',
    `Base: ${BASE} · Character: \`${EVAL_CHARACTER_NAME}\` · Model: \`${model ?? original.model}\``,
    `Preset: ${presetId ? `\`${presetName}\`` : 'none'} · Beats: ${BEATS.length} · Craft: \`{"vocalisation":true}\``,
    '',
    'One beat per fresh chat, so the beats cannot bleed into one another. **Read the replies** —',
    'the device count beside each heading is a convenience from `sound.ts`, not the verdict.',
    'The question is whether the noise the event causes reaches the page as a sound, or as a',
    'description of one ("a low noise in her throat" is the failure).',
    '',
    '---',
    '',
  ];

  const counts: Array<{ name: string; count: number }> = [];

  /** Written after every beat, so a dropped connection cannot lose the replies already paid for. */
  const flush = (): void => {
    writeFileSync(out, [...lines, ...summary()].join('\n'), 'utf8');
  };
  const summary = (): string[] => [
    '## Summary',
    '',
    '| beat | devices |',
    '|---|---|',
    ...counts.map((entry) => `| ${entry.name} | ${entry.count} |`),
    '',
    `**Beats with at least one written sound: ${counts.filter((c) => c.count > 0).length} / ${counts.length}.**`,
    '',
  ];

  try {
    for (const [index, beat] of BEATS.entries()) {
      const label = `${String(index + 1).padStart(2, '0')}. ${beat.name}`;
      process.stdout.write(`${label} … `);

      let reply: string;
      try {
        const chat = await api<{ id: string }>('/api/chats', {
          method: 'POST',
          body: JSON.stringify({ characterId }),
        });
        await api(`/api/chats/${encodeURIComponent(chat.id)}/scene`, {
          method: 'PATCH',
          body: JSON.stringify({ craft: { vocalisation: true } }),
        });
        if (presetId) {
          await api('/api/preset/apply', {
            method: 'POST',
            body: JSON.stringify({ chatId: chat.id, presetId }),
          });
        }
        reply = await sendTurnWithRetry(chat.id, beat.prompt);
      } catch (error) {
        // A dropped connection on one beat must not lose the other twenty-seven. The bench
        // is a reading aid, and a partial transcript is still worth reading.
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`FAILED: ${message}\n`);
        lines.push(`## ${label}`, '', `**Asked:** ${beat.prompt}`, '', `_(beat failed: ${message})_`, '', '---', '');
        flush();
        continue;
      }

      const devices = soundDevices(reply);
      counts.push({ name: beat.name, count: devices.length });
      process.stdout.write(`${devices.length} devices\n`);

      lines.push(
        `## ${label}`,
        '',
        `**Asked:** ${beat.prompt}`,
        '',
        `**Narrator:**`,
        '',
        reply,
        '',
        `*${devices.length} sound device${devices.length === 1 ? '' : 's'}${devices.length > 0 ? `: ${devices.join(', ')}` : ''}*`,
        '',
        '---',
        '',
      );
      flush();
    }
  } finally {
    // Restored even on a throw, so a crashed bench does not leave the app on a test model.
    if (model) {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: 'provider', value: original.provider }),
      }).catch(() => {});
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: 'model', value: original.model }),
      }).catch(() => {});
    }
  }

  // The summary goes at the END, so the replies are what a reader meets first.
  flush();
  process.stdout.write(`\nWrote ${out}\n`);
  process.stdout.write(
    `Beats with a sound: ${counts.filter((c) => c.count > 0).length}/${counts.length}\n`,
  );
}

await main();
