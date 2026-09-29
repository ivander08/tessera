import { describe, expect, test } from 'bun:test';
import { parseSse } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const event of parseSse(streamOf(chunks))) out.push(event.data);
  return out;
}

describe('parseSse', () => {
  test('splits multiple events in one chunk', async () => {
    expect(await collect(['data: a\n\ndata: b\n\n'])).toEqual(['a', 'b']);
  });

  test('reassembles a data line split across two reads', async () => {
    expect(await collect(['data: {"te', 'xt":"hi"}\n\n'])).toEqual(['{"text":"hi"}']);
  });

  test('reassembles an event split mid-separator', async () => {
    expect(await collect(['data: a\n', '\ndata: b\n\n'])).toEqual(['a', 'b']);
  });

  test('skips keep-alive comment lines', async () => {
    expect(await collect([': OPENROUTER PROCESSING\n\ndata: a\n\n'])).toEqual(['a']);
  });

  test('handles CRLF separators', async () => {
    expect(await collect(['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual(['a', 'b']);
  });

  test('handles multi-line data fields within one event', async () => {
    expect(await collect(['data: one\ndata: two\n\n'])).toEqual(['one', 'two']);
  });

  test('yields a trailing event with no final blank line', async () => {
    expect(await collect(['data: a\n\ndata: [DONE]'])).toEqual(['a', '[DONE]']);
  });

  test('preserves payload whitespace after the field separator', async () => {
    expect(await collect(['data:{"type":"delta"}\n\n'])).toEqual(['{"type":"delta"}']);
  });
});
