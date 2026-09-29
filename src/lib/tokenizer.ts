import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import type { WireMessage } from './prompt/types';

/**
 * `o200k_base` is the closest single approximation across model families. It is
 * deliberately an approximation: per-message counts are pre-flight estimates, and
 * `token_calibration` corrects them against the provider's reported `prompt_tokens`.
 */
const enc = new Tiktoken(o200k_base);

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return enc.encode(text).length;
}

/** OpenAI-style chat overhead: 4 tokens per message, 2 to prime the reply. */
export function countChatTokens(messages: WireMessage[]): number {
  let total = 2;
  for (const message of messages) {
    total += 4 + countTokens(message.role) + countTokens(message.content);
  }
  return total;
}

/** Exponential moving average weight for a newly observed calibration sample. */
export const CALIBRATION_ALPHA = 0.2;

/**
 * Fold an observed `prompt_tokens / localCount` ratio into the stored factor.
 * Clamped so one pathological response cannot poison the estimate.
 */
export function updateCalibrationFactor(
  oldFactor: number,
  returnedPromptTokens: number,
  localCount: number,
): number {
  if (localCount <= 0 || returnedPromptTokens <= 0) return oldFactor;
  const observed = returnedPromptTokens / localCount;
  if (observed < 0.5 || observed > 2) return oldFactor;
  return (1 - CALIBRATION_ALPHA) * oldFactor + CALIBRATION_ALPHA * observed;
}
