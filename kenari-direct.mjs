const KEY = process.env.KENARI_API_KEY;
const t0 = performance.now();
const res = await fetch('https://kenari.id/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-v4-1-flash',
    messages: [{ role: 'user', content: 'Count from one to ten, one word per line.' }],
    stream: true,
    max_tokens: 80,
  }),
});
console.log('status', res.status);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '', n = 0;
const stamps = [];
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const t = Math.round(performance.now() - t0);
  buf += dec.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop() ?? '';
  for (const p of parts) if (p.startsWith('data:')) { n++; stamps.push(t); }
}
console.log(`KENARI DIRECT: ${n} frames; first=${stamps[0]}ms last=${stamps.at(-1)}ms spread=${stamps.at(-1)-stamps[0]}ms total=${Math.round(performance.now()-t0)}ms`);
