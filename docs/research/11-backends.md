# LLM backends + the 2026 roleplay model landscape

Research date **2026-09-29**. All CORS results below are **live `curl` observations from this host** (raw preflight/POST headers), not doc paraphrase. All prices are USD per 1M tokens from OpenRouter's live `/api/v1/models` JSON unless a vendor page is named.

**Architectural premise (hard constraint):** the app is 100% client-side (browser/PWA/native), BYOK, no server of the user's own. Every provider call is a direct device→vendor request. **CORS is therefore a first-class requirement, not a footnote.**

---

## (a) Provider matrix — can a browser call it directly today?

Legend: **ACAO** = `Access-Control-Allow-Origin` observed. "Echo" = reflects the caller's Origin (often with `Allow-Credentials: true`); "`*`" = wildcard.

### a.1 Verified CORS results (observed 2026-09-29)

| Provider | Endpoint | Preflight / POST result | Browser-callable? |
|---|---|---|---|
| **OpenRouter** | `openrouter.ai/api/v1/chat/completions` | `204`; `ACAO: *`; `Allow-Headers` explicitly lists **`Authorization`**, `X-Api-Key`, `HTTP-Referer`, `X-Openrouter-Title`; `Allow-Methods: GET,OPTIONS,PATCH,DELETE,POST,PUT`; `Expose-Headers: X-Generation-Id,X-Provider-Name,request-id,cf-ray` | ✅ **YES — cleanest BYOK target** |
| **Anthropic** | `api.anthropic.com/v1/messages` | **Without** opt-in header: `400`, **no ACAO at all**. **With** `anthropic-dangerous-direct-browser-access: true`: `200`, `ACAO: *`, `Allow-Headers: authorization,content-type,anthropic-version,anthropic-dangerous-direct-browser-access,x-api-key` | ✅ YES, **only with that header** |
| **OpenAI** | `api.openai.com/v1/chat/completions` | Preflight `200` echoes Origin, advertises POST, but **`Access-Control-Allow-Headers` is EMPTY**. The **actual POST returns NO ACAO** (only `Access-Control-Expose-Headers: CF-Ray`) → the browser blocks reading the response. `GET /v1/models` *does* return `ACAO: *` | ⚠️ **NO for chat/completions without a proxy.** Models list works |
| **Google Gemini** | `generativelanguage.googleapis.com/v1beta/...` | POST preflight `200`; `ACAO: <echoed origin>`; `Allow-Headers: content-type,x-goog-api-key`; `Max-Age: 3600` | ✅ YES (echo) |
| **xAI (Grok)** | `api.x.ai/v1/chat/completions` | `200`; `ACAO: *`; `Allow-Methods: *`; **`Allow-Headers: *`** | ✅ YES — widest CORS seen |
| **DeepSeek** | `api.deepseek.com/chat/completions` | `200`; `ACAO: <echo>`; `Allow-Credentials: true`; `Allow-Headers: authorization,content-type,apikey,client-agent` | ✅ YES (echo) |
| **Mistral** | `api.mistral.ai/v1/chat/completions` | `200`; `ACAO: *`; `Allow-Headers: Authorization,Content-Type,…` | ✅ YES |
| **Groq** | `api.groq.com/openai/v1/chat/completions` | `204`; `ACAO: *`; `Allow-Headers: authorization,content-type,apikey,client-agent` | ✅ YES |
| **Cerebras** | `api.cerebras.ai/v1/chat/completions` | `200`; `ACAO: *`; `Allow-Headers: authorization,content-type,apikey,client-agent` | ✅ YES |
| **Together** | `api.together.xyz/v1/chat/completions` | `200`; `ACAO: *`; `Allow-Methods: POST,OPTIONS` | ✅ YES |
| **Featherless** | `api.featherless.ai/v1/chat/completions` | `204`; `ACAO: <echo>`; `Allow-Credentials: true` | ✅ YES (echo) |
| **Infermatic** | `api.totalgpt.ai/v1/chat/completions` | `200`; `ACAO: *`; `Allow-Credentials: true` | ✅ YES |
| **Arli AI** | `api.arliai.com/v1/chat/completions` | `204`; `ACAO: <echo>`; `Allow-Credentials: true`; `Allow-Headers: authorization,content-type` | ✅ YES — **alive at `arliai.com`** |
| **NovelAI** | `text.novelai.net/oa/v1/chat/completions` | `200`; `ACAO: *`; `Allow-Headers: Authorization, Content-Type` | ✅ YES on `text.novelai.net`. ❌ `api.novelai.net` returns **no ACAO** |
| **AI Horde** | `aihorde.net/api/v2/generate/text/async` | `200`; `ACAO: *`; `Allow-Headers` includes **`apikey`** and `Client-Agent` | ✅ YES |

**Correction to a common claim:** Arli AI is **not** dead. `api.arli.ai` 404/redirects (that domain is for sale), but the real service is **`https://api.arliai.com/v1/...`** and it answers CORS correctly. Docs: https://www.arliai.com/docs/api

### a.2 The OpenAI problem, precisely

`POST https://api.openai.com/v1/chat/completions` with `Origin:` set returns **no `Access-Control-Allow-Origin` header at all** — verified twice. A browser therefore cannot read the response, even though the preflight passes. `GET /v1/models` and `OPTIONS /v1/responses` do return `*`, so OpenAI's edge emits CORS unevenly.

OpenAI's own SDK docs confirm the stance: *"Web browsers: disabled by default to avoid exposing your secret API credentials. Enable browser support by explicitly setting `dangerouslyAllowBrowser` to `true`"* — and even then it is scoped to internal tools. **Practical consequence for a client-only app: OpenAI direct is not a supported BYOK path.** Users who want GPT models should reach them through OpenRouter (or a user-run proxy).

### a.3 Anthropic's gate is two-layered

1. The request header `anthropic-dangerous-direct-browser-access: true` is **required**; without it the preflight has no ACAO.
2. **Per-org Console setting.** Anthropic maintainers document that an org can disable CORS entirely; users then get `401 "CORS requests are not allowed for this Organization because of its settings."` (anthropic-sdk-typescript PR #504).
3. `POST /v1/messages/batches` is documented as missing CORS — only `/v1/messages` and `/v1/models` are confirmed working.
4. The TS SDK sets the header automatically only when `dangerouslyAllowBrowser: true`. Raw `fetch()` must set it by hand.

Background: https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/

### a.4 Which providers work from a PWA with only a key, no proxy

| Tier | Providers | Notes |
|---|---|---|
| **Zero-friction, key only** | **OpenRouter**, xAI, Mistral, Groq, Cerebras, Together, Infermatic, Arli AI, AI Horde, Google Gemini | Wildcard or origin-echo ACAO. OpenRouter is the standout: it lists `Authorization` in Allow-Headers, publishes a first-party raw-`fetch()` example, and fronts ~all frontier + open models on one key |
| **Key + one required header** | Anthropic | `anthropic-dangerous-direct-browser-access: true`, plus per-org enablement |
| **Key + likely proxy** | **OpenAI** | No ACAO on the completions POST |
| **Split host** | NovelAI | `text.novelai.net` OK; `api.novelai.net` not |

**Recommendation:** make **OpenRouter the default/first-class provider** (one key → Claude, GPT, Gemini, DeepSeek, GLM, Kimi, Qwen, Grok, and thousands of open finetunes), with native xAI / Gemini / Mistral / DeepSeek / Groq as "power" options, Anthropic as an explicit opt-in with the header, and **OpenAI shipped as "route via OpenRouter"** rather than a raw provider.

### a.5 Streaming

All OpenAI-compatible providers stream via SSE with `"stream": true` — confirmed in OpenRouter's docs (*"Server-Sent Events (SSE) are supported… to enable streaming for all models"*), and it is the same transport for xAI/DeepSeek/Mistral/Groq/Cerebras/Together/Featherless/Infermatic/Arli. Anthropic uses its own SSE event schema on `/v1/messages`. Gemini uses `streamGenerateContent?alt=sse`. **AI Horde has no streaming at all** (see §d).

### a.6 Local servers (Ollama, LM Studio, llama.cpp, KoboldCpp, vLLM)

All five expose OpenAI-compatible `/v1/chat/completions` today, and **CORS is a non-issue on every one** — the real blocker is the browser security model.

| Server | Default | CORS enablement | LAN? |
|---|---|---|---|
| Ollama | `http://127.0.0.1:11434` | `OLLAMA_ORIGINS` (default already covers localhost/127.0.0.1/0.0.0.0 + `app://`, `file://`, `tauri://`) | needs `OLLAMA_HOST=0.0.0.0:11434` |
| LM Studio | `http://localhost:1234` | GUI toggle **"Enable CORS"** | needs "Serve on Local Network" |
| llama.cpp | `http://127.0.0.1:8080` | `--cors-origins` **default `*`**; `--cors-headers` default `*`; `--cors-credentials` default on | `--host 0.0.0.0` |
| KoboldCpp | `http://localhost:5001` | **No flag needed** — handler emits permissive CORS + `Access-Control-Allow-Private-Network: true` unconditionally | binds all interfaces by default |
| vLLM | `http://0.0.0.0:8000` | `--allowed-origins` **default `['*']`** | binds all interfaces |

**The actual wall — mixed content.** Per MDN, `http://localhost`, `http://127.0.0.1` and `http://[::1]` are **potentially trustworthy origins**, and loopback content is explicitly *not* blocked mixed content. So **an HTTPS-served PWA CAN `fetch()` `http://localhost:11434` today.** But `http://192.168.x.x:5001` from an HTTPS page **is** blockable mixed content and is hard-blocked with no override. Chrome's Private Network Access preflight applies on top for public→private requests.

**Verdict: local servers are a same-device desktop-only feature.** Ship it as "Local (this device)" probing 11434/1234/8080/5001/8000 on both `localhost` and `127.0.0.1` (distinct CORS origins — allow both). Document LAN as unsupported; it needs TLS on the server.

### a.7 Key-exposure risk in a client-only app

| Risk | Reality |
|---|---|
| Key in `localStorage` | Readable by any XSS on the origin. Unavoidable for BYOK; **never ship a developer key** |
| Key in a public bundle | Fatal — anyone can drain the account. **BYOK-only means the key never leaves the user's device**, which is exactly the pattern Anthropic's own `dangerouslyAllowBrowser` doc blesses |
| Third-party scripts | Any injected analytics/CDN script can exfiltrate. Mitigate with a strict CSP, no third-party JS in the app shell |
| OpenRouter upstream key sharing | OpenRouter **supports BYOK passthrough** — a user can attach their own OpenAI/Anthropic key and OpenRouter will use it, billed to them |
| Local server | No key at all; loopback only, no exposure |

**Mitigations that actually work:** (1) user-supplied key only, never a shared app key; (2) keys in `localStorage`/IndexedDB scoped to one origin, never synced to a cloud; (3) optional passphrase-encrypted key vault (WebCrypto AES-GCM) so a stolen disk image isn't enough; (4) a strict CSP + zero third-party JS; (5) per-provider spend caps configured *at the vendor* (OpenRouter `GET /api/v1/key` → `limit_remaining`; per-key credit caps) so a leaked key has a bounded blast radius.

---

## (b) Model shortlist for roleplay, late 2025 → 2026

### b.1 What the benchmarks actually say

**EQ-Bench Creative Writing v3** (LLM-judged, 141 models, https://eqbench.com/creative_writing) — top of the board as of 2026-09-29:

| Rank | Model | Rubric | Elo | Slop ↓ |
|---|---|---|---|---|
| 1 | gpt-6-astra | 84.00 | 2173.3 | 3.5 |
| 2 | claude-fable-5-1 | 84.75 | 2162.0 | 3.6 |
| 3 | **claude-opus-5** | 85.35 | 2132.6 | 4.3 |
| 4 | gpt-6-sol | 82.55 | 2124.7 | 3.6 |
| 5 | **kimi-k3** | 84.25 | 2082.3 | 3.7 |
| 6 | **GLM-5.3** | 85.20 | 2075.0 | 3.2 |
| 7 | claude-opus-5-5 | 83.95 | 2050.1 | 3.8 |
| 8 | **grok-4.7** | 85.80 | 2006.7 | 3.5 |
| … | **DeepSeek-V4-Pro** | 82.25 | 1553.2 | 3.2 |
| … | **DeepSeek-V4-Flash** | 81.45 | 1559.1 | 4.3 |
| … | **Kimi-K2.6** | 83.35 | 1724.5 | 3.8 |
| … | **claude-sonnet-4.5** | 80.70 | 1677.6 | 3.6 |
| … | DeepSeek-R1 | 78.40 | 1500.0 | 4.6 |
| … | Mistral-Nemo-Instruct-2407 | 47.55 | 880.9 | **14.1** |
| … | gpt-oss-120b | 53.70 | 961.0 | 4.0 |

Read the **Slop** column for RP specifically: GLM-5.3 (3.2) and DeepSeek-V4-Pro (3.2) beat claude-opus-5 (4.3) on GPT-ism avoidance, and Mistral-Nemo is catastrophic (14.1) — which matches the community verdict that base Nemo needs a finetune (UnslopNemo, Magnum) to be usable.

**UGI — Uncensored General Intelligence** (https://huggingface.co/spaces/DontPlanToEnd/UGI-Leaderboard), live grid scrape 2026-09-29. Columns: UGI 🏆 / W-10 👍 / NatInt 💡 / Writing ✍️:

| # | Model | UGI | W/10 | NatInt | Writing |
|---|---|---|---|---|---|
| 1 | xai/grok-4.20-multi-agent-beta | 70.0 | 6.5 | 56.3 | 63.1 |
| 2 | **ArliAI/GLM-4.6-Derestricted-v3** | 69.8 | 8.8 | 30.9 | 36.4 |
| 3 | xai/grok-4-0709 | 67.8 | 6.0 | 65.2 | 67.0 |
| 4 | darkc0de/XORTRON.CriminalComputing.LARGE | 66.2 | 8.2 | 36.9 | 39.2 |
| 6 | coder3101/gemma-4-31B-it-heretic | 65.7 | **10.0** | 36.5 | 40.5 |
| 7 | **deepseek-ai/DeepSeek-V3.2-Speciale** | 65.4 | 4.8 | 53.0 | 54.0 |
| 12 | **deepseek-ai/DeepSeek-V4-Pro** (reasoning) | 62.3 | 3.2 | 67.0 | 68.4 |
| 14 | anthropic/claude-opus-4-6 (effort=high) | 60.4 | 3.2 | 70.9 | 70.9 |
| 15 | openai/gpt-5.6-sol | 60.1 | 3.5 | 72.4 | 63.2 |
| 20 | deepseek-ai/DeepSeek-V4-Flash | 59.2 | 7.2 | 47.9 | 54.6 |
| 22 | zai-org/GLM-5.2 | 58.9 | 2.8 | 55.2 | 67.0 |
| 24 | mistralai/Mistral-Large-3-675B | 58.6 | 6.8 | 38.8 | 41.5 |
| 34 | moonshotai/Kimi-K2-Instruct | 56.6 | 3.2 | 48.9 | 52.5 |

**The pattern:** frontier closed models (Claude Opus, GPT-5.6-sol) win **NatInt/Writing** but sit at **W/10 ≈ 3.2–3.5** — they refuse. The RP-relevant winners are the **uncensored finetunes and open MoEs** (GLM-4.6-Derestricted at W/10 8.8, gemma-4-31B-heretic at 10.0) and DeepSeek, which is both smart and comparatively compliant (V4-Flash: NatInt 47.9, W/10 7.2).

### b.2 What the roleplay community actually runs

**OpenRouter roleplay usage share** (modelgrep, updated hourly, Sept 2026, ranked by real OpenRouter RP traffic among non-moderated models with ≥32K context — https://modelgrep.com/best-models-for/sillytavern):

| # | Model | RP share | $/M in | ctx |
|---|---|---|---|---|
| 1 | **deepseek-v4-flash** (0423) | **17.3%** | $0.14 | 1.0M |
| 2 | **deepseek-v4-flash-0731** | 13.3% | **$0.018** | 1.3M |
| 3 | **deepseek-v4.1-flash** | 8.4% | $0.30 | 1.0M |
| 4 | **gemini-2.5-flash-lite** | 5.6% | $0.10 | 1.0M |
| 5 | deepseek-v3.2 | 3.8% | $0.28 | 164K |
| 6 | **glm-5.3-flash** | 2.6% | $0.15 | 1.3M |

OpenRouter's own roleplay collection agrees: *"The current top models are DeepSeek V4.1 Flash, Space Bunny Alpha, and GLM 5.3 Flash."* (https://openrouter.ai/collections/roleplay)

Community texture (RPFiend weekly, https://rpfiend.com/sillytavern-weekly-april-27-2026/): DeepSeek V4 Pro shipped at a **75% discount** and triggered a buying frenzy; users reported V4 Pro **randomly injecting numbers into outputs** (unresolved in that week's thread); **Kimi K2.6 was called "the best LLM for slowburn"** for sustained long-session coherence; Z.AI's GLM plans kept drawing ban/limit drama and GLM's coding plan docs now list **SillyTavern as authorized use** (a legit upstream win); and Nvidia's free API tier was reported issuing bans for overuse.

### b.3 Cost per typical RP turn

Assumption: **6,000 input tokens** (character card + lorebook + history) + **400 output tokens**. Formula: `0.006×in + 0.0004×out`.

| Model | $/M in | $/M out | **$/turn** | 1000 turns |
|---|---|---|---|---|
| deepseek-v4-flash-0731 | 0.018 | 0.32 | **$0.00024** | $0.24 |
| mistral-nemo | 0.019 | 0.03 | **$0.00013** | $0.13 |
| gemini-2.5-flash-lite | 0.10 | 0.40 | $0.00076 | $0.76 |
| deepseek-v4-flash (0423) | 0.14 | 0.28 | $0.00095 | $0.95 |
| glm-5.3-flash | 0.15 | 0.50 | $0.00110 | $1.10 |
| qwen3.8-27b | 0.045 | 4.40 | $0.00203 | $2.03 |
| deepseek-v4.1-flash | 0.30 | 1.20 | $0.00228 | $2.28 |
| unslopnemo-12b | 0.40 | 0.40 | $0.00256 | $2.56 |
| sao10k/l3.3-euryale-70b | 0.65 | 0.75 | $0.00420 | $4.20 |
| deepseek-v4-pro-0813 | 0.48 | 4.20 | $0.00456 | $4.56 |
| kimi-k2.6 | 0.65 | 3.41 | $0.00526 | $5.26 |
| claude-haiku-4.5 | 1.00 | 5.00 | $0.00800 | $8.00 |
| glm-5.3 | 1.40 | 4.40 | $0.01020 | $10.20 |
| grok-4.7 | 2.00 | 6.00 | $0.01440 | $14.40 |
| claude-sonnet-5 | 2.00 | 10.00 | **$0.01600** | $16.00 |
| magnum-v4-72b | 2.50 | 5.00 | $0.01700 | $17.00 |
| kimi-k3 | 3.00 | 15.00 | $0.02400 | $24.00 |
| claude-opus-5 | 5.00 | 25.00 | **$0.04000** | $40.00 |

**DeepSeek's official platform is cheaper still and has off-peak pricing** (https://api-docs.deepseek.com/quick_start/pricing): V4.1-Flash off-peak **$0.15 in / $0.60 out**, peak $0.30/$1.20; V4-Pro off-peak $0.66/$1.98, peak $1.32/$3.96. Cache hits are **$0.003–$0.022/M** — for a chat app with a stable character card + system prompt, prompt caching is the single biggest cost lever available.

### b.4 Shortlist by budget tier

| Tier | Pick | Why | Alt |
|---|---|---|---|
| **Free** | `openrouter/free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `z-ai/glm-flash-latest` ($0.02/$0.30) | Genuinely free models exist on OpenRouter (20 RPM, 50 req/day without credits, 1000/day with ≥$10 credit); Nemotron-3-Ultra-550B is 1M ctx at $0 | AI Horde (§d) |
| **Ultra-cheap (<$1 / 1000 turns)** | **`deepseek/deepseek-v4-flash-0731`** ($0.00024/turn) | #2 in RP usage at 13.3%; 1.3M ctx | `mistralai/mistral-nemo`, `gemini-2.5-flash-lite` |
| **Best value (~$1–3 / 1000 turns)** | **`deepseek/deepseek-v4-flash`** ($0.00095) and **`z-ai/glm-5.3-flash`** ($0.00110) | #1 RP usage; 1M ctx; no provider-level moderation | `deepseek-v4.1-flash`, `qwen3.8-27b` |
| **Mid ($3–6 / 1000 turns)** | **`deepseek/deepseek-v4-pro-0813`** ($0.00456), **`moonshotai/kimi-k2.6`** ($0.00526) | Kimi K2.6 = best slowburn / long-session coherence per the community | `sao10k/l3.3-euryale-70b` for classic uncensored RP |
| **Premium ($10–25 / 1000 turns)** | **`anthropic/claude-sonnet-5`** ($0.016), **`x-ai/grok-4.7`** ($0.0144) | Best prose; Claude needs the browser header | `z-ai/glm-5.3` (highest CWv3 rubric, lowest slop) |
| **Frontier / cost-no-object** | **`anthropic/claude-opus-5`** ($0.04), `kimi-k3`, `gpt-6-astra` | Top CWv3 Elo. Opus 5 has W/10 only 3.2 → heavy refusal on NSFW | — |
| **Uncensored / NSFW** | `ArliAI/GLM-4.6-Derestricted-v3` (UGI 69.8, W/10 8.8), `coder3101/gemma-4-31B-it-heretic` (W/10 10.0), `thedrummer/unslopnemo-12b`, `anthracite-org/magnum-v4-72b` | UGI top of board for compliance | `sao10k/l3.3-euryale-70b`, `thedrummer/cydonia-24b-v4.1` |
| **Local (RTX 3060 12GB class)** | `thedrummer/unslopnemo-12b` (1M ctx, $0.0004/M), `anthracite-org/magnum-v4-12b` | Magnum v4 12B is the current Nemo-family RP default | `Sao10K/Llama-3.1-8B-Stheno-v3.4`, `koboldcpp/mini-magnum-12b-v1.1` |

**Note on classic finetunes:** Miqu (Midnight-Miqu-70B) and the original Euryale lines are now 2024-era. Euryale lives on as **`sao10k/l3.3-euryale-70b`** (131K ctx, $0.65/$0.75). Magnum v4 (12B and 72B) is the current Nemo-family successor. `gryphe/mythomax-l2-13b` still exists but at 8K ctx it is unusable for modern chat.

---

## (c) Sampling / preset control matrix

### c.1 Support matrix

`Y` = accepted · `~` = accepted but deprecated/rejected on newer models · `–` = not accepted (silently dropped or 400)

| Parameter | llama.cpp | KoboldCpp | OpenRouter | OpenAI | Anthropic | Gemini | vLLM |
|---|---|---|---|---|---|---|---|
| temperature | Y | Y | Y | Y | **~** (only `1.0` on models after Opus 4.6; else 400) | Y (0–2) | Y |
| min-p | Y | Y | **Y** | – | – | – | Y |
| top-p | Y | Y | Y | Y | ~ (≥0.99 only) | Y | Y |
| top-k | Y | Y | **Y** | – | ~ (any value → 400) | Y | Y |
| top-a | – | Y | **Y** | – | – | – | – |
| typical-p | Y | Y | – | – | – | – | – |
| tfs | – | Y | – | – | – | – | – |
| **DRY** (mult/base/allowed-len/breakers/range) | **Y** | **Y** | – | – | – | – | – |
| **XTC** (probability/threshold) | **Y** | **Y** | – | – | – | – | – |
| repetition penalty | Y | Y | Y | – | – | – | Y |
| frequency penalty | Y | Y | Y | Y | – | Y | Y |
| presence penalty | Y | Y | Y | Y | – | Y | Y |
| no-repeat-ngram | **–** | – | – | – | – | – | – |
| mirostat (mode/tau/eta) | Y | Y | – | – | – | – | – |
| max tokens | Y | Y | Y | Y | Y (**required**) | Y | Y |
| seed | Y | Y | Y | Y (beta) | – | Y | Y |
| stop strings | Y | Y | Y | Y (max 4; not on o3/o4-mini) | Y | Y (max 5) | Y |
| logit bias | Y | Y (≤16 entries) | Y | Y | – | – | – |
| **sampler ORDER** | **Y** (`--samplers`) | **Y** (`sampler_order`) | – | – | – | – | – |
| dynamic temperature | Y | Y | – | – | – | – | – |
| top-n-sigma | Y | Y (`nsigma`) | – | – | – | – | – |

### c.2 The DRY/XTC reality — this is the design-critical finding

**DRY and XTC are logits processors.** They need the full next-token distribution at every step, so they must run where the logits live. Both were authored as PRs to oobabooga/text-generation-webui (DRY: PR #5677, merged 2024-05-20; XTC: PR #6335, merged 2024-09-28) and ported into llama.cpp's sampler chain.

**SillyTavern is a thin configurator, not a sampler.** Verified in source (`public/scripts/textgen-settings.js`): ST holds DRY/XTC as settings and **forwards them as request parameters** to Text-Completion backends — it implements no logits math itself. `src/endpoints/backends/chat-completions.js` contains **zero** `xtc`/`dry_` references. So **for cloud models ST can only pass DRY/XTC if the provider accepts them — and no cloud provider does.**

**Consequence for this app:** DRY and XTC are **local-backend-only features**. Do not build them for cloud providers — it would be a lie, because OpenRouter silently drops them. Either gate the DRY/XTC UI to llama.cpp/KoboldCpp, or omit it. A browser cannot compute them (no raw logits stream from any hosted API).

### c.3 OpenRouter parameter mechanics a client must encode

- **Exact keys:** `temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `min_p`, `top_a`, `seed`, `max_tokens`, `max_completion_tokens`, `logit_bias`, `logprobs`, `top_logprobs`, `stop`, `response_format`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `reasoning_effort`, `verbosity`. **No DRY, no XTC, no tfs, no typical-p, no mirostat.**
- **Silent drops:** *"If the chosen model doesn't support a request parameter … then the parameter is ignored."* Set `provider.require_parameters: true` to refuse routing to providers that would drop your params.
- **Absent ≠ default:** *"When a sampling parameter is absent from your request, OpenRouter omits it upstream rather than substituting a hardcoded value."* Explicitly sending `temperature: 1.0` differs from omitting it (and can affect provider cache keys).
- **Query capability:** `GET /api/v1/models?supported_parameters=<p>`; each model object carries `supported_parameters: string[]`. **Grey out unsupported sliders rather than silently dropping.**
- **Reasoning models:** `max_tokens` covers reasoning + visible output on most providers; a small value can be entirely consumed by reasoning, returning `finish_reason: "length"` with empty content.

### c.4 Backend quirks to encode

- **Anthropic:** `temperature`/`top_p`/`top_k` are all **deprecated**; models after Claude Opus 4.6 reject non-1.0 temperature with a 400. `top_k` → 400 for any value; `top_p` must be ≥0.99. SillyTavern already deletes them in adaptive-thinking mode.
- **Gemini:** models running nucleus sampling **reject `topK`** (an empty `topK` field on the model signals this). No `repetition_penalty`, no `logit_bias`.
- **llama.cpp:** server default sampler order puts `temperature` **last**; always send an explicit `samplers` array. **Mirostat silently disables top-k/nucleus/typical** — warn in UI. Setting `--tools`/`--agent` **forces `--cors-origins` to `localhost`**, breaking LAN.
- **KoboldCpp:** `sampler_order` must be a permutation of the first N non-negative ints (N≥6); `logit_bias` capped at 16 entries; enabling DRY/mirostat/XTC/nsigma **disables continuous batching** (perf cliff).
- **vLLM:** `top_k`/`min_p`/`repetition_penalty` go via `extra_body`; the model repo's `generation_config.json` **overrides your defaults** unless `--generation-config vllm`.
- **`no-repeat-ngram` is dead** — it exists only in oobabooga/text-generation-webui. No target backend accepts it. **Omit it.**

---

## (d) AI Horde as a free tier

**What it is:** a crowdsourced volunteer GPU cluster (AGPL-3.0, public instance `aihorde.net`). Volunteers run *workers*; middleware does kudos-weighted queuing.

**Auth:** a plain **`apikey` HTTP header** (not Bearer). Three tiers — anonymous key literally `0000000000` (lowest priority, may be restricted under load, 0 kudos), pseudonymous registered key (unrecoverable if lost), and OAuth2 (min 25 kudos). CORS is **wide open and verified**: `ACAO: *` with `apikey` explicitly in `Allow-Headers` (server source `horde/flask.py`). **The anon key works from client-side JS with no proxy.**

**API shape — async submit + poll, no streaming:**
1. `POST /api/v2/generate/text/async` → `202` + `{id}` (request TTL **20 minutes**)
2. `GET /api/v2/generate/text/status/{id}` → `finished`/`processing`/`waiting`/`done`/`is_possible` + a `generations[]` array with **partial results while still running**
3. `DELETE .../status/{id}` cancels

**Streaming: none.** `swagger.json` contains no `stream`, `text/event-stream`, or `/stream` anywhere; the official OpenAI-compat shim documents *"No tools, functions, seed, or streaming."* Server caches status for **1 second**, so polling faster is pointless. Webhooks exist but fire per *completed job*, not per token.

**Queue realities (live snapshot 2026-09-29):** no SLA. Per-model `eta` ranged **0–804 s**; popular RP models carried thousands of queued tokens (`L3-Super-Nova-RP-8B` eta 276; `Angelic_Eclipse-12B` eta 202). Anon requests can time out.

**Fleet quality:** still dominated by small community/uncensored RP finetunes — `koboldcpp/L3-8B-Stheno-v3.2`, `koboldcpp/L3-Super-Nova-RP-8B`, `koboldcpp/mini-magnum-12b-v1.1`, `koboldcpp/NeonMaid-12B`, `aphrodite/TheDrummer/Skyfall-31B-v4.2` (17 workers), `aphrodite/TheDrummer/Behemoth-X-123B-v2.1`, `aphrodite/DeepSeek-V4.1-Flash` (4 workers). **Mostly 0.6B–12B**, a few 31B/123B, one DeepSeek V4.1 Flash. **No frontier hosted models.**

**Limits:** Flask-Limiter **90 req/min** per IP. `max_length` (output) default 80, min 16, **max 4096**; `max_context_length` default 2048, max 1048576. No tools, no structured output, no seed via the proxy.

**Terms:** hosted/commercial use is **allowed** provided you *"give back to the AI Horde at least as much as you take out to make a profit"*; never sell/buy kudos. **Privacy:** prompts are processed on strangers' machines and workers technically can log them — needs an explicit consent toggle in a companion app.

**Verdict: viable as an optional bonus free tier, not the primary transport.** Works with zero key and zero cost from the browser; but **no token streaming** (fatal for a chat UX expecting typewriter output — you must poll ~1 Hz and diff `generations[].text`), unbounded ETA-based latency, a low quality ceiling, and a privacy disclosure requirement. Ship it labelled *"Free community tier — no key, slower, non-streaming."*

---

## (e) Token counting per provider

| Provider | Tokenizer | Exact endpoint | Client-side option |
|---|---|---|---|
| OpenAI | tiktoken: `o200k_base` (gpt-4o/5/o-series), `cl100k_base` (gpt-4/3.5) | none (usage only) | **Exact** — `tiktoken`, `js-tiktoken`, `gpt-tokenizer` |
| Anthropic | Proprietary. **Claude 4.7+ uses a newer tokenizer producing ≈30% more tokens** | `POST /v1/messages/count_tokens` | None official |
| Google Gemini | SentencePiece-family; ~4 chars/token | `models.countTokens` (**input only**) | Approximation |
| Mistral | **Tekken** (current), SentencePiece (legacy) | none public | `mistral-common` / transformers.js |
| DeepSeek | Own; ~0.3 tok/EN char, ~0.6 tok/ZH char | none public | Official offline tokenizer zip |
| Llama / Qwen | BPE / BBPE (Qwen vocab 151,646) | none public | transformers.js `AutoTokenizer` |
| **OpenRouter** | Passthrough — `architecture.tokenizer` names it | none | **No local tokenizer needed** — every response returns native `usage.prompt_tokens`/`completion_tokens`/`cost` |

**npm libraries:** `tiktoken` (1.0.22, MIT), `js-tiktoken` (pure JS), `gpt-tokenizer` (4.0.0, model metadata + pricing), `@huggingface/transformers` (4.3.0, runs ONNX/WASM in-browser), `@huggingface/tokenizers` (0.2.0, pure TS).

**Accuracy bars — two different jobs:**
1. **Budget display:** ±5–10% is invisible at per-million pricing. Exact tiktoken for OpenAI; provider count endpoint for Anthropic/Gemini when online; otherwise transformers.js with the model's own `tokenizer.json`.
2. **Context-window enforcement / truncation:** must be **conservative, never optimistic** — under-counting yields mid-conversation 400s. Add chat-template overhead (~3 tok/message + 1/name for OpenAI-style, plus the system prompt), keep a safety margin (5–10% or a fixed 256-token buffer), and **never use chars/4 for CJK** (1.5–1.8 chars/token → 2–3× more tokens than the English heuristic predicts).

**Practical architecture:** ship one exact tokenizer (tiktoken/`gpt-tokenizer` for OpenAI, `@huggingface/transformers` for Llama/Qwen/Mistral/Gemma) plus a per-family chars-per-token calibration table; offer "precise count" via Anthropic/Google endpoints when a key is present. **For OpenRouter, read `usage` from each response and accumulate — no local tokenizer needed.** Version-pin everything: Anthropic 4.7+ needs recounting, and OpenAI's encoding varies per model.

---

## Sources

CORS / providers
- https://openrouter.ai/docs/api-reference/overview · https://openrouter.ai/docs/api-reference/parameters · https://openrouter.ai/docs/api-reference/limits · https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/api/v1/models · https://openrouter.ai/collections/roleplay
- https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/ · https://github.com/anthropics/anthropic-sdk-typescript/pull/504 · https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript · https://platform.claude.com/docs/en/api/messages · https://platform.claude.com/docs/en/about-claude/pricing
- https://raw.githubusercontent.com/openai/openai-node/master/README.md · https://platform.openai.com/docs/api-reference/chat/create
- https://ai.google.dev/gemini-api/docs/libraries · https://ai.google.dev/api/generate-content
- https://docs.x.ai/overview · https://api-docs.deepseek.com/quick_start/pricing · https://api-docs.deepseek.com/ · https://docs.mistral.ai/ · https://console.groq.com/docs/models · https://inference-docs.cerebras.ai/ · https://docs.together.ai/docs/quickstart · https://www.together.ai/pricing
- https://featherless.ai/platform/inference-api · https://featherless.ai/pricing · https://infermatic.ai/docs/overview/ · https://infermatic.ai/docs/request-limits/ · https://www.arliai.com/docs/api · https://www.arliai.com/pricing
- https://docs.novelai.net/ · https://novelai.net/

Local servers / samplers
- https://docs.ollama.com/faq · https://docs.ollama.com/api/openai-compatibility · https://lmstudio.ai/docs/developer/core/server/settings · https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md · https://lite.koboldai.net/koboldcpp_api · https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/
- https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content · https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts · https://developer.chrome.com/blog/private-network-access-preflight
- https://github.com/oobabooga/text-generation-webui/pull/5677 · https://github.com/oobabooga/text-generation-webui/pull/6335 · https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/textgen-settings.js

Models / leaderboards
- https://eqbench.com/creative_writing · https://eqbench.com/ · https://huggingface.co/spaces/DontPlanToEnd/UGI-Leaderboard · https://dontplantoend-ugi-leaderboard.hf.space/
- https://modelgrep.com/best-models-for/sillytavern · https://modelgrep.com/best/roleplay · https://rpfiend.com/sillytavern-weekly-april-27-2026/
- https://huggingface.co/anthracite-org/magnum-v4-72b · https://huggingface.co/anthracite-org/magnum-v4-12b · https://openrouter.ai/sao10k/l3.1-euryale-70b · https://huggingface.co/Sao10K/L3.1-70B-Euryale-v2.2

AI Horde
- https://aihorde.net/ · https://aihorde.net/api/ · https://aihorde.net/api/swagger.json · https://aihorde.net/api/v2/status/models?type=text · https://aihorde.net/terms
- https://github.com/Haidra-Org/AI-Horde · https://github.com/Haidra-Org/AI-Horde/blob/main/FAQ.md · https://github.com/Haidra-Org/AI-Horde/blob/main/horde/flask.py · https://github.com/Haidra-Org/AI-Horde/blob/main/horde/limiter.py · https://github.com/Haidra-Org/horde-openai-proxy · https://docs.sillytavern.app/usage/api-connections/horde/

Token counting
- https://cookbook.openai.com/examples/how_to_count_tokens_with_tiktoken · https://platform.claude.com/docs/en/api/messages/count_tokens · https://ai.google.dev/api/tokens · https://github.com/mistralai/mistral-common · https://docs.cohere.com/docs/tokens-and-tokenizers · https://api-docs.deepseek.com/quick_start/token_usage/ · https://qwen.readthedocs.io/en/latest/getting_started/concepts.html · https://openrouter.ai/docs/cookbook/administration/usage-accounting
- https://www.npmjs.com/package/tiktoken · https://www.npmjs.com/package/js-tiktoken · https://www.npmjs.com/package/gpt-tokenizer · https://www.npmjs.com/package/@huggingface/transformers · https://www.npmjs.com/package/@huggingface/tokenizers
