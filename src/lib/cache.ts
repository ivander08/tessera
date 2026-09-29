import type { MessageRow } from './apiTypes';

/**
 * Per-chat hit rate = sum(cached_tokens) / sum(prompt_tokens) over assistant rows.
 *
 * `prompt_tokens` is the provider's own count of what it had to process, so this is
 * the fraction of the prompt served from cache. User rows are excluded because they
 * never carry a provider report.
 */
export function computeHitRate(messages: MessageRow[]): number | null {
  let cached = 0;
  let total = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || message.prompt_tokens == null) continue;
    total += message.prompt_tokens;
    cached += message.cached_tokens ?? 0;
  }
  return total > 0 ? cached / total : null;
}
