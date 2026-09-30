/**
 * Meter-validity check: does a deliberate prefix break actually move the needle?
 *
 * The plan calls this the most important measurement in the project — every other cache
 * number is meaningless if a deliberate break does not collapse the hit rate.
 *
 * Runs against the LOCAL Worker because it needs to change the system prompt mid-run,
 * which is a settings write. Restores the original prompt when it finishes, including
 * on failure.
 *
 * Usage: bun run verify/meter-validity.ts <baseUrl> <token> <chatId>
 */
const [baseUrl, token, chatId] = process.argv.slice(2);
const headers = {
  Authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  connection: 'close',
};

interface Usage {
  promptTokens: number;
  cachedTokens: number;
}

async function setting(key: string, value: string): Promise<void> {
  await fetch(`${baseUrl}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ key, value }) });
}

async function readSetting(key: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/settings`, { headers });
  const all = (await res.json()) as Record<string, string>;
  return all[key] ?? '';
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
    const frame = JSON.parse(line.slice(5).trim()) as { type: string; usage?: Usage; message?: string };
    if (frame.type === 'error') throw new Error(frame.message);
    if (frame.type === 'done' && frame.usage) return frame.usage;
  }
  throw new Error('no done frame');
}

/** Cached tokens are reported per turn; the last one reflects the current prefix. */
async function sample(label: string, count = 3): Promise<number[]> {
  const out: number[] = [];
  for (let i = 1; i <= count; i++) {
    const usage = await turn(`${label} ${i}: one short sentence.`);
    out.push(usage.cachedTokens);
  }
  return out;
}

const original = await readSetting('systemPrompt');
console.log(`original system prompt: ${JSON.stringify(original.slice(0, 60))}...\n`);

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  console.log('warming the cache...');
  const warm = await sample('warm', 8);
  console.log(`  cached: ${warm.join(', ')}`);
  const baseline = warm[warm.length - 1];
  check('cache is warm before the test', baseline > 0, `${baseline} cached tokens`);

  console.log('\nbreaking the prefix (timestamp in the system prompt)...');
  const broken: number[] = [];
  for (let i = 1; i <= 4; i++) {
    await setting('systemPrompt', `${original}\nCurrent time: ${Date.now()}`);
    const usage = await turn(`broken ${i}: one short sentence.`);
    broken.push(usage.cachedTokens);
  }
  console.log(`  cached: ${broken.join(', ')}`);
  check(
    'a deliberate prefix break collapses the cache to zero',
    broken.every((value) => value === 0),
    `${broken.filter((v) => v > 0).length} of ${broken.length} turns still cached`,
  );

  console.log('\nrestoring...');
  await setting('systemPrompt', original);
  const recovered = await sample('recovered', 4);
  console.log(`  cached: ${recovered.join(', ')}`);
  check(
    'the cache recovers once the prefix is restored',
    recovered[recovered.length - 1] > 0,
    `${recovered[recovered.length - 1]} cached tokens`,
  );
} finally {
  // Always put the prompt back, even if an assertion threw.
  await setting('systemPrompt', original);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
