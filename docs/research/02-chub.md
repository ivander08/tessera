# chub.ai (Chub Venus) — incumbent teardown

All observations verified 2026-09-29 unless dated otherwise. Live probes: `gateway.chub.ai/openapi.json`, `*.chub.ai/v1/models`, iTunes lookup API, `lfs.charhub.io` HEAD, Arctic-Shift Reddit archive (reddit.com is DNS-sinkholed on this host; `api.pullpush.io` rate-limited me out).

## 1. Feature inventory

**Identity.** chub.ai = CharacterHub; `venus.chub.ai` is now the *same SPA* as `chub.ai` (merged May 2024). `chub.ai/mars`, `/subscription`, `venus.chub.ai/subscription` all render the identical React bundle (`/assets/index-20260628T001015484Z-CjxWEnYX.js`). Legacy `characterhub.org` deprecated.

**Character hub.** Repository + chat frontend. Observed live counts: `GET /api/gallery` → `count: 486495`; `POST /tags` → NSFW tag 489,849 projects / 179,639 followers. Public/unlisted/private visibility; forking (`/api/project/{id}/fork/v2`); ratings; follows; badges; atproto/Bluesky identity (`/atproto/{username}`). Character definitions are **never hidden** (by design — see unofficial FAQ).

**Chat client.** Chat *trees* with full branching (they claim no other frontend has this), swipes, impersonate, personas, model-specific presets (public/unlisted/private), themes, chat export to JSONL (SillyTavern) / PNG / text, shared public chats + comments, multi-character chats, multi-user ("Go Live", subscriber-only hosting) and live voice chat (`/live/voice`).

**Memory.** Manual or AI-generated "Chat Memory" summary, Aisu-AutoSummarizer-style — only messages that have fallen *out of context* are summarized. Plus RAG: `POST /api/core/extensions/context` = "Get semantically related messages from earlier in the chat"; `POST /lore` = "Make a RAG lore request". No vector-DB user control, no memory editor beyond the summary box.

**Lorebooks.** Keyword-triggered entries: scan depth, token budget, recursive scanning, secondary keywords + selective logic (AND/OR/NOT), insertion order, priority, constant, probability %, case sensitivity. "Characterbooks" attach to cards (needs V2 spec). Repo at `chub.ai/lorebooks`.

**Stages (extensions).** Third-party iframe apps (expression packs, mini-games, custom prompt handling). Sandboxed, per-stage subdomain, no cookie/localStorage access to chub, "Verified" badge. Templates: `github.com/CharHubAI/stage-template`, `chub-stages-ts` (pushed 2025-10-02), `rpg-example-stage`.

**Image/AV generation ("Imagine").** Endpoints: `/images/text2img`, `/img2img`, `/inpaint`, `/images/removebg_mask`, `/images/upscale`, `/images/animate`, `/images/expressions` (sprite packs), `/video`, `/music`, `/foley`, `/model3d`, `/imagine` (unified), `/imagine/check`. Credit costs from live `GET /images/costs`: text2img/img2img/inpaint/upscale/tts/stt/voice_clone = 25, expressions/model3d/imagine/generate = 50, video/video2video = 100, background/removebg = 5, llm/prompt/completions = 1.

**Voice.** `/tts`, `/stt`, `/voice_clone`, `/voices`, `/voices/{id}` (delete), plus live voice chat.

**Inference API.** `gateway.chub.ai` (also `api.chub.ai`, branded **Rostro**; `mars.chub.ai`, `mercury.chub.ai`, `inference.chub.ai` serve a separate "Hub API"). OpenAI-compatible: `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/chub/{model}/v1/…`, `/{model}/v1/…`, plus `/prompt`. Models from live `/v1/models`: `soji, asha, mixtral, mistral, mythomax, mobile, testing`.

**Rostro.** `r.chub.ai` is a *separate commercial product* (Rostro, WY LLC): unified API for text/image/audio/video/3D, "Sane Pricing" — Minimal $5/mo (<20B LLMs, limited AV), Full $20/mo (everything), Enterprise (per-seat + usage, stable API for agents, on-prem).

## 2. Business model

| Tier | Price | Contents |
|---|---|---|
| Free | $0 | **20 messages/day**; free "mobile" A/B model; trial credits (`trial_remaining: 10` observed anonymously) |
| Mercury | $5/mo | Models <20B (mythomax 13B, mistral 7B), 600 media credits, 2× Asha/Mixtral, API key |
| Mars | $20/mo | All LLMs incl. Soji, unlimited TTS + multimedia, early access, API key |
| Enterprise | contact | per-seat/usage, on-prem |

Free tier was 300 msg/day at app launch (Apr 2024), then 200, cut to **20/day around 2026-06-29** — the single biggest community flashpoint. **Crypto-only payments** (chub.ai/subscription: "Why Crypto-Only?" — card processors are the censorship vector; one user report shows billing routed through Rostro). **No refunds** (ToS). Gating: "Unlimited for a single user, similar to Netflix. Concurrent requests from the same account will return a 429." Key-sharing detection is heuristic (device-count/24h usage). Chub docs still describe Mars as "$20 a month with unlimited messaging".

**API proxy billing.** Subscription-gated, *not* metered per token. ToS logs only metadata per inference: "a unique identifier, your user id, the time of inference, the input length, the output length, the model used, **an approximate charge were it to be metered** based on token usage, the number of milliseconds taken." No input/output content is logged. Media is credit-metered.

## 3. Mobile app

- **Android**: no Play Store listing (`play.google.com/store/apps/details?id=ai.chub.app` → 404; Play search returns no Chub app). Sideload APK is **still live**: `HEAD https://lfs.charhub.io/android/latest/app-release-aligned.apk` → `200`, `application/vnd.android.package-archive`, 14,868,570 bytes, `Last-Modified: Tue, 09 Sep 2025` → **~12 months stale**.
- **iOS**: dead. App Store ID `6478348543` (from the launch post) returns `resultCount: 0` in **every** storefront queried (us, jp, gb, ca, de, au, nl, se) → pulled. `apps.apple.com/us/app/chub-ai/id6478348543` → "can't be found". Beware impostor `id6754865125` ("CHUB", `com.app.chub`, seller Abdul Rafeeque Parakkal) — an unrelated EdTech app.
- Launch post: r/Chub_AI "The app is live." (2024-04-19, score 214) with the APK link and the "mobile model free for 300 messages/day" announcement. iOS was always degraded (no OpenAI/Anthropic/OpenRouter, NSFL hidden, NSFW blurred).
- Reviews: no accessible store rating (listing gone). Aggregators (`appshunter.io`, `appbrain`) are Cloudflare-blocked. Trustpilot: **3.4/5 from 3 reviews** (unclaimed profile) — the one 1-star (2026-07-06) is "Shit update… only be able to pay with crypto and the fact that the $5 a month subscription is gone".
- Complaints: keyboard covering input on One UI 7; ~90 s per reply after an Oct-2025 update; lorebook not persisting in-app; "Missing Authentication Header" when using proxies on mobile web (2026-09-27); mobile model errors.

## 4. Complaints — and what "bad caching rate" actually means

**Answer: it is prompt-cache hit rate on the user's BYOK provider, not Chub's own cache.** Users point Chub at OpenRouter/DeepSeek; input tokens are billed ~100× more on a cache *miss* than a hit, so cache hit rate dominates cost.

The canonical thread is r/Chub_AI **"Low cache rates"** (2026-07-15, score 6) — *"Why are my cache rates so low. I use Deepseek v4 flash and deepinfra as my only provider."* Findings in that thread:

- **Provider routing destroys caching.** OpenRouter routes across providers; each has its own cache; swapping providers = cache miss. `u/DShad27x`: "Cache only last 5 minutes. You can't edit your system prompts or character definitions either. Can't be switching providers too, select one provider you want and stay with it." Also "This also makes sure you hit cache which is about a 60% discount per reply. You don't hit cache if swapping providers."
- **Provider quality varies wildly.** `u/fire2burn`: "Deepseek (official provider) scores highest with a **cache rate of 84%** whereas DeepInfra consistently ranks amongst the worst providers with an **average cache hit rate of just 18.1%**" (screenshot `ibb.co/hJr43y9R`). `u/Impressive-Bug4699`: DeepInfra/Novita "prompt caching isn't nearly as efficient as DeepSeek's official API because they operate with fewer/coarser cache blocks."
- **Roleplay is cache-hostile.** `u/KeeganY_SR-UVB76`: "Since you're using it for roleplaying it's not likely you'd get it to cache anyway." 5-minute TTL + edits to system prompt/definitions/older replies invalidate everything.
- **Chub's own client may be part of the problem.** `u/fibal81080` (thread 1ux2wgi): "chub's 3rd party support is really dodgy anyway, it seems like it sends prompts not fully" — i.e. Chub's proxy/client reportedly doesn't send the prompt intact, hurting cacheability.
- Concrete prices cited: DS V4 Pro cache-hit **$0.0036/M**; DeepSeek official cache-hit input **$0.0028/M**; DS raised peak-hour cache-hit input by **+1,114%** for V4 Pro (r/Chub_AI "Deepseek Updated Pricing", 2026-08-13).

**Chub's *own* caching rollout broke Soji.** r/Chub_AI moderator `u/YukiiSuue`, twice: *"Lore added caching, and it might have messed something up. He's aware and investigating. No ETA."* (2026-05-05, thread 1t3id3q; 2026-05-06, thread 1t529kb). This coincides with the Soji quality collapse: word salad and random Chinese/Japanese tokens, positivity bias ("everyone is the morality police"), repetition, degradation after 35-70 replies, refusal past ~300 messages. A 24-upvote thread, "What's going on with Soji?", is entirely this.

**Cache-correlated context bleed** — "Bot pulling old conversation from deleted chat" (2026-04-02), "bot will consistently act as they were in my last chat, as if their memory is stuck" (2026-01-26) — points at shared server-side session/cache state.

**Latency/reliability.** 20-message limit + non-refunding errors: *"I manage to get two messages in before hitting the limit due to API errors. These errors should refund your token"* (score 46, 2026-07-15). Constant 500s/axios errors and outages; the **blue-screen bug** (Jan 2026, score 36) — chub served `index-*.js` as `text/html`, breaking all Chromium/WebKit browsers; dev silence is a recurring theme ("this lore guy (developer) apparently is a ghost").

**Trust/comms.** Crypto-only + 20/day + model nerfing + non-communication → exodus threads ("Chub alternatives?", "Greatest Loss", "Appeal to Free and Paid Users").

## 5. Public API for third-party clients — yes, and it's large

`https://gateway.chub.ai/docs` (Swagger UI), spec at `/openapi.json`. **"Chub API" v0.2.0, 197 paths.** Info block: `description: "Commercial use requires prior authorization"`, `termsOfService: https://chub.ai/tos`, contact `lore@chub.ai`.

**Auth** — three `apiKey`-in-header schemes: `CH-API-KEY`, `Authorization`, `samwise`. Anonymous access works for public read endpoints: I got `200` unauthenticated on `/tags`, `/api/gallery`, `/api/self`, `/api/badges`, `/v1/models`, `/images/costs`. Inference and all user-scoped calls need a key.

**Key management**: `/api/account/tokens` (create inference token), `/account/tokens/projects`, `/api/account/tokens/core`, `/api/account/token/{token_id}` (revoke).

**Third-party UI support is officially documented**: `docs.chub.ai/docs/inference-api/usage-with-third-party-uis` — "The Mars and Mercury APIs can be used in the same way as an OpenAI reverse proxy, and are compatible with any UI that supports them," with screenshots for SillyTavern, Agnaistic, Risu, Base Tavern, Kobold Lite. Base URLs: `https://mars.chub.ai/v1` and `https://mercury.chub.ai/v1`.

**Rate limits**: none documented and none in response headers. The only stated limit is concurrency (429) and abuse heuristics. Anonymous sessions do get a `trial_remaining` counter.

**CORS is the practical blocker**: responses carry `access-control-allow-origin: https://chub.ai`. A third-party *browser* client cannot call the gateway directly; it needs a server-side proxy. CharHub themselves publish `github.com/CharHubAI/proxy` (26★, MIT, last push 2024-10-29): "OpenAI and Anthropic Simple Proxy (for stripping headers and bypassing CORS restrictions)" — i.e. the intended pattern for third-party clients is a proxy of your own.

**ToS constraints**: UGC is personal/non-commercial only; "no part of the Services and no Content or Marks may be copied, reproduced, aggregated, republished, uploaded, posted, publicly displayed, encoded, translated, transmitted, distributed, sold, licensed, or otherwise exploited for any commercial purpose whatsoever, without our express prior written permission" → write to `lore@chub.ai`. OpenAPI repeats "Commercial use requires prior authorization."

## 6. Upstream backends

**Chub-hosted (Mars/Mercury)**: `soji` (671B DeepSeek-V3-0324 finetune, launched at 60K ctx — later reported dropped to ~30K), `asha` (70B), `mixtral` (8×7B MoE), `mistral` (7B/12B), `mythomax` (13B), `mobile` (free, A/B test), `testing`. Self-hosted, "finetuned on public datasets as well as our own proprietary data… does NOT include public or private chats."

**BYOK passthrough in the client** (docs.chub.ai/docs/the-basics/api-connections): OpenAI, Anthropic, Google, OpenRouter, NovelAI, Kobold/Ooba. Chub explicitly *discourages* third-party reverse proxies for security, while itself operating one.

**Why this shapes caching/billing:** self-hosted models mean Chub controls its own KV/prompt cache (hence "Lore added caching" as a single global switch), and subscribers never see per-token billing. All "cache rate" pain is on the BYOK path, where OpenRouter's multi-provider routing silently breaks prefix caching — a design flaw a competitor can attack directly by pinning providers, exposing cache-hit telemetry, and keeping the prompt prefix stable.

## Competitive openings (from the evidence)

1. **Cache transparency + control** — per-provider pinning, hit-rate display, prefix stability guarantees. Nobody in this space does this; users are reverse-engineering it from OpenRouter's UI.
2. **Quota that doesn't punish errors** — errors currently consume the 20/day allowance.
3. **Card/preset/chat portability** — export exists (JSONL/PNG), import is partial; definitions can't be hidden, so the library is effectively open.
4. **Mobile is abandoned** — a maintained cross-platform client is a free win.
5. **Dev communication** — the loudest complaint is silence, not features.
6. **FOSS community goodwill** — `CharHubAI` org has only ~76 stars total across 9 repos, all but one stale since 2025.

## Sources

- https://chub.ai/subscription (rendered) · https://chub.ai/mars · https://venus.chub.ai/subscription · https://chub.ai/
- https://docs.chub.ai/docs/llms.txt · /docs/the-basics/api-connections · /docs/the-basics/just-chatting · /docs/advanced-setups/lorebooks · /docs/stages/overview · /docs/inference-api/usage-with-third-party-uis · /docs/patch-notes/0.5.7
- https://gateway.chub.ai/docs · https://gateway.chub.ai/openapi.json · https://api.chub.ai/docs · https://inference.chub.ai/docs · https://mars.chub.ai/docs · https://mercury.chub.ai/docs
- https://r.chub.ai/ · https://r.chub.ai/pricing
- https://www.chub.ai/tos · https://www.chub.ai/privacy
- https://status.chub.ai/
- https://lfs.charhub.io/android/latest/app-release-aligned.apk
- https://itunes.apple.com/lookup?id=6478348543 · https://apps.apple.com/us/app/chub-ai/id6478348543 · https://apps.apple.com/us/app/chub/id6754865125
- https://play.google.com/store/apps/details?id=ai.chub.app
- https://www.trustpilot.com/review/chub.ai · https://realreviews.io/reviews/chub.ai
- https://theunofficialguidetochubai.wordpress.com/faq/ · /2024/12/12/mars-mercury-2/ · /2024/12/12/use-mars-mercury-on-sillytavern/
- https://chubai.io/ (unofficial info, updated 2026-07-12)
- reddit.com/r/Chub_AI/comments/1ux2wgi (Low cache rates) · /1v6bago (Good api?) · /1vw6fzz (Best provider for Deepseek v4) · /1t3id3q (What's going on with Soji?) · /1t529kb (Soji) · /1ppjrfx (A question about Soji) · /1tcjrgb (U-shaped attention) · /1ux9hm1 (20 daily messages + API errors) · /1uk3wmm (Appeal to Free and Paid Users) · /1unliw2 · /1uo9ynv · /1us5ld6 · /1v55tjo · /1ujk3q0 · /1vlxa2d · /1uhxxex · /1c88gs1 (The app is live) · /1qczlls (JS MIME bug) · /1wraaq3 (mobile unusable) · /1nwhlnp · /1rhqxvi · /1vn9oqk (Deepseek pricing)
- https://github.com/CharHubAI/proxy · https://github.com/CharHubAI/stage-template
- https://arctic-shift.photon-reddit.com/api (Reddit archive used for all r/Chub_AI bodies; reddit.com unreachable from this host)
