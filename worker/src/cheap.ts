import { getSettings, loadChatSettings } from './db';
import type { ChatSettings } from './db';
import { keyErrorMessage, loadProviderKey } from './keys';
import { getProvider } from './providers';
import type { Provider, WireMessage } from './providers/types';
import { parseSse } from '../../src/lib/sse';

/**
 * The "cheap model" used for side-channel work: memory summarization, world-state
 * patches, character drafting, and the character consultant. None of it is shown to
 * the user directly, so it must not consume the expensive narrator model's budget.
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
  finishReason: string | null;
}

interface Prepared {
  provider: Provider;
  model: string;
  url: string;
  init: RequestInit;
}

/**
 * Everything a side-channel call needs before it can be sent: the configured cheap model,
 * its provider, its decrypted key, and the request. Shared by `complete` (one shot,
 * buffered) and `streamCheap` (multi-turn, streamed) so the two cannot drift in how they
 * resolve a provider or report a missing key.
 *
 * Message construction: `messages` is the whole list when given; otherwise `system` (when
 * set) is pushed first and `user` second. That rule is what keeps `complete()`'s behaviour
 * byte-identical to what it was before this helper existed.
 */
async function prepare(
  env: Env,
  opts: {
    system?: string;
    user?: string;
    messages?: WireMessage[];
    maxTokens?: number;
  },
): Promise<Prepared> {
  const cheap = await loadCheapModel(env);
  if (!cheap) {
    throw new Error('No cheap model configured. Set cheapProvider/cheapModel (or provider/model) in settings.');
  }

  const provider = getProvider(cheap.provider);
  if (!provider) throw new Error(`Unknown provider: ${cheap.provider}`);

  const apiKey = await loadProviderKey(env, cheap.provider);
  if (!apiKey.ok) throw new Error(keyErrorMessage(cheap.provider, apiKey.reason));

  // `system` heads the list whenever it is set; `messages` is the conversation that follows
  // it, or `user` is the single turn. Keeping the system message first in BOTH paths is what
  // makes `complete()`'s behaviour byte-identical while letting `streamCheap` carry a system
  // prompt alongside a message list — dropping it there would send a bare conversation and
  // the model would answer as if it had never been told what it is.
  const messages: WireMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  if (opts.messages) messages.push(...opts.messages);
  else messages.push({ role: 'user', content: opts.user ?? '' });

  const settings: ChatSettings = await loadChatSettings(env);
  const { url, init } = provider.buildRequest(
    {
      model: cheap.model,
      messages,
      stream: true,
      maxTokens: opts.maxTokens ?? 1024,
      knobs: settings.knobs,
      sessionId: 'side-channel',
      // Every side-channel caller wants the answer, and the flag is also forced onto the
      // built body below. It is passed here so a provider that spells the flag differently
      // gets it through its own `buildRequest` rather than through a key the other provider
      // happens to understand.
      disableReasoning: true,
    },
    apiKey.key,
  );

  return { provider, model: cheap.model, url, init };
}

/**
 * The body `buildRequest` built, with the two flags every side-channel call sets.
 *
 * `enable_thinking` is the one that matters: reasoning models (deepseek-v4-flash) emit
 * their thinking into `reasoning_content` and leave `content` empty until thinking ends.
 * Every caller here wants the answer, not the thinking, and a side-channel budget is small
 * enough that thinking consumes all of it: measured, 2048 tokens of reasoning produced
 * `content: ""` with `finish_reason: "length"`, which surfaced to the user as "Unexpected
 * end of JSON input" because `JSON.parse("")` throws. Asking for the answer directly is the
 * fix. Providers that do not know the flag ignore it; measured against
 * `deepseek-v4-1-flash` it changes nothing and returns a *longer* answer.
 *
 * `buildRequest` always sets `stream: true` for the chat path, so the flag is overridden
 * here on the already-built body rather than asked for again.
 */
function sideChannelBody(
  init: RequestInit,
  opts: { stream: boolean; json?: boolean },
): Record<string, unknown> {
  const body = { ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
  body.stream = opts.stream;
  if (opts.json) body.response_format = { type: 'json_object' };
  // Forced, not merely requested through `buildRequest`: `enable_thinking` is Kenari's
  // spelling and this call must not silently start reasoning because a provider chose not
  // to forward the flag it was handed.
  body.enable_thinking = false;
  return body;
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
  const { provider, model, url, init } = await prepare(env, opts);
  const body = sideChannelBody(init, { stream: false, json: opts.json });

  const res = await fetch(url, { ...init, body: JSON.stringify(body) });
  if (!res.ok) {
    // Kenari's 401 is plain text, so the error reader — never `res.json()` — decides.
    throw new Error(provider.readError(res.status, await res.text().catch(() => '')));
  }

  const result = await readResponse(provider, res);
  assertAnswered(result, model, opts.maxTokens ?? 1024);
  return result;
}

/**
 * A streamed completion over a full message list.
 *
 * `complete()` is the single-shot, buffered sibling; this is for a conversation, where the
 * reply is long enough that a dead wait reads as a hang. `onDelta` is called with each text
 * fragment as it arrives, and the complete text is returned as well, so a caller that only
 * wants the end result can ignore the callback.
 */
export async function streamCheap(
  env: Env,
  opts: { system?: string; messages: WireMessage[]; maxTokens?: number; json?: boolean },
  onDelta?: (text: string) => void,
): Promise<CompletionResult> {
  const { provider, model, url, init } = await prepare(env, opts);
  const body = sideChannelBody(init, { stream: true, json: opts.json });

  const res = await fetch(url, { ...init, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(provider.readError(res.status, await res.text().catch(() => '')));
  }

  const result = await readResponse(provider, res, onDelta);
  assertAnswered(result, model, opts.maxTokens ?? 1024);
  return result;
}

/**
 * Reads a response into a `CompletionResult`, whichever shape it arrived in.
 *
 * Some providers ignore the `stream` flag and answer the other way, so the content type
 * decides how to read the body rather than the request that was sent. On the JSON path the
 * whole text is reported as a single delta, so a caller never sees a stream that produced
 * no deltas at all.
 */
async function readResponse(
  provider: Provider,
  res: Response,
  onDelta?: (text: string) => void,
): Promise<CompletionResult> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream') && res.body) {
    return readStreamed(provider, res.body, onDelta);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
  };

  const result: CompletionResult = {
    text: payload.choices?.[0]?.message?.content ?? '',
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
    costUsd: typeof payload.usage?.cost === 'number' ? payload.usage.cost : null,
    finishReason: payload.choices?.[0]?.finish_reason ?? null,
  };

  onDelta?.(result.text);
  return result;
}

/**
 * A reply that hit the cap with nothing in it is not a parsing problem and must not be
 * reported as one. This is the shape a reasoning model produces when its budget runs out
 * mid-thought: the whole allowance went to `reasoning_content`, `content` is the empty
 * string, and the caller's JSON.parse reports "Unexpected end of JSON input" — which names
 * the symptom and hides the cause.
 */
function assertAnswered(result: CompletionResult, model: string, maxTokens: number): void {
  if (result.text.trim().length === 0 && result.finishReason === 'length') {
    throw new Error(
      `The ${model} reply used all ${maxTokens} tokens without producing an answer. ` +
        'Raise the token budget for this call, or pick a model that does not reason ' +
        'before answering.',
    );
  }
}

async function readStreamed(
  provider: Provider,
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<CompletionResult> {
  let text = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd: number | null = null;
  let finishReason: string | null = null;

  for await (const event of parseSse(body)) {
    if (event.data === '[DONE]') break;
    const frame = provider.parseFrame(event.data);
    if (!frame) continue;
    if (frame.error) throw new Error(frame.error);
    if (frame.text) {
      text += frame.text;
      onDelta?.(frame.text);
    }
    if (frame.finishReason) finishReason = frame.finishReason;
    if (frame.usage) {
      promptTokens = frame.usage.promptTokens;
      completionTokens = frame.usage.completionTokens;
      costUsd = frame.usage.costUsd;
    }
  }

  return { text, promptTokens, completionTokens, costUsd, finishReason };
}

/**
 * Strips a ```json fence and parses. Models add fences even when told not to, and a
 * fence is a formatting habit rather than a wrong answer — discarding a usable reply
 * over it wastes a call.
 *
 * A reply that fails to parse is repaired once and retried, for the one malformation that
 * is both common and unambiguous: a raw control character inside a string literal. A model
 * writing a multi-line `say` emits a real newline instead of `\n` often enough that it
 * killed a complete consult turn in practice — `JSON.parse` reports it as "Bad control
 * character in string literal". Escaping it is not a guess about intent: a literal newline
 * inside a string can only have meant a newline, and the alternative is throwing away a
 * finished answer. A reply that parses is never touched.
 */
export function parseJsonReply<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(body) as T;
  } catch (error) {
    const repaired = escapeControlCharsInStrings(body);
    if (repaired === body) throw error;
    return JSON.parse(repaired) as T;
  }
}

/**
 * Escapes the control characters that are illegal inside a JSON string, leaving everything
 * outside a string — including the whitespace that makes the document readable — alone.
 *
 * The scan has to track string state rather than regex the whole document: a `"` inside a
 * string is escaped and must not flip the state, and a `\n` between two keys is perfectly
 * legal and must not be rewritten.
 */
function escapeControlCharsInStrings(text: string): string {
  const ESCAPES: Record<number, string> = {
    0x08: '\\b',
    0x09: '\\t',
    0x0a: '\\n',
    0x0c: '\\f',
    0x0d: '\\r',
  };

  let out = '';
  let inString = false;
  let afterBackslash = false;

  for (const char of text) {
    if (afterBackslash) {
      out += char;
      afterBackslash = false;
      continue;
    }

    if (char === '\\') {
      out += char;
      // Only inside a string does a backslash escape the next character.
      afterBackslash = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }

    const code = char.codePointAt(0) ?? 0;
    if (inString && code < 0x20) {
      out += ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += char;
  }

  return out;
}
