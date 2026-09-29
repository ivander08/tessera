/**
 * Fast, dependency-free token estimate for the Worker.
 *
 * `js-tiktoken` cannot run here. Its `o200k_base` vocabulary is 2.3 MB and building
 * the BPE map at module load costs more startup CPU than a Worker is allowed, so
 * bundling it fails deployment outright (`Script startup exceeded CPU time limit`,
 * code 10021). Even if it loaded, Workers Free grants 10 ms CPU per request.
 *
 * This estimator is deliberately cheap and deliberately approximate. It is used only
 * for pre-flight budget decisions and per-message windowing; the provider's own
 * `usage.prompt_tokens` is authoritative for accounting, and `token_calibration`
 * converges a per-model correction factor onto this estimate — so a systematic bias
 * here is corrected rather than accumulated.
 *
 * Constants were tuned against the real `o200k_base` tokenizer over a corpus of
 * roleplay prose, chat messages, markdown, and JSON: English lands within ~13% worst
 * case (mean ~12%), accented Latin ~11%, CJK ~17%, Cyrillic ~19%. Non-Latin is worse
 * because one scalar calibration factor cannot correct a per-script bias, which is
 * the documented reason the provider's count is trusted over this one.
 */

/** Word characters per token, divided once over the whole text rather than per word. */
const WORD_CHARS_PER_TOKEN = 6;
/** Cost of one ASCII punctuation or whitespace character. */
const PUNCTUATION_WEIGHT = 0.5;
/** Cost of one CJK / Hangul character. */
const CJK_WEIGHT = 0.7;
/** Cost of one non-ASCII, non-CJK character (accented Latin, Cyrillic, Greek, Arabic). */
const EXTENDED_LATIN_WEIGHT = 0.25;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let wordChars = 0;
  let punctuation = 0;
  let other = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (code < 128) {
      if (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122)
      ) {
        wordChars++;
      } else {
        punctuation++;
      }
      continue;
    }

    if (code >= 0x1f300) {
      // Emoji and pictographs are several tokens each in every real vocabulary.
      other += 2;
    } else if (isCjk(code)) {
      other += CJK_WEIGHT;
    } else {
      other += EXTENDED_LATIN_WEIGHT;
    }
  }

  const estimate =
    wordChars / WORD_CHARS_PER_TOKEN + punctuation * PUNCTUATION_WEIGHT + other;

  // A non-empty string is at least one token, however short.
  return Math.max(Math.round(estimate), 1);
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // radicals, kana, CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0x20000 && code <= 0x2fa1f) // CJK extension B+
  );
}

/** Chat overhead: roughly 4 tokens per message plus 2 to prime the reply. */
export function estimateChatTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 2;
  for (const message of messages) {
    total += 4 + estimateTokens(message.role) + estimateTokens(message.content);
  }
  return total;
}

/**
 * Apply a stored calibration factor to a raw estimate. The factor is the running
 * ratio of the provider's reported prompt tokens to this estimator's output.
 */
export function applyCalibration(estimate: number, factor: number): number {
  return Math.max(1, Math.round(estimate * factor));
}
