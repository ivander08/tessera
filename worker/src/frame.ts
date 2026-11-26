import type { NormalizedUsage } from './providers/types';

/**
 * The Worker's normalized client protocol. The client never sees a provider quirk.
 *
 * Every frame is `data: <json>\n\n`. Exactly one terminal frame — `done` or `error` —
 * ends a stream.
 */
export type Frame =
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; usage: NormalizedUsage; costUsd: number | null; truncated: boolean }
  | { type: 'error'; message: string; code: string };
