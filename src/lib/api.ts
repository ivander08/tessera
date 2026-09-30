import { parseSse } from './sse';

const TOKEN_KEY = 'tessera.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * The Worker origin, when the app is NOT served by the Worker itself.
 *
 * In a browser tab the SPA is served by the Worker, so a relative `/api/...` is
 * already correct. In the Capacitor and Tauri shells the SPA is served from the
 * shell's own local origin (`https://localhost`, `tauri://localhost`), where a
 * relative path resolves to a server that does not exist. The shells therefore set
 * `VITE_API_BASE` at build time, and the Worker's CORS allowlist covers those origins.
 *
 * Read from `import.meta.env` so a plain `vite build` (browser) leaves it empty and
 * every existing relative call keeps working unchanged.
 */
const API_BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ?? '';

/** Exposed so the UI can say where it is talking to when that is not obvious. */
export function apiOrigin(): string {
  return API_BASE.length > 0 ? API_BASE : window.location.origin;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
  }
}

/** Thrown when the Worker is unreachable at all — a different fix from a 401. */
export class OfflineError extends Error {
  constructor(cause: string) {
    super(cause);
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  let res: Response;
  try {
    // The webview's own fetch, never a shell's patched one: Tauri's plugin-http buffers
    // the response body and Capacitor's CapacitorHttp does the same, either of which
    // would turn a streamed reply into one lump at the end.
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (error) {
    throw new OfflineError(error instanceof Error ? error.message : String(error));
  }

  if (res.status === 401) throw new UnauthorizedError();
  return res;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const message = typeof record?.error === 'string' ? record.error : `${res.status} ${path}`;
    throw new Error(message);
  }
  return parsed as T;
}

export type ChatFrame =
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; usage: NormalizedUsage; costUsd: number | null }
  | { type: 'error'; message: string; code: string };

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

/**
 * Streams a turn. Frames are the Worker's normalized protocol; the client never
 * sees a provider quirk.
 */
/** The four ways a turn can be produced. See `worker/src/turn.ts`. */
export type TurnMode = 'send' | 'regenerate' | 'impersonate' | 'continue';

export async function streamChat(
  chatId: string,
  content: string,
  onFrame: (frame: ChatFrame) => void,
  options: { mode?: TurnMode; signal?: AbortSignal; targetId?: string | null } = {},
): Promise<void> {
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      chatId,
      content,
      mode: options.mode ?? 'send',
      // Which message a `regenerate` or `continue` acts on. The server cannot infer it:
      // after a stopped or failed turn the chat's last row is the user's own message, so
      // "regenerate the last assistant reply" would be rejected as the wrong role. The
      // client knows which turn the button was pressed on, so it says so.
      targetId: options.targetId ?? null,
    }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }

  for await (const event of parseSse(res.body)) {
    let frame: ChatFrame;
    try {
      frame = JSON.parse(event.data) as ChatFrame;
    } catch {
      continue;
    }
    onFrame(frame);
  }
}
