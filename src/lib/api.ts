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
    res = await fetch(path, { ...init, headers });
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
export async function streamChat(
  chatId: string,
  content: string,
  onFrame: (frame: ChatFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ chatId, content }),
    signal,
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
