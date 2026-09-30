/**
 * Cache progression probe.
 *
 * Sends N turns to one chat and prints the cached/prompt split for each, so the
 * question "is the cacheable prefix advancing?" is answered by a sequence of numbers
 * rather than a single reading.
 *
 * Usage: bun run verify/cache-progress.ts <baseUrl> <token> <chatId> <turns>
 */
const [baseUrl, token, chatId, turnsArg] = process.argv.slice(2);
const turns = Number(turnsArg ?? 12);

const headers = {
  Authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  connection: 'close',
};

interface Usage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

async function turn(content: string): Promise<Usage> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ chatId, content }),
  });
  const raw = await res.text();
  for (const block of raw.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const frame = JSON.parse(line.slice(5).trim()) as {
      type: string;
      usage?: Usage;
      message?: string;
    };
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'done' && frame.usage) return frame.usage;
  }
  throw new Error('no done frame');
}

console.log('turn  prompt  cached   share   delta-cached');
let previous = 0;
for (let i = 1; i <= turns; i++) {
  const usage = await turn(`Turn ${i}: add one short sentence.`);
  const share = usage.promptTokens > 0 ? (usage.cachedTokens / usage.promptTokens) * 100 : 0;
  const delta = usage.cachedTokens - previous;
  previous = usage.cachedTokens;
  console.log(
    `${String(i).padStart(4)}  ${String(usage.promptTokens).padStart(6)}  ${String(usage.cachedTokens).padStart(6)}  ${share.toFixed(1).padStart(5)}%  ${String(delta).padStart(12)}`,
  );
}
