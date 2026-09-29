const KEY = process.env.KENARI_API_KEY;
const MODELS = ['deepseek-v4-1-flash', 'claude-sonnet-5', 'gpt-5-6-luna', 'gemini-3-7-flash', 'glm-5-3-flash'];

for (const model of MODELS) {
  const t0 = performance.now();
  try {
    const res = await fetch('https://kenari.id/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Count from one to ten, one word per line.' }],
        stream: true,
        max_tokens: 80,
      }),
    });
    if (!res.ok) { console.log(`${model.padEnd(22)} HTTP ${res.status}`); continue; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', n = 0; const stamps = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const t = Math.round(performance.now() - t0);
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
      for (const p of parts) if (p.startsWith('data:')) { n++; stamps.push(t); }
    }
    const spread = stamps.length > 1 ? stamps.at(-1) - stamps[0] : 0;
    console.log(`${model.padEnd(22)} ${String(n).padStart(3)} frames  first=${String(stamps[0]).padStart(5)}ms  spread=${String(spread).padStart(4)}ms  ${spread > 500 ? 'STREAMS' : 'BUFFERED'}`);
  } catch (e) { console.log(`${model.padEnd(22)} error: ${e.message}`); }
}
