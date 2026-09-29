const [TOK, BASE, CHAT] = process.argv.slice(2);
const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
  body: JSON.stringify({ chatId: CHAT, content: 'Count from one to five.' }),
});
const reader = res.body.getReader();
let n = 0;
const t0 = performance.now();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  n++;
  console.log(`chunk ${n} @ ${Math.round(performance.now() - t0)}ms, ${value.length} bytes: ${JSON.stringify(new TextDecoder().decode(value).slice(0, 60))}`);
}
