/**
 * Client-side access to the exact tokenizer.
 *
 * `js-tiktoken` cannot run in the Worker — its vocabulary is 2.3 MB and building the
 * BPE map at module load exceeds a Worker's startup CPU budget, failing deployment.
 * The Worker uses `estimateTokens` instead, calibrated against the provider's own
 * reported counts.
 *
 * The browser has no such budget, so the character editor gets the real vocabulary.
 * It is loaded on demand because a static import would put 2.3 MB in the initial
 * bundle for every page load, including on a phone over mobile data.
 */
export async function loadTokenCounter(): Promise<(text: string) => number> {
  const { countTokens } = await import('./tokenizer');
  return countTokens;
}
