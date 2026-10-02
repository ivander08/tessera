/**
 * Capture the README screenshots from a running Worker.
 *
 * Usage: bun run scripts/capture-screens.ts <baseUrl> <token> [outDir]
 *
 *   bun run scripts/capture-screens.ts http://127.0.0.1:8787 "$(sed -n 's/^TESSERA_TOKEN=//p' .dev.vars)"
 *
 * Deliberately NOT part of `bun test` or CI: it needs a running Worker, a database with
 * real content in it, and (for the Forge shot) a configured cheap model. It is a tool,
 * not a check.
 *
 * Chrome is driven over the DevTools protocol rather than through a browser-automation
 * dependency. The whole app is one fetch and one WebSocket, and a README script that
 * drags Playwright's 300 MB into `node_modules` would cost more than it saves.
 *
 * The capture is 2x and viewport-only. If a surface comes back over the size budget the
 * script retries that one at 1.5x and says so — a 200 KB ceiling is what keeps the README
 * quick to load on a phone, which is where most people will first see it.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [baseUrl, token, outDir = 'docs/screens'] = process.argv.slice(2);
if (!baseUrl || !token) {
  console.error('usage: bun run scripts/capture-screens.ts <baseUrl> <token> [outDir]');
  process.exit(1);
}

/**
 * The size ceiling for one PNG, in bytes. See the header.
 *
 * 200 KB is roughly what a screenshot can be and still load with the page on a phone.
 * A dense serif transcript is the worst case — flat colour compresses well, but
 * anti-aliased text is high-frequency noise — so the hero shot needs a smaller scale
 * than an empty panel does.
 */
const MAX_BYTES = 200 * 1024;

/**
 * Capture scales, tried in order until one fits.
 *
 * The plan said "2x, and 1.5x if it is over budget", which is not enough resolution of
 * the ladder: a transcript lands at 219 KB at 1.5x and 177 KB at 1.25x, so stopping at
 * 1.5x would have shipped the hero shot at 1x and lost half its detail. 1.25x is still
 * sharp on a HiDPI display.
 */
const SCALES = [2, 1.5, 1.25, 1];

/**
 * How many scenes to score at once.
 *
 * Every scene costs three requests, so a deployment with a few hundred of them is a few
 * hundred round trips. Eight at a time keeps that a second or two without hammering a
 * local Worker, which serves one request at a time anyway.
 */
const PROBE_CONCURRENCY = 8;

/**
 * How long a scene has to be before its memory and state panels are worth photographing.
 *
 * Twenty turns is a scene someone has actually written in, which is what makes the two
 * panels coherent. Below it, a scene can still carry a large state block — a fixture that
 * wrote several variants into one row does — and that photographs as a panel disagreeing
 * with itself.
 */
const MIN_SCENE_MESSAGES = 20;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Users/Ivander/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((path): path is string => Boolean(path));

const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!chromePath) {
  console.error('no Chrome found; set CHROME_PATH to a chromium binary');
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers: auth });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- pick the subjects

interface ChatSummary {
  id: string;
  title: string;
  character_id: string | null;
  character_name: string | null;
  character_avatar: string | null;
  updated_at: number;
}

/** One scene's scores, as the surface that would photograph it sees them. */
interface SceneScore {
  chat: ChatSummary;
  /** Transcript length, with a scene longer than the server's window counted as longer. */
  messages: number;
  /** Summaries plus facts — what the memory panel renders. */
  memory: number;
  /** Serialized world state length — what the state panel renders. */
  state: number;
}

/**
 * Choose which scene each shot uses.
 *
 * The reader's own database is the best source of screenshots: real prose, real state,
 * real memory, and nothing to invent. Each surface therefore asks for the chat that
 * actually exercises it rather than reusing one scene everywhere — a hero shot wants a
 * long transcript, the memory panel wants summaries and facts, the state panel wants a
 * filled-in world.
 *
 * A scene with nothing to show on a surface is worse than a smaller one that has
 * something, so each score is what the surface renders rather than how recently the
 * reader touched it.
 */
async function pickSubjects(): Promise<{
  hero: ChatSummary;
  memory: ChatSummary;
  state: ChatSummary;
}> {
  const chats = await api<ChatSummary[]>('/api/chats');
  if (chats.length === 0) {
    throw new Error('no chats on this deployment — seed one first, then re-run');
  }

  // A scene that fails one of its three probes is scored on the ones that answered rather
  // than dropped: one 500 in a scene's memory should not remove it from the hero race.
  const probe = <T>(path: string) => api<T>(path).catch(() => null);

  const scores: SceneScore[] = [];
  for (let index = 0; index < chats.length; index += PROBE_CONCURRENCY) {
    const slice = chats.slice(index, index + PROBE_CONCURRENCY);
    scores.push(
      ...(await Promise.all(
        slice.map(async (chat) => {
          const id = encodeURIComponent(chat.id);
          const [messages, memory, world] = await Promise.all([
            // `limit=200` is the server's window ceiling.
            probe<{ messages?: unknown[]; hasMore?: boolean }>(`/api/chats/${id}/messages?limit=200`),
            probe<{ summaries?: unknown[]; facts?: unknown[] }>(`/api/chats/${id}/memory`),
            probe<{ state?: Record<string, unknown> }>(`/api/state/${id}`),
          ]);
          // A scene longer than the window comes back as exactly the window with
          // `hasMore` set, so that flag is the only thing distinguishing "200 messages"
          // from "six hundred" — and the hero shot wants the long one.
          const length = (messages?.messages?.length ?? 0) + (messages?.hasMore ? 1000 : 0);
          return {
            chat,
            messages: length,
            memory: (memory?.summaries?.length ?? 0) + (memory?.facts?.length ?? 0),
            state: JSON.stringify(world?.state ?? {}).length,
          };
        }),
      )),
    );
  }

  const best = <K extends 'messages' | 'memory' | 'state'>(
    key: K,
    pool: SceneScore[] = scores,
  ) => pool.reduce((winner, row) => (row[key] > winner[key] ? row : winner));

  // The memory and state panels are read against the scene they belong to, so they are
  // photographed from a scene that was actually written in. A short fixture can carry a
  // large state block assembled from several variants, which photographs as a panel whose
  // fields disagree with each other — the honest shot is a real conversation.
  const deep = scores.filter((row) => row.messages >= MIN_SCENE_MESSAGES);
  const forPanels = deep.length > 0 ? deep : scores;

  // A hero shot with a portrait in it says more than one without, so a scene whose
  // character has an avatar wins over a longer one that falls back to a letter. The
  // second pass is the plain longest, for a deployment with no avatars at all.
  const withAvatar = scores.filter((row) => row.chat.character_avatar);
  const hero = best('messages', withAvatar.length > 0 ? withAvatar : scores).chat;

  // The state panel opens from inside a scene, so it is shot from one the reader would
  // recognise as theirs — a portrait on it, and a real conversation behind it. The
  // largest state block among fixtures is not that.
  const forState = forPanels.filter((row) => row.chat.character_avatar);

  return {
    hero,
    memory: best('memory', forPanels).chat,
    state: best('state', forState.length > 0 ? forState : forPanels).chat,
  };
}

// ---------------------------------------------------------------- CDP

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** One page target, driven over the DevTools protocol. */
class Page {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const handler of this.listeners.get(message.method) ?? []) {
          handler(message.params ?? {});
        }
      }
    });
  }

  static async attach(webSocketUrl: string): Promise<Page> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
    });
    return new Page(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  /** Runs an expression in the page and returns its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    // CDP's own envelope; narrowed rather than asserted, so a failed evaluation surfaces
    // as `undefined` at the call site instead of a silent lie about the shape.
    const envelope = result.result;
    if (envelope && typeof envelope === 'object' && 'value' in envelope) {
      return envelope.value as T;
    }
    return undefined as T;
  }

  /** Waits for an expression to become truthy, or gives up. */
  async waitFor(expression: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(200);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new Error(`chrome did not open its devtools port within ${timeoutMs}ms`);
}

interface Shot {
  file: string;
  url: string;
  /** Viewport in CSS pixels. */
  width: number;
  height: number;
  mobile?: boolean;
  /** Run before the screenshot: open a panel, dismiss a banner, wait for a render. */
  prepare?: (page: Page) => Promise<void>;
  caption: string;
}

async function capture(page: Page, shot: Shot, scale: number): Promise<Uint8Array> {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: shot.width,
    height: shot.height,
    deviceScaleFactor: scale,
    mobile: shot.mobile ?? false,
  });
  const loaded = new Promise<void>((resolve) => {
    const handler = () => resolve();
    page.on('Page.loadEventFired', handler);
    setTimeout(resolve, 15_000);
  });
  await page.send('Page.navigate', { url: shot.url });
  await loaded;
  // The transcript, the portraits and the theme are all applied after paint.
  await Bun.sleep(2500);
  if (shot.prepare) await shot.prepare(page);

  // The scale has to be confirmed rather than assumed. A browser-level device-scale flag
  // overrides the per-page emulation, and the result is a 1x shot written into a `@2x`
  // report — which is exactly the sort of thing that goes unnoticed until someone
  // complains the README looks soft.
  const measured = await page.send('Runtime.evaluate', {
    expression: '`${innerWidth}x${innerHeight}@${devicePixelRatio}`',
    returnByValue: true,
  });
  // `result` is CDP's own envelope and the compiler has no schema for it, so the value is
  // narrowed rather than asserted — a missing field should fail the capture, not produce
  // an empty string that compares unequal for the wrong reason.
  const envelope = measured.result;
  const actual =
    envelope && typeof envelope === 'object' && 'value' in envelope ? String(envelope.value) : '';
  const expected = `${shot.width}x${shot.height}@${scale}`;
  if (actual !== expected) {
    throw new Error(`${shot.file}: viewport is ${actual}, expected ${expected}`);
  }

  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  return Buffer.from(String(result.data), 'base64');
}

// ---------------------------------------------------------------- run

const subjects = await pickSubjects();
console.log(`hero:   ${subjects.hero.title} (${subjects.hero.id})`);
console.log(`memory: ${subjects.memory.title} (${subjects.memory.id})`);
console.log(`state:  ${subjects.state.title} (${subjects.state.id})`);

const chat = (id: string) => `${baseUrl}/chat/${encodeURIComponent(id)}`;

const shots: Shot[] = [
  {
    file: 'chat.png',
    url: chat(subjects.hero.id),
    width: 1280,
    height: 900,
    caption: 'A scene: the transcript, the world-state strip above it, and the composer.',
  },
  {
    file: 'scenes.png',
    url: `${baseUrl}/`,
    width: 1280,
    height: 900,
    caption: 'The shelf. Every scene is a plate with its character’s portrait and its last line.',
  },
  {
    file: 'characters.png',
    url: `${baseUrl}/characters`,
    width: 1280,
    height: 900,
    caption: 'The character library, with the token cost of each card.',
  },
  {
    file: 'forge.png',
    url: `${baseUrl}/forge`,
    width: 1280,
    height: 900,
    // The interview is the screen, so the shot drives it. An empty Forge screen shows a
    // textarea and nothing else; one question in shows what the tool actually is. This
    // needs a configured cheap model — the script says so rather than failing quietly,
    // and the opening screen is what lands if the call does not come back.
    prepare: async (page) => {
      const started = await page
        .evaluate<boolean>(`(() => {
          const box = document.querySelector('.consult-transcript textarea');
          if (!box) return false;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value',
          ).set;
          setter.call(box, 'A retired cartographer who refuses to admit the maps are wrong.');
          box.dispatchEvent(new Event('input', { bubbles: true }));
          const button = [...document.querySelectorAll('button')]
            .find((b) => b.textContent.includes('Start the interview'));
          if (!button) return false;
          button.click();
          return true;
        })()`)
        .catch(() => false);
      if (!started) {
        console.warn('forge: could not start the interview — capturing the opening screen');
        return;
      }
      // The first question, with its options, is the state worth photographing. If the
      // model is unreachable this times out and the opening screen is captured instead.
      try {
        await page.waitFor("document.querySelector('.consult-options')", 90_000);
        await Bun.sleep(600);
      } catch {
        console.warn('forge: the consultant did not answer — capturing the opening screen');
      }
    },
    caption: 'The consultant mid-interview: it asks one question at a time and offers answers.',
  },
  {
    file: 'memory.png',
    url: `${baseUrl}/chat/${encodeURIComponent(subjects.memory.id)}/memory`,
    width: 1280,
    height: 900,
    caption: 'Memory: scene summaries and the facts the narrator has committed to.',
  },
  {
    file: 'state.png',
    url: `${baseUrl}/chat/${encodeURIComponent(subjects.state.id)}/state`,
    width: 1280,
    height: 900,
    caption: 'World state as the narrator believes it: place, time, who is present, what is carried.',
  },
  {
    file: 'mobile.png',
    url: chat(subjects.hero.id),
    width: 390,
    height: 780,
    mobile: true,
    caption: 'The same scene on a phone.',
  },
];

const port = 9333 + Math.floor(Math.random() * 500);
const profile = join(process.cwd(), '.wrangler', 'capture-profile');
await rm(profile, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    // No `--force-device-scale-factor`: it sets the browser-level DPR and fights the
    // per-page `Emulation.setDeviceMetricsOverride` that actually chooses the capture
    // scale, which silently produced 1x shots labelled 2x.
    '--disable-lcd-text',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  await waitForPort(port);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('chrome exposed no page target');

  const page = await Page.attach(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // The token is written before any app script runs, so the app never renders `/setup`.
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('tessera.token', ${JSON.stringify(token)}); } catch {}`,
  });

  const report: Array<{ file: string; bytes: number; scale: number }> = [];
  for (const shot of shots) {
    // `Uint8Array` rather than `Buffer`: `captureScreenshot` returns base64, and the
    // decoder's buffer type is not the same `ArrayBuffer` `Buffer` is parameterised by.
    let bytes: Uint8Array = new Uint8Array(0);
    let scale = SCALES[SCALES.length - 1];
    for (const candidate of SCALES) {
      bytes = await capture(page, shot, candidate);
      scale = candidate;
      if (bytes.byteLength <= MAX_BYTES) break;
    }
    await writeFile(join(outDir, shot.file), bytes);
    report.push({ file: shot.file, bytes: bytes.byteLength, scale });
    const flag = bytes.byteLength > MAX_BYTES ? '  OVER BUDGET' : '';
    console.log(
      `${shot.file.padEnd(16)} ${(bytes.byteLength / 1024).toFixed(0).padStart(4)} KB  @${scale}x${flag}`,
    );
  }

  page.close();

  const over = report.filter((row) => row.bytes > MAX_BYTES);
  console.log(
    over.length === 0
      ? `\nall ${report.length} shots under ${MAX_BYTES / 1024} KB`
      : `\n${over.length} shot(s) still over ${MAX_BYTES / 1024} KB: ${over.map((r) => r.file).join(', ')}`,
  );
} finally {
  chrome.kill();
}
