import { getSettings, loadChatSettings } from './db';
import type { ChatSettings } from './db';
import { loadProviderKey } from './keys';
import { getProvider } from './providers';
import { parseSse } from '../../src/lib/sse';

/**
 * The "cheap model" used for side-channel work: memory summarization, world-state
 * patches, and character drafting. None of it is shown to the user directly, so it
 * must not consume the expensive narrator model's budget.
 *
 * One convention, shared by every side-channel caller:
 *   settings `cheapProvider` / `cheapModel`, falling back to `provider` / `model`.
 * Three separate conventions here would mean three places to configure the same
 * thing, and two of them would silently be wrong.
 */
export interface CheapModel {
  provider: string;
  model: string;
}

export async function loadCheapModel(env: Env): Promise<CheapModel | null> {
  const raw = await getSettings(env);
  const provider = raw.cheapProvider || raw.provider;
  const model = raw.cheapModel || raw.model;
  if (!provider || !model) return null;
  if (!getProvider(provider)) return null;
  return { provider, model };
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

/**
 * A single non-streaming completion on the cheap model.
 *
 * Non-streaming is deliberate: every caller here wants the whole answer before it can
 * act on it, and buffering removes a whole class of partial-JSON bugs.
 */
export async function complete(
  env: Env,
  opts: { system?: string; user: string; maxTokens?: number; json?: boolean },
): Promise<CompletionResult> {
  const cheap = await loadCheapModel(env);
  if (!cheap) {
    throw new Error('No cheap model configured. Set cheapProvider/cheapModel (or provider/model) in settings.');
  }

  const provider = getProvider(cheap.provider);
  if (!provider) throw new Error(`Unknown provider: ${cheap.provider}`);

  const apiKey = await loadProviderKey(env, cheap.provider);
  if (!apiKey) throw new Error(`No API key stored for ${cheap.provider}.`);

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const settings: ChatSettings = await loadChatSettings(env);
  const { url, init } = provider.buildRequest(
    {
      model: cheap.model,
      messages,
      stream: true,
      maxTokens: opts.maxTokens ?? 1024,
      knobs: settings.knobs,
      sessionId: 'side-channel',
    },
    apiKey,
  );

  // `buildRequest` always sets `stream: true` for the chat path. This call wants the
  // whole answer, so the flag is overridden on the already-built body.
  const body: Record<string, unknown> = {
    ...(JSON.parse(String(init.body)) as Record<string, unknown>),
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const res = await fetch(url, { ...init, body: JSON.stringify(body) });
  if (!res.ok) {
    // Kenari's 401 is plain text, so the error reader — never `res.json()` — decides.
    throw new Error(provider.readError(res.status, await res.text().catch(() => '')));
  }

  // Some providers ignore `stream: false` and answer with SSE anyway, so the content
  // type decides how to read the body rather than the request we sent.
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream') && res.body) {
    return readStreamed(provider, res.body);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
  };

  return {
    text: payload.choices?.[0]?.message?.content ?? '',
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
    costUsd: typeof payload.usage?.cost === 'number' ? payload.usage.cost : null,
  };
}

async function readStreamed(
  provider: ReturnType<typeof getProvider> & object,
  body: ReadableStream<Uint8Array>,
): Promise<CompletionResult> {
  let text = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd: number | null = null;

  for await (const event of parseSse(body)) {
    if (event.data === '[DONE]') break;
    const frame = provider.parseFrame(event.data);
    if (!frame) continue;
    if (frame.error) throw new Error(frame.error);
    if (frame.text) text += frame.text;
    if (frame.usage) {
      promptTokens = frame.usage.promptTokens;
      completionTokens = frame.usage.completionTokens;
      costUsd = frame.usage.costUsd;
    }
  }

  return { text, promptTokens, completionTokens, costUsd };
}

/**
 * Strips a ```json fence and parses. Models add fences even when told not to, and a
 * fence is a formatting habit rather than a wrong answer — discarding a usable reply
 * over it wastes a call.
 */
export function parseJsonReply<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(body) as T;
}
