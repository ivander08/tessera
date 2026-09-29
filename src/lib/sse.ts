export interface SseEvent {
  data: string;
}

/**
 * Minimal SSE reader. Hand-rolled because the dependency would still need this
 * exact behaviour on the two provider quirks below.
 *
 * The thing that must be right: a `data:` line can be split across two `read()`
 * results. Only a complete blank-line-terminated event is dispatched; everything
 * after the last separator stays buffered.
 *
 * Quirks this survives (all verified against the live providers):
 * - OpenRouter keep-alives arrive as `: OPENROUTER PROCESSING` — comment lines, skipped.
 * - OpenRouter's final chunk repeats the last `finish_reason` with an empty delta and
 *   adds `usage`. It is an accounting frame, not a second terminal event; the caller
 *   decides, this parser just yields it.
 * - Mid-stream errors arrive as `data:` frames with a top-level `error` field while
 *   HTTP status stays 200. Termination is the literal sentinel `[DONE]`.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const sep = /\r?\n\r?\n/.exec(buffer);
        if (!sep || sep.index === undefined) break;
        const raw = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('data:')) yield { data: line.slice(5).trimStart() };
        }
      }
    }
    // A stream that ends without a trailing blank line still owes its last event.
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) yield { data: line.slice(5).trimStart() };
    }
  } finally {
    reader.releaseLock();
  }
}
