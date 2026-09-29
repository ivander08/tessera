const [TOK, BASE, CHAT] = process.argv.slice(2);
const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
  body: JSON.stringify({ chatId: CHAT, content: 'Write three short sentences about rain.' }),
});
console.log('status', res.status);
const t0 = performance.now();
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
console.log(`${n} frames; first=${stamps[0]}ms last=${stamps.at(-1)}ms spread=${stamps.at(-1) - stamps[0]}ms`);
