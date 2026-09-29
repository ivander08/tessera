# Prompt Caching, Cost & Latency Engineering for a BYOK Roleplay Client

Research date: **2026-09-29**. All prices per 1M tokens unless noted. Provider docs read directly on
this date; version-sensitive claims are flagged.

---

## 0. TL;DR for the design doc

1. **Every major provider caches only the exact token prefix, from token 0.** Even Anthropic/Qwen
   breakpoints and OpenAI explicit mode are *prefix* breakpoints — a breakpoint marks the **end** of a
   cacheable prefix, not an isolated region.
2. Therefore the whole game is: **keep the first N tokens byte-identical across turns.** Everything
   else (memory, lorebook, state, timestamps) must be *appended*, never injected into the prefix.
3. Chat frontends fail at this for four structural reasons: dynamic content in the system prompt,
   per-turn lorebook activation reordering the prefix, sliding-window truncation that drops the
   *oldest* messages, and non-deterministic serialization. There is now **measured** evidence for
   exactly this in a roleplay app (§6.3): hit rate 46.5% vs a competitor's 91.5%, and a single
   timestamp line taking a hit rate from 91% to **0%**.
4. The "important info last" advice and cache-maximisation **do conflict**, but the conflict is
   smaller than it looks — see §4.4. In the cache-optimal layout, both the head and the tail get the
   attention benefit and only the boring middle is sacrificed.
5. **Design consequence:** treat the request as a *prefix-stable append-only log* with a small,
   explicitly-ordered volatile tail. This is the highest-leverage architectural decision in the app,
   and it is expensive to retrofit.

---

## 1. Provider cache mechanics (as of 2026-09)

### 1.1 Summary table

| Provider | Activation | Min cacheable | TTL | Write mult. | Read mult. | Usage fields |
|---|---|---|---|---|---|---|
| **Anthropic** | explicit `cache_control` block breakpoints (≤4) **or** automatic (top-level `cache_control`) | 512 / 1024 / 2048 / 4096 by model — §1.2 | 5 min default (refreshed free on hit); `"ttl":"1h"` option | 1.25× (5m), 2× (1h) | **0.1×** (0.05× Opus 5.5; 0.025× Fable 5.1 / Mythos 5.1) | `usage.cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`; split in `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` |
| **OpenAI** | automatic on all supported models; explicit `prompt_cache_breakpoint` + `prompt_cache_options` on GPT-5.6+ | 1024 (GPT-5.6+); varies by request settings earlier | `prompt_cache_options.ttl:"30m"` (GPT-5.6+, default); earlier `prompt_cache_retention` = `in_memory` (~5–10 min) or `24h` | 0 (pre-5.6); **1.25×** (5.6+) | **0.1×** (GPT-5.6+, per OpenAI pricing); 0.25×/0.5× on earlier models | `usage.input_tokens_details.cached_tokens` / `.cache_write_tokens` (Responses); `usage.prompt_tokens_details.*` (Chat Completions) |
| **Gemini** (AI Studio) | implicit (auto, 2.5+); explicit `cachedContents` objects | **4096** (Gemini 3.x); 2048 (Gemini 2.5 Flash/Pro) | implicit ~3–5 min; explicit default 1 h, configurable | implicit none; explicit input price **+ storage $0.50/1M tok/hr** → $1.00 from 2027-01-01 | **0.25×** | `usage.total_cached_tokens` (Interactions API); `usage_metadata.cached_content_token_count` (legacy) |
| **DeepSeek** | automatic "Context Caching on Disk"; no code change | **64 tokens** (storage unit) | hours to days; "best effort" | same as input | **0.1×** ($0.003 vs $0.15 off-peak Flash; $0.022 vs $0.66 off-peak Pro) | `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| **Grok** (xAI) | automatic; sticky routing via `x-grok-conv-id` header or `prompt_cache_key` | not published | not published; evictable | **0** | **0.25×** ($0.50 vs $2.00 grok-4.7 <200k; $0.30 vs $2.00 grok-4.5) | `usage.prompt_tokens_details.cached_tokens`; Responses `input_tokens_details.cached_tokens`; gRPC `cached_prompt_text_tokens` |
| **Mistral** | automatic prefix cache; `prompt_cache_key` improves routing | 64-token cache blocks | not published | **0** | **0.1×** | `usage.prompt_tokens_details.cached_tokens` |
| **Qwen / Alibaba Model Studio** | explicit `cache_control` (≤4 markers) **or** implicit (auto, cannot be disabled) | **1024** both | explicit 5 min (resets on hit); implicit indeterminate | explicit 1.25×; implicit 1.0× | explicit **0.1×**; implicit **0.2×** | `usage.prompt_tokens_details.cache_creation_input_tokens` / `.cached_tokens` |
| **Groq** | automatic | not published | 2 h idle | 0 | **0.5×** | gpt-oss models only at this date |
| **Z.AI / GLM** | automatic | not published | not published | free (limited-time promo) | ~**0.2×** | `prompt_tokens_details.cached_tokens` |
| **Moonshot / Kimi** | automatic | not published | not published | 0 | **0.25×** | — |

**Conflicts between sources, flagged.** OpenRouter's blog states OpenAI reads at 0.25×–0.50× while
OpenAI's own pricing page lists **0.1×** for GPT-5.6+; the OpenRouter figure matches OpenAI's *older*
models. OpenRouter's minimum-token table lists Gemini 2.5 Flash at 1024 while Google's own docs say
**2048** (Google's page is the primary source; OpenRouter's table is likely stale). Prefer the
provider's own docs and re-verify before hardcoding.

### 1.2 Anthropic detail (the one that matters most for chat)

- Cache hierarchy is **`tools` → `system` → `messages`**. Changing anything at a level invalidates that
  level *and everything after it*.
- **Cache writes happen only at breakpoints.** A later request's lookback walks *backwards* at most
  **20 blocks** looking for an entry a *previous* request wrote. It does not "find stable content behind
  your breakpoint and cache it".
  → If your only breakpoint sits on a block containing a timestamp, you pay a cache **write on every
  request** and never get a read. This is Anthropic's own headline "common mistake".
- **Automatic caching** (top-level `cache_control`) places the breakpoint on the *last cacheable block*
  and advances it each turn. Same trap: if your last block is the dynamic user message, the breakpoint
  lands on volatile content. Anthropic says to use an explicit breakpoint on the static prefix instead.
- Minimum cacheable lengths (2026-09): **512** for Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5;
  **1024** for Opus 4.8, Sonnet 5, Sonnet 4.6/4.5, Opus 4.1, Opus 4, Sonnet 4; **2048** for Opus 4.7 and
  Haiku 3.5; **4096** for Opus 4.6/4.5 and Haiku 4.5. Below the minimum you get *no caching and no
  error* — detect it as `cache_creation_input_tokens == 0 && cache_read_input_tokens == 0`.
- TTL is measured **from the start of the request that writes/reads**, not from the end of the
  response. A 4-minute streamed reply eats most of a 5-minute TTL.
- 5m and 1h entries can be mixed, but **longer TTL must come first**. Billing is computed over positions
  A (highest hit), B (highest 1h breakpoint after A), C (last breakpoint): reads for A, 1h writes for
  (B−A), 5m writes for (C−B).
- **Cache hits do not count against rate limits** — an argument for 1h TTL on long sessions.
- **Pre-warming**: `max_tokens: 0` with an explicit breakpoint on the shared prefix reads the prompt
  into the model, writes the cache, and returns immediately. Charges a cache write, zero output tokens.
  Directly usable: warm the character card + system prompt on character-select, before the user types.
- **Mid-conversation system messages** (Fable 5.1, Mythos 5.1, Opus 5.5, Opus 4.8, Opus 5, Sonnet 5.5 —
  *not* Sonnet 5) let you append `{"role":"system"}` into `messages` instead of editing the top-level
  `system` field, keeping the cached prefix intact. Same for `tool_addition`/`tool_removal` blocks (beta
  `inline-tools-2026-09-15`). **This is the mechanism for mid-scene director notes on Anthropic models.**
- **Cache diagnostics** (GA, Claude API only — not Bedrock/Vertex): pass
  `diagnostics.previous_message_id` and the API returns `cache_miss_reason.type` ∈ {`model_changed`,
  `system_changed`, `tools_changed`, `messages_changed`, `previous_message_not_found`, `unavailable`}
  plus `cache_missed_input_tokens`. Fingerprints are hashes + token counts only, ZDR-eligible.
- Anthropic's own Claude Code team treats cache hit rate as an **SLO**: *"we run alerts on our prompt
  cache hit rate and declare SEVs if they're too low."*

### 1.3 OpenAI detail

- The cache stores **KV tensors, not tokens**; the full rendered context is cached, including hidden
  system content, tool definitions, and images.
- Cache location is **per-machine**; routing depends on load and a hash of the initial tokens after
  hidden content, plus `prompt_cache_key`. On models before GPT-5.6 the key is *needed* to optimise
  routing; on 5.6+ it is only for separate cache accounting. Busy-group guidance: ~**15 requests/min per key**.
- Explicit mode (`prompt_cache_options.mode:"explicit"`) **disables** automatic breakpoints. With no
  `prompt_cache_breakpoint` marked, the request is billed at plain input rate with no cache write —
  which is also the documented way to **turn caching off** for one-off prompts ≥1024 tokens.
- Up to **4 cache writes per request**. GPT-5.6+ lookup boundaries: first 2 and latest 50 explicit
  breakpoints, plus (implicit mode) the implicit breakpoint, up to 20 earlier eligible message endings,
  and the end of the initial consecutive developer-message block.
- **Gotchas worth encoding as tests:**
  - A shared prefix is not automatically a cached prefix: with only an implicit breakpoint the write
    extends through the dynamic suffix, so a shorter shared prefix is never reusable.
  - Switching implicit → explicit-only loses the previously-written implicit entry.
  - **Extending a message** (appending to an existing user message) moves the old implicit endpoint
    *inside* a message and loses the prefix. Append a new message instead.
  - Compaction changes the prefix and reduces reuse — but may still lower total cost.
- Published reference points: a single-turn LLM-judge deployment reported **~70%** token cache-hit rate;
  a multi-turn agent with per-tool-result explicit breakpoints reported **>90%**. Both hedged as illustrative.
- **Minimum-cacheable-length cost trap**, with formula: M=1024, r=0.1, w=1.25 → break-even original
  prefix `102.4 + 1177.6/N`. Across 10 requests, expanding a 221-token prefix to 1024 is cheaper; a
  102-token prefix never benefits at any N.

### 1.4 Gemini detail

- Implicit caching is on by default for Gemini 2.5+ and **cannot be disabled**; savings pass through.
  **No write cost, no storage cost**, ~3–5 min TTL. Cheapest provider to be cache-*sloppy* with — but
  the 4096-token minimum for Gemini 3.x is the highest of the majors.
- Explicit caching (`cachedContents`) bills storage at **$0.50 per 1M tokens per hour** through
  2026-12-31, doubling to **$1.00** on 2027-01-01. 100k tokens cached 8 h = $0.40/day, doubling next year.
- On OpenRouter, Gemini's `systemInstruction` is **immutable** — `cache_control` inside the first
  system/developer message caches the normalised system prompt but **cannot preserve an uncached dynamic
  tail inside that same message**. Dynamic content must go in a later `user` message.
- Only the **last** `cache_control` breakpoint is used for Gemini on OpenRouter.

### 1.5 DeepSeek detail (best cost/latency profile for RP)

- Prefix units are persisted at: **end of user input**, **end of model output**, **detected common
  prefixes across requests**, plus fixed token intervals for long inputs.
- A hit requires matching a *complete* persisted unit. `A+B` then `A+C` does **not** hit on `A+B` — but
  after those two requests the system persists `A` as a unit, and a third request `A+D` hits on `A`.
  **Practical consequence: hit rate ramps over the first few turns of a scene and after any prefix
  change. Do not judge hit rate from the first two turns.**
- 64-token storage granularity; sub-64-token content never caches.
- DeepSeek's own launch note names **"Role-play with extensive character settings and multi-turn
  conversations"** as a headline beneficial scenario, and reports first-token latency on a 128K prompt
  dropping from **13 s to 500 ms** on a hit. For a companion app the latency win matters more than the cost win.
- Off-peak pricing is **half** peak: peak = 01:00–04:00 and 06:00–10:00 UTC Mon–Fri excluding Chinese
  holidays. A client could surface "wait 20 minutes to save 50%".
- **Independent benchmark (Olaf Dsouza, 2026-09-02):** across 18 providers serving DeepSeek V4 Flash, the
  *same* 155-request / 19.5M-token agent session cost **$0.13 to $2.30 — a 17.7× spread** driven almost
  entirely by cache hit rate. 11 of 18 cached 94–99% (theoretical ceiling 98.8%); the tail was
  DigitalOcean 75.2%, Parasail 60.6%, Wafer 55.0%, OpenInference 7.7%. **DeepSeek ranked 21st of 30 by
  list price but 2nd cheapest in practice**, and was **the only provider still warm after 45 minutes**;
  most evicted within 1–15 minutes. A small hit-rate drop multiplies full-price tokens fast: 99% → 195k
  full-price tokens on that session, 98% → 390k, 96% → 780k, 92% → 1.6M.

### 1.6 The rest, briefly

- **Grok**: cache works from the start of the messages array; per-server cache makes `x-grok-conv-id`
  (or `prompt_cache_key` on Responses) the biggest lever. xAI says omitting `reasoning_content` from
  previous turns is "the top cause of cache misses" for reasoning models.
- **Mistral**: `prompt_cache_key` improves the *chance* of a hit but does not guarantee one. 64-token
  blocks → `cached_tokens` is always a multiple of 64; prompts under 64 tokens never hit.
- **Qwen**: explicit and implicit are **mutually exclusive**. Explicit supports ≤4 markers, 20-block
  backward lookback (same as Anthropic), 1024 minimum. Their docs give the best guidance on *parallel
  tool calls*: merging N separate tool messages into one multi-block tool message keeps content within
  the 20-block window. Tool definitions are cached **as part of the system message** and cannot be
  cached independently; a marker on a tool definition is ignored.
- **Groq**: 50% discount, 2 h idle TTL, gpt-oss models only at this date.

---

## 2. OpenRouter: routing, reporting, cross-provider behaviour

- **Provider sticky routing** is on by default and is the mechanism that makes OpenRouter caching work
  at all. After a request that uses caching, OpenRouter remembers the provider and routes subsequent
  requests for the same model there.
  - Activates **only when the provider's cache-read price is cheaper than regular input**, so you never
    get stuck where caching costs more.
  - Sessions **expire after 10 minutes of inactivity**; each successful request resets the timer.
  - If the sticky provider errors, the cache is not updated and the next request re-routes.
  - **Not used when you set `provider.order`** — explicit ordering wins. A UI that lets users pin a
    provider silently disables cache stickiness.
  - Granularity: account × model × conversation. Default conversation key = **hash of the first system
    (or developer) message and the first non-system message**.
  - `session_id` (body field or `x-session-id` header, ≤256 chars) overrides that. With `session_id`,
    sticky routing activates on **any successful request, before any cache hit is observed**; without
    it, stickiness only begins *after* a hit is detected. That first-request difference is the reason to
    always send a session id.
  - `prompt_cache_key` is used as the sticky key if neither is set.
- **Reporting**: every response carries `usage.prompt_tokens_details.cached_tokens` (reads) and
  `.cache_write_tokens` (only for explicit-caching models with write pricing), plus `usage.cache_discount`.
  `cost_details.upstream_inference_cost` gives raw provider cost but is **only populated for BYOK**
  requests when fetched via `/generation`.
- **Per-provider behaviour differs** and OpenRouter enumerates it: OpenAI auto (1024 min, writes free
  pre-5.6, 1.25× on 5.6+); Anthropic 1.25×/0.1×; Gemini implicit 0.25× + explicit with storage;
  DeepSeek auto 0.1×; Grok auto 0.25×; Moonshot auto 0.25×; Groq auto 0.5×; Z.AI auto ~0.2× **plus** a
  session-affinity key derived from your account + `session_id`; Alibaba **explicit only**, 1.25×/0.1×.
- OpenRouter translates breakpoints across providers: an Anthropic-style `cache_control` block becomes a
  `prompt_cache_breakpoint` when routed to a supporting OpenAI model, and vice versa. **TTLs are not
  translated** — `cache_control` `ttl` is dropped toward OpenAI; `prompt_cache_options` stays OpenAI-only.
- On Bedrock, OpenRouter converts the top-level `cache_control` into a trailing breakpoint (Bedrock's
  InvokeModel API rejects the top-level field).
- **OpenRouter's own four causes of a miss** (their words): a prompt that's too short, an expired cache,
  an opening block that keeps changing, or a request that moved to a different provider.
- **Worked cost example from OpenRouter** for a repeated 10,000-token block over 6 turns, as a multiple
  of one uncached turn: no caching 6.0×; Anthropic 5-min cache + sticky routing **1.75×**; free-write
  provider + 0.25× reads 2.25×; free-write provider + 0.5× reads 3.5×.
- **Independent evidence that OpenRouter's published cache stats mislead.** Olaf Dsouza measured the
  rank correlation between OpenRouter's published per-provider hit rate and his measured hit rate at
  **0.62 on the measurement day, falling to 0.27 against OpenRouter's Sept 1 column**; published rates
  for the same providers moved by up to **47 percentage points** in two weeks (ambient 82%→35%,
  parasail 4%→51%, atlas-cloud 85%→39%). His conclusion: *"that number is averaged over each provider's
  own production traffic… The published number mostly tells you about the provider's customers."*
  OpenRouter's **`:floor`** mode routes by list price, which ignores caching, and *"its top pick had the
  worst measured cache in the entire study."* Independent HN reports agree that provider fallback loses
  the cache and that direct-to-provider beats routed traffic for hit rate.

---

## 3. Why a chat frontend gets a low cache hit rate — concrete anti-patterns

Ordered by damage. Every one is present in SillyTavern today (§6), which is the direct explanation for
the user's complaint.

**A. Dynamic content in the system prompt.**
`{{time}}`, `{{date}}`, "Current time: 14:32", request IDs, session tokens, a "last active" marker —
anywhere in the system block. The prefix hash changes every request → **a write every request, zero
reads**. Anthropic names this its #1 common mistake; OpenAI classifies it `input_changed` with the fix
"move changing content after the reusable prefix". **Measured:** Foreverse added one line — the current
time — to their system prompt and hit rate went **91% → 0%** that evening, "thirty-plus requests at full
price." A dev.to post-mortem reports a `datetime.utcnow()` in the system prompt costing ~70% of its
cache (31% hit rate).

**B. Reordering / re-ranking anything in the prefix.**
World-info or memory entries sorted by activation order, relevance score, or insertion depth, emitted at
a position that changes per turn. Even *reordering identical entries* breaks the prefix. Same class:
sorting tool definitions, or JSON key order varying between serializations (Anthropic explicitly calls
out Swift and Go JSON dictionaries randomizing key order). Foreverse hit this as "lorebook entries
re-sorted by relevance so their order changed between turns". Anthropic's Claude Code team broke their
own ordering with "shuffling tool order definitions non-deterministically".

**C. Inserting memory / lorebook into the middle of history.**
"Inject relevant lore at depth N" *mutates* the middle of the message array. Next turn the injection
point has moved relative to the tail, so everything from there on is a fresh write. SillyTavern #5852's
exact complaint. ProjectDiscovery found their working memory / skills / runtime context sat *between*
breakpoints and *"was silently killing our cache hits"*.

**D. Sliding-window truncation that drops the oldest messages.**
Every turn the window advances: message 1 falls off, message 2 becomes first. **The prefix now starts at
a different token**, so nothing matches. The most expensive and least obvious failure — the prompt still
"looks" the same to the user. SillyTavern PR #5788 proposes an "anchor-based sawtooth": hold the oldest
included message fixed, grow by appending, truncate **in one shot** at the cap, re-anchor.

**E. Re-summarising / compacting on a schedule.**
Auto-summarisation rewrites the head of the context. Necessary for unbounded chat, but each compaction is
a full cache rebuild. OpenAI names `context_compacted`. **The trap is worse than it looks** — Claude
Code's naive compaction call used a *different system prompt and no tools*, so *"the prefixes diverge at
the very first token and none of the cache applies. You end up paying the full, uncached input rate for
the entire conversation."* Fix: "cache-safe forking" (§4.3).

**F. Vector / embedding retrieval that splices messages out of history.**
SillyTavern's chat vectorisation removes retrieved messages from the chat array and re-injects them at
depth. Issue #4260 reports the user fixed DeepSeek cache misses by deleting exactly that splice,
estimating 2–4× cost reduction. Embedding retrieval is fine; **mutating history to do it is not.**

**G. Being under the minimum cacheable length.**
A short character card + short chat can sit under 512/1024/2048/4096 tokens and silently never cache; no
error is returned. Direction of the trap matters: for providers with *no* write cost (Gemini implicit,
DeepSeek, Grok, Mistral, Groq, Z.AI) padding to the minimum is pure win; for a 1.25× write (Anthropic,
OpenAI 5.6+, Qwen explicit) it is a real trade — see the break-even formula in §1.3. Note OpenRouter
advises **against** padding with filler text.

**H. TTL expiry from human typing speed.**
A 5-minute TTL plus a user who reads a reply for six minutes means every turn is a write. This is the
most *roleplay-specific* failure — companion chat has long think-times. Measured: most providers evicted
within **1–15 minutes**; only DeepSeek survived 45+ minutes. Mitigations: 1h TTL, a keep-alive ping
(`max_tokens: 0` on Anthropic; a "." completion elsewhere), or session-sticky routing so at least the
routing stays warm.

**I. Provider/model churn.**
Model routing, A/B tests, or "latest" aliases silently changing the underlying model. Caches are
per-model. SillyTavern bug #5746: selecting `~anthropic/...latest` on OpenRouter broke caching while a
pinned version worked. Claude Code's team: switching Opus→Haiku mid-conversation *"would actually be
more expensive… because we would need to rebuild the prompt cache for Haiku."* **Pin model versions for
any conversation that wants cache hits.**

**J. Changing request-level knobs mid-conversation.**
Anthropic: `tool_choice`, presence/absence of images anywhere, thinking config, `output_config.effort`,
and the set of `anthropic-beta` headers. OpenAI: `tools`, `parallel_tool_calls`, `text.format`,
`reasoning.effort`, `text.verbosity`, `service_tier`, `prompt_cache_key`. A verbosity or thinking-budget
slider dragged mid-scene silently nukes the cache. Foreverse also hit "sampling parameters prepended to
the prompt on rerolls".

**K. `{{random}}` / non-seeded templating.**
Any macro that re-rolls per resolution. SillyTavern's `{{random}}` uses `seedrandom(..., {entropy:true})`
and re-rolls every time, whereas `{{pick}}` is deliberately seeded by chat id.

**L. Concurrent first-turn requests.**
Anthropic: a cache entry only becomes available **after the first response begins**. Firing parallel
"swipe" generations on a cold cache means N writes and zero reads.

**L2. Caching the volatile tail by accident.**
The mirror image of anti-pattern A, and the subtler one. If you let caching run "automatically" over the
*whole* context, the cache write covers dynamic content — the current scene state, retrieved lore, tool
results — that will never be reused. You then pay write overhead with no read benefit, and the
measurement shows it can be **worse than not caching at all on latency**: GPT-4o full-context caching
regressed TTFT **8.8%**, and Gemini 2.5 Pro "exclude tool results" regressed **2.9%** (Lumer et al., PwC,
arXiv 2601.06007v2, Jan 2026). Their conclusion: *"full context caching triggers cache writes for
dynamic tool calls and results, introducing overhead that offsets the benefits of cache reads."* The fix
is an **explicit** breakpoint at the end of the stable prefix rather than an implicit/automatic one at
the tail. Note the cost numbers barely distinguish the strategies (2–4 points) — it is the *latency*
that punishes you.

**M. Gateway and SDK bugs that silently strip or mis-report caching.**
Reported in the wild: bifrost #3942 — *"every `cache_control` marker on message content blocks and on
tools is silently removed before the body is sent upstream… `cached_tokens` is always 0"*; opencode
#18440 — cache misses on OpenRouter show near-zero cost, **"$4 estimated, $20 real"**. A BYOK app that
shows cost must read provider-specific fields or it will under-report miss turns.

---

## 4. Prompt-layout rules to maximise hit rate

### 4.1 The layout

Order strictly by **change frequency**, slowest first:

```
[ 1 ] tools / function definitions        — never change within a conversation
[ 2 ] system prompt, static core          — never changes; NO timestamps, NO state
[ 3 ] character card / persona / scenario — changes only on character switch
[ 4 ] world / lorebook STATIC canon       — changes only on user edit
[ 5 ] ✂ BREAKPOINT (cache_control / prompt_cache_breakpoint)
[ 6 ] conversation history                — append-only, never edited, never reordered
[ 7 ] rolling summary of older history    — appended, never replacing §4.3
[ 8 ] dynamic state block                 — time, location, inventory, mood, scene beat
[ 9 ] retrieved lore / memory this turn   — volatile by nature
[ 10] current user message
```

Claude Code's production ordering is the same shape and is worth copying verbatim: (1) static system
prompt & tools, globally cached; (2) per-project memory file; (3) per-session context; (4) conversation
messages. ProjectDiscovery's is the same idea with three breakpoints: static system prompt (1 h TTL),
static tools (1 h TTL), last tool result (5 min sliding window).

Rules that fall out of this:

1. **Append-only history.** Never edit, delete, reorder, or re-serialise a past message. Echo assistant
   turns back verbatim. Every provider states a version of this (xAI: "the top cause of cache misses";
   Anthropic: `messages_changed`).
2. **Two breakpoints, not one.** On Anthropic put one after [4] and let automatic caching or a second
   explicit breakpoint handle the growing history. The 20-block lookback means a fast-growing
   conversation can outrun a single breakpoint. ProjectDiscovery adds intermediate breakpoints **every
   18 blocks** to support up to ~54 blocks before degrading.
3. **Dynamic state goes at [8], immediately before the user turn** — after the history, not before it.
   This resolves the "important info last" tension (§4.4). ProjectDiscovery calls this the **"relocation
   trick"** and names it *"our single most impactful optimization"*: moving working memory / skills /
   runtime context out of the prefix and into a single `<system-reminder>`-wrapped user message at the
   tail took them from single-digit hit rates to ~74%, then 84%.
   - Wrap relocated context in explicit XML tags, or *"the model sometimes responds to the injected
     context as if it were a user request."*
4. **Retrieved lore goes at [9], not at depth.** Emit it as an ephemeral block in the *current* user
   turn. Do not mutate history. If a lorebook entry must persist, "freeze" it into history at the
   chronological position where it first fired (SillyTavern #5852) — it then becomes part of the
   append-only log and is cached thereafter. Foreverse's variant is **"entry residency"**: once
   triggered, an entry stays in the prompt for the rest of the session. Measured effect on a
   trigger-heavy card: **27.7% → 89.9%**; and total prompt volume *fell* (68,051 vs 71,715 tokens over
   15 turns) because "repeatedly missing the cache costs more than keeping entries resident."
5. **Freeze the context window.** Choose the oldest included message and keep it until the cap, then
   truncate to target in one jump. Do not re-evaluate per turn.
6. **Deterministic serialization.** Sort object keys, fix tool order, fix entry order within each tier.
   Test it: hash the assembled request body for two identical turns and assert equality.
   ProjectDiscovery's technique: render template variables as *stable placeholders*
   (`{{current_datetime}}` → `"[provided in Runtime Context]"`) so the system prompt is byte-identical
   across users and days, and pass real values through the tail instead.
7. **Freeze the clock; prefer date-only.** ProjectDiscovery freezes the datetime once per run and formats
   **date-only** — "including the current time would change Runtime Context every second."
8. **Session identity from the first request.** Send `session_id` (OpenRouter), `x-grok-conv-id` (xAI),
   `prompt_cache_key` (OpenAI pre-5.6 / Mistral), and `x-session-affinity` where offered (Fireworks).
   Derive it from a stable per-chat id, never from message content.
9. **Pre-warm on the expensive path.** Character switch / app start / scene start: issue a
   `max_tokens: 0` request (Anthropic) or `prewarm: true` (OpenAI GPT-5.6+) with the same prefix and the
   same thinking/effort config, since those are rendered into the prompt.
10. **Never add or remove tools mid-session.** Claude Code keeps *all* tools in the request at all times
    and models mode changes as tools (`EnterPlanMode`/`ExitPlanMode`) plus a system message, rather than
    swapping the tool set. For large tool sets use `defer_loading: true` stubs that stay in a fixed
    order — "removing them mid-conversation would break the cache."

### 4.2 Per-provider notes

- **Anthropic**: breakpoints on the *last block identical across requests*, never on the varying block.
  `"ttl":"1h"` when a user may idle >5 min. Order 1h breakpoints before 5m. For mid-scene instructions
  append `{"role":"system"}` rather than editing the top-level `system` (supported models only). Enable
  `diagnostics` every turn.
- **OpenAI**: prefer explicit mode with a breakpoint after the static prefix so the volatile tail is not
  written. Use `prompt_cache_options.prewarm`. On pre-5.6 models use a stable `prompt_cache_key` and
  `prompt_cache_retention:"24h"`. Never `provider.order`-pin on OpenRouter.
- **Gemini**: the 4096 minimum on 3.x makes it a poor fit for short cards; keep card + canon above 4096.
  Prefer implicit (free writes, no storage) unless you need a deterministic hit. On OpenRouter, dynamic
  content must not live in the system message — it's immutable there.
- **DeepSeek**: best fit for RP on cost and latency, cheapest to experiment with. Accept that hit rate
  ramps over the first few turns. Exploit off-peak pricing for bulk/background work.
- **Qwen**: explicit when the card is large and stable (0.1× vs 0.2×), implicit otherwise. Merge parallel
  tool results into one message.

### 4.3 Auto-summarisation without destroying the cache

Naive design (regenerate a summary every N turns and put it at the top) invalidates the prefix every N
turns. Better:

- **Compact rarely and in one shot.** Let the prefix grow; when it hits a threshold, rewrite once and
  re-anchor. Between compactions, zero invalidation.
- **Never shrink the head.** Put the summary *after* the cached canon (position [7]) so the canon prefix
  survives.
- **Freeze the summary.** Append a *new* summary block rather than editing the old one.
- **Fork cache-safely.** Claude Code's fix, and the single most transferable trick here: run the
  summarisation call with the **exact same system prompt, user context, system context, and tool
  definitions** as the parent, prepend the parent's messages, and append the compaction prompt as a new
  user message at the end. The request then looks nearly identical to the parent's last request, so the
  cached prefix is reused and only the compaction prompt is new. This requires reserving a "compaction
  buffer" of context window. Anthropic has since built this into the API.
- **Clear tool results instead of summarising** where applicable — cheapest compaction.

### 4.4 The "important info last" tradeoff

The tension is real but narrower than it appears.

- **What the research supports.** Liu et al. (TACL 2024) found retrieval accuracy is highest when
  relevant information sits at the **beginning or end** of the context and degrades in the middle.
  Chroma's *Context Rot* (2025) tested 18 models: performance degrades non-uniformly with input length,
  worse for low-similarity needle/question pairs, and **distractors hurt more as context grows**.
- **Why it doesn't force a bad cache layout.** Two things:
  1. Cacheability requires prefix *stability*, not prefix *content*. A stable, cached character card at
     the top costs 0.1× per turn. Moving it to the bottom to exploit recency would make it a miss
     (1.25× write) every turn *and* would place it after the history — which the research does not favour
     over the top anyway.
  2. The genuinely time-sensitive information — current scene state, last exchange, the new user message
     — is naturally at the tail already.
- **Resolution:** keep canon at the head (cached, and favoured by the primacy effect), and place dynamic
  state in the *final* user turn (favoured by recency). Both ends get the attention benefit; the long,
  boring, append-only middle is exactly where degradation is least harmful and where caching saves the
  most. **The cache-optimal layout and the attention-optimal layout coincide**, provided dynamic state is
  emitted *after* the history rather than before it.
- **Corollary:** anything you are tempted to inject "at depth" for attention reasons is being placed in
  the middle — the worst position by this research — *and* breaks the cache. Move it to the tail.
- **The honest counterpoint.** This tradeoff is not free and is worth stating: the HN discussion of the
  ngrok caching explainer raises it directly — *"If putting the user's datetime in the middle of the
  prompt scores higher on evals but worsens cache hits, versus at the end of the prompt where it's
  cache friendly but may not be as effective, what do you do?"* There is no published measurement
  answering it for roleplay. Treat "tail is as good as middle" as the working hypothesis and measure it.
- **The closest thing to a controlled answer.** Lumer et al. (PwC, arXiv 2601.06007v2, Jan 2026) ran
  500+ agent sessions on a 10,000-token system prompt across OpenAI, Anthropic, and Google, varying
  *only* where the cache boundary sits. Their recommendation matches the layout above and is
  unambiguous: *"If such dynamic information is necessary, it should be placed at the end of the system
  prompt to maximize the cacheable prefix. This ensures that the majority of the system prompt benefits
  from cache hits while only the dynamic suffix requires recomputation."* They did not measure answer
  quality against position, so this is a caching recommendation rather than a resolution of the
  attention question — but it is the strongest available evidence that moving dynamic content to the
  tail is the right default.

---

## 5. Measuring cache hit rate per provider

Compute one metric consistently:

```
hit_rate = cached_tokens / (cached_tokens + cache_write_tokens + uncached_input_tokens)
```

| Provider | Read field | Write field | Uncached field |
|---|---|---|---|
| Anthropic | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` | `usage.input_tokens` |
| OpenAI (Responses) | `usage.input_tokens_details.cached_tokens` | `usage.input_tokens_details.cache_write_tokens` | `input_tokens − cached − write` |
| OpenAI (Chat Completions) | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_write_tokens` | same |
| Gemini | `usage.total_cached_tokens` / `usage_metadata.cached_content_token_count` | n/a (implicit) | — |
| DeepSeek | `usage.prompt_cache_hit_tokens` | n/a (write = input price) | `usage.prompt_cache_miss_tokens` |
| Grok | `usage.prompt_tokens_details.cached_tokens` | n/a | `prompt_tokens − cached` |
| Mistral | `usage.prompt_tokens_details.cached_tokens` | n/a | `prompt_tokens − cached` |
| Qwen | `usage.prompt_tokens_details.cached_tokens` | `.cache_creation_input_tokens` | remainder |
| OpenRouter | `usage.prompt_tokens_details.cached_tokens` | `.cache_write_tokens` | `prompt_tokens − both` |

Traps:

- **Anthropic's `input_tokens` is not total input.** It is only the tokens *after the last breakpoint*.
  Total = `cache_read + cache_creation + input_tokens`. Any dashboard treating `input_tokens` as the
  denominator reports nonsense.
- **Mistral rounds to 64-token blocks** — `cached_tokens` is always a multiple of 64.
- **OpenRouter's `cache_discount` is signed**: negative on Anthropic writes, positive on reads.
- **`cost_details.upstream_inference_cost` is 0/null except for BYOK** via `/generation`.
- Cost formula (OpenAI's, generalises): `weighted_input = uncached + cached×r + write×w`, then
  `× price/1e6`, with `r`/`w` per provider/model.
- **Watch for lying or broken reporters.** Olaf Dsouza found OpenInference reporting *"42% of a
  brand-new, globally unique prefix as cached on its first request"* while its full replay measured 8%,
  and bifrost #3942 shows `cache_control` being silently stripped so `cached_tokens` is always 0.
  Cross-check reported tokens against billed cost.

**Recommended app-level instrumentation.** Log per request
`{provider, model, chat_id, turn_index, cached, write, uncached, hit_rate, cost, ttft_ms, prefix_hash}`.
Store a rolling `prefix_hash` of the assembled request body; a turn where `prefix_hash` differs from the
previous turn *outside the appended tail* is a bug, and you can diff it to name the culprit component.
This is what SillyTavern PR #5629 proposes, what CacheLens does as a product ("diff-based detection
across multiple API calls to identify what's actually static vs dynamic"), and what Anthropic's and
OpenAI's server-side diagnostics do for their own providers. Since diagnostics exist for only two
providers, **the client-side prefix hash is the general solution.**

**Aggregate metric advice:** aggregate hit rate is a traffic-weighted mean and hides thrashing. Tian
Pan's multi-tenant post-mortem saw aggregate hit rate fall **71% → 18%** in a week, producing a surprise
**$40,000** bill with flat volume and normal latency. Track **per-conversation** hit rate with a target
(e.g. 70%) and alert on the *shape* of the per-turn curve — Foreverse's worst card read "0, 0, 91, 14,
then eight turns flat between 11 and 15, one spike to 94, back down to 8" before the fix.

---

## 6. What SillyTavern and others actually do

### 6.1 SillyTavern (release 1.19.0, checked 2026-09-29)

**What it implements:**

- **Anthropic explicit breakpoints**, as two hidden `config.yaml` knobs with **no UI**:
  - `claude.enableSystemPromptCache` (added 2024-08-15, commit `7322dd1`) marks the last system-prompt
    block and the last tool with `cache_control: {type:'ephemeral', ttl}`.
  - `claude.cachingAtDepth` (added 2024-11-18, PR #3085) marks **two** breakpoints at role-switch depth
    `N` and `N+2` counting back from the tail, skipping the trailing assistant prefill.
  - `claude.extendedTTL` toggles `ttl:'1h'`; pushes beta headers `prompt-caching-2024-07-31` and
    `extended-cache-ttl-2025-04-11`.
  - Source: `src/prompt-converters.js:976-1112`, `src/endpoints/backends/chat-completions.js:105-112, 280-300, 330-337`.
- **OpenRouter Claude**: same two mechanisms, the depth variant skipping system messages after bug #5227
  / fix PR #5230.
- **OpenRouter Gemini**: system-prompt caching only, gated on the model reporting `pricing.input_cache_write`
  (`isOpenRouterModelCacheable`). Direct Gemini `cachedContents` is **not** implemented.
- **Fireworks**: `x-session-affinity` header, an HMAC of the chat id (PR #5826, merged 2026-08-19).
- **llama.cpp / Ollama**: always sends `cache_prompt: true`.
- **Not implemented**: OpenAI `prompt_cache_key`, Gemini `cachedContents`, any DeepSeek cache API,
  `cache_discount`. Open PR #5889 would add OpenRouter `session_id`/`prompt_cache_key` sticky routing.

**Why it still gets low hit rates.** Every anti-pattern in §3 is live:

- `{{time}}`/`{{date}}`/`{{weekday}}`/`{{isotime}}`/`{{datetimeformat}}` resolve to wall-clock;
  `{{random}}` re-rolls with `entropy:true` (`public/scripts/macros/definitions/core-macros.js:356`).
- World Info entries are emitted sorted by descending `order` (`world-info.js:88, 5195`) and only when
  keyword-activated, so `worldInfoBefore`/`worldInfoAfter` change as the chat evolves.
- Chat vectorisation **splices retrieved messages out of the chat array** and re-injects at depth
  (`extensions/vectors/index.js:818-841`) — issue #4260, 2–4× cost, fixed for that user by deleting the splice.
- Sliding-window context re-evaluation every turn (PR #5788).
- In-chat `@ Depth` injections shift relative to the tail as the conversation grows (issue #5852).

**Maintainer position.** Cohee1207 (2025-12-06, issue #4865):
> "I do not plan to expose caching options to the UI. It's made a hard to reach setting on purpose
> because context caching is extremely fragile, unstable, and easy to break unintentionally."

and (2024-08-24, issue #2693):
> "Any lorebook, prompt injection, vectors, note, `{{random}}`, anything that alters the prompt, and the
> cache is not only no longer useful, but outright harmful, causing cache misses on every prompt."

**Cache metrics are not surfaced in the UI at all** on release. Two open PRs (#5542, #5629) propose it.

**Community proposals worth stealing** (all unmerged as of 2026-09-29):

| # | Proposal | Date | Idea |
|---|---|---|---|
| 5788 | Anchor-based dynamic context window | 2026-06-20 | Hold oldest included message fixed; append-only growth; one-shot truncate + re-anchor |
| 5852 | "Freeze to History" | 2026-07-14 | Bake triggered lorebook entries into the chat log as immutable messages, like tool results |
| 5889 | OpenRouter sticky routing key | 2026-07-28 | Send `session_id`; notes `{{char}}` in the Main Prompt breaks OpenRouter's default hash key in group chats |
| 6017 | Background cache keepalive | 2026-09-09 | Refresh the last request every 4 min without touching history |
| 5629 | DeepSeek cache diagnostics | 2026-05-12 | Snapshot the assembled messages, diff consecutive snapshots, name the changed component |
| 4928 | Per-prompt cache toggles | 2025-12-28 | Notes modular prompts cause misses between chat history and first prompt |
| 171 | Kv cache management | 2023-04-25 | The original statement of the problem: *"put immovable part of the prompt… at the very beginning and never change it at all"* |

### 6.2 What Anthropic's Claude Code team does (the best-documented reference implementation)

From their 2026-04-30 engineering post — the single most authoritative statement of what breaks caching
and what fixes it:

- Cache hit rate is an **SLO**: *"we run alerts on our prompt cache hit rate and declare SEVs if they're
  too low."*
- **Static first, dynamic last**, in four tiers: static system prompt & tools (globally cached) → project
  memory (cached per project) → session context (cached per session) → conversation messages.
- What broke it for them: *"putting an in-depth timestamp in the static system prompt, shuffling tool
  order definitions non-deterministically, and updating parameters of tools."*
- **Use messages for updates, not system-prompt edits** — they append a `<system-reminder>` to the next
  user message or tool result.
- **Never change models mid-session**; use subagents for model switching instead.
- **Never add or remove tools mid-session**; model state transitions as tools, and `defer_loading` stubs
  instead of removal.
- **Cache-safe forking** for compaction (§4.3) — the naive version pays full uncached price for the
  whole conversation.

### 6.3 The one directly comparable roleplay benchmark

Foreverse (a BYOK character-chat app) benchmarked itself against SillyTavern, 2026-07-24. Same model
(`deepseek-v4-flash`), same API key, same three character cards, byte-identical 15-turn scripts, all
calls metered through one gateway, three repeats per cell, SillyTavern v1.18.0 configured per its
documented best practices including disabling summarize side-calls.

| Card (lorebook structure) | Normal mode before → after | Agentic mode before → after |
|---|---|---|
| Original deep-lore card (10 entries, all triggered) | 22.6% → 86.5% | 12.8% → 86.2% |
| Ghost-story card (12 entries, all triggered) | 27.7% → 92.3% | 28.8% → 87.1% |
| Slice-of-life card (2 constant + 5 triggered) | 74.3% → 90.1% | 71.0% → 90.6% |

Headline matrix: **stock SillyTavern 91.5%**, modded SillyTavern 74.6%, Foreverse normal mode 46.5%,
agentic mode 42.3%. Cost fell 58% and 63% after the fix; TTFT dropped 5–65 ms.

Findings that matter for the design doc:

- **The lorebook, not the engine, is the dominant variable.** The only structural difference between the
  three cards is the lorebook: constant-entry card 74.3%, all-triggered cards 22.6% and 27.7%. *"Triggered
  entries walk in and out of the prompt head as keywords come and go… one changed byte near the top
  reprices everything after it."*
- **The fix was three alignments plus one mechanism**: recursive lorebook scanning on by default (so
  cross-referenced entries arrive turn one); "0 means unlimited" recursion semantics; correct CJK
  whole-word matching; and their own **entry residency** (once triggered, stay for the session).
- **Verified mechanically, not just statistically**: *"We diffed consecutive request bodies byte by byte:
  from turn two onward, every request is a strict prefix of the next plus the new turn. That is what
  cache-friendly looks like."*
- **The counter-cost is real and they measured it**: residency drained the candidate pool for their
  agentic lore retrieval, dropping a 12-question lore quiz from 12/12 to 9/12 — caught by the same
  benchmark and fixed. Caching and retrieval quality genuinely trade off.
- **Mods have a measurable cache cost**: the popular preset-plus-plugins stack pushed prompt volume to
  **2.46× stock** and dropped hit rate **17 points**.
- They explicitly note SillyTavern still wins by 1.6 points, and that the gap is explained by their own
  probe questions that dodge trigger keywords — on SillyTavern's side the entry never shows up at all,
  *"kind to the cache, unkind to the answer."*

### 6.4 Other developer practice

- **Cache keep-alive as a productised hack.** Grov (Show HN, 2025-12-06) ships `--extended-cache`, a
  heartbeat sending a minimal token every 4 minutes to keep Anthropic's 5-minute cache alive, framed as
  the write (1.25×) vs read (0.1×) trade plus rate-limit avoidance. SillyTavern PR #6017 is the same idea
  as an in-tree extension.
- **Cache observability as a tool category.** CacheLens (Show HN, 2026-03-13) is a local proxy recording
  token usage, cost, and cache hit rates across Anthropic/OpenAI/Google, with diff-based static/dynamic
  classification. Prompt-pillar (dev.to, 2026-05-25) does canonical-JSON hashing to find the first
  diverging message.
- **Measured production numbers to calibrate against:**
  - ProjectDiscovery: **7% → 84%** hit rate, −59% cost, 9.8 B tokens served from cache. Cache rate scales
    with task length: 1 step 35.5%, 20+ steps 74.0%. Two tasks of nearly identical token volume scored
    **91.8% vs 3.2%** — "roughly 60x the cost."
  - Deriv: **85.8%** hit rate → **77%** input-cost cut. *"A system with caching enabled but a poorly
    organised prompt typically achieves a hit rate of around 20%."* Their rule of thumb: monthly savings
    ≈ monthly input tokens (billions) × hit rate × $1,125.
  - Cloudflare AI code review: **85.7%** hit rate; the mechanism is a shared on-disk context file so
    seven concurrent reviewers don't each duplicate the MR context ("would multiply our token costs by 7x").
  - A Claude Code user's own logs (933 sessions, 93,842 calls): **97.0%** hit rate, $22,720 vs $113,418
    without caching.
  - Agent harness comparison: Claude at **96%** hit rate — highest tested — yet still 8× the nearest
    competitor on price. **A high hit rate does not mean low cost.**
  - OpenAI automatic caching in the wild: **80–90%** hit rates after the first call on a ~1,400-token
    tool prefix, 47–49% input-cost reduction. (Same write-up claims undocumented cross-model cache
    sharing between gpt-4o-mini / gpt-5-mini / gpt-5 — treat as unconfirmed.)
  - Lumer et al. (PwC, arXiv 2601.06007v2, Jan 2026) — the only controlled, peer-style study here.
    500+ agent sessions, 10,000-token system prompt, three providers, four cache modes, n=40 per cell,
    24-hour cooldowns between conditions to prevent contamination. Cost savings **41–80%**; TTFT
    improvements **6–31%**. Two findings the design doc should absorb:
    1. **Cost savings are driven almost entirely by the system prompt**, not by history or tool results —
      the three strategies differ by only 2–4 points on cost. The system prompt is cached in all of them.
    2. **Naive full-context caching can be *worse than not caching* on latency.** GPT-4o full-context
      caching regressed TTFT by **8.8%**; Gemini 2.5 Pro "exclude tool results" regressed by **2.9%**.
      Their explanation: *"full context caching triggers cache writes for dynamic tool calls and results,
      introducing overhead that offsets the benefits of cache reads."* Selective boundaries (system
      prompt only, or excluding tool results) beat full-context on latency for every model tested.
    Ablations: cost savings scale **linearly with prompt size** (10–45% at 500 tokens → 54–89% at 50,000)
    but are **flat across tool counts** — so the cacheable prefix length is the dominant lever, not the
    number of turns. At 500 tokens, below every provider's minimum, all three models showed TTFT
    *regressions* of 10–18%.
- **Horror stories worth designing against:** a $38k Bedrock bill from a caching miss (Droid → LiteLLM →
  Bedrock → Claude Opus 4.6; 6.47 B uncached tokens ≈ $35.6k vs 1.67 B cached ≈ $918); OpenCode putting
  the current date in the turn-0 system prompt so *"if you're using OpenCode at midnight you get a full
  prompt cache miss."*

### 6.5 chub.ai

**No public engineering material on chub.ai's caching behaviour was found** — no developer blog,
engineering post, or Discord statement, and no measured hit-rate data. What exists is pricing/tiers and
lorebook documentation. The complaint in the brief is consistent with the failure modes above, and the
Foreverse benchmark's all-triggered cards (22.6–27.7%) are the closest measured proxy for a
lorebook-heavy chat, but **treat any specific claim about chub's implementation as unverified.**

---

## 7. Concrete design rules for the app

Ordered by implementation priority. Rules 1–5 are architectural and must be in the first schema.

1. **Message log is append-only and immutable.** Messages have a monotonic index; the request builder
   emits `[static prefix] + [messages 0..N] + [volatile tail]` and nothing else. Any feature that wants
   to change a past message appends a new one instead.
2. **Three-tier prompt model**: `canon` (tools, system, character, static lore — changes only on user
   edit), `log` (append-only conversation), `volatile` (state, retrieved memory, current turn). The
   cache breakpoint goes at the canon/log boundary. Tier membership is declared, not inferred.
3. **Deterministic assembly with a test.** Canonical JSON (sorted keys), fixed tool order, fixed lore
   order. Assert: assembling the same turn twice is byte-identical; assembling turn N+1 differs from
   turn N only by an appended suffix. **This is the single test that catches most cache regressions** —
   it is what Foreverse used to verify their fix.
4. **Frozen context window.** Anchor the oldest included message; grow by appending; truncate in one
   jump at the cap and re-anchor. Never re-evaluate per turn.
5. **Session identity from the first request.** Per-chat UUID sent as OpenRouter `session_id`, xAI
   `x-grok-conv-id`, OpenAI `prompt_cache_key`, Fireworks `x-session-affinity`. Never derive it from
   message content (a `{{char}}` in the system prompt breaks OpenRouter's default key).
6. **Provider capability table in the client**, not hardcoded per call site: activation mode, min
   cacheable tokens, TTL, write/read multipliers, usage field names, sticky-routing mechanism. §1.1 is
   the seed; re-verify before shipping since several sources conflict.
7. **Cache-aware breakpoint placement per provider**: Anthropic 2 explicit breakpoints (canon + history
   head) plus intermediates every ~18 blocks for long chats; OpenAI explicit mode with a breakpoint after
   canon; Qwen explicit when the card is large; Gemini implicit only.
   **Prefer explicit over automatic wherever the provider allows it** — automatic placement lands on the
   tail, i.e. on volatile content, and the measured penalty is a latency regression, not just a cost one
   (§3 anti-pattern L2). This is the single most counter-intuitive finding in the research and the one
   most likely to be got wrong by "just turning caching on."
8. **TTL strategy by idle time.** Offer 1h TTL when the user's median inter-turn gap exceeds ~3 minutes;
   otherwise 5m plus a keep-alive. A keep-alive is cheap on read (0.1×) and saves the 1.25× rewrite.
   Independent data: most providers evict in 1–15 minutes, so a keep-alive is doing real work.
9. **Pre-warm on character select and scene start** (`max_tokens: 0` / `prewarm: true`), matching the
   thinking/effort config exactly, since those are rendered into the prompt.
10. **Never change request-level knobs mid-conversation** without warning. Verbosity, thinking budget,
    effort, output schema, tool list, and images all invalidate. If a slider must exist, treat changing
    it as a cache reset and say so in the UI.
11. **Instrument and surface it.** Per-turn `prefix_hash` + hit rate in a dev panel; flag any turn where
    the prefix changed before the tail. Pass Anthropic `diagnostics` and OpenAI
    `prompt_cache_options.comparison_response_id` and translate `cache_miss_reason` into plain language.
    Track **per-conversation** hit rate, not just the aggregate, and alert on the per-turn curve shape.
12. **Lorebook entries must be resident, not re-triggered.** Once an entry fires, keep it for the
    session (Foreverse's "entry residency") or bake it into the log (SillyTavern #5852's "Freeze to
    History"). Enable recursive scanning so cross-referenced entries all arrive on turn one. Accept the
    measured retrieval-quality cost (12/12 → 9/12 in Foreverse's quiz) and consider exposing a toggle.
13. **Compaction budget, not a compaction schedule.** Compact on token threshold, in one shot, summary
    placed after the canon, new summary appended rather than replacing the old. **Fork the summarisation
    call with the parent's exact system prompt, tools, and message prefix** and append the compaction
    prompt as a final user message.
14. **Don't cache-hostile the cheap providers.** For DeepSeek/Grok/Gemini-implicit (no write cost),
    padding to the minimum cacheable length is free upside; only Anthropic/OpenAI-5.6+/Qwen-explicit need
    the break-even calculation.
15. **Warn on OpenRouter `provider.order` pinning** — it disables sticky routing and therefore most of
    the cache benefit. Consider defaulting to sticky and letting power users override.
16. **Surface the model-selection trap.** Warn when a user picks a floating `latest` alias for a chat
    that has already started, since the underlying model change invalidates the cache.

---

## Sources

Provider docs:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics
- https://developers.openai.com/api/docs/pricing
- https://ai.google.dev/gemini-api/docs/caching
- https://ai.google.dev/gemini-api/docs/generate-content/caching
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/api/caching
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview
- https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/
- https://api-docs.deepseek.com/guides/kv_cache
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/news/news0802
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/multi-turn
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices
- https://docs.x.ai/developers/models
- https://docs.mistral.ai/studio/conversations/advanced/prompt-caching
- https://www.alibabacloud.com/help/en/model-studio/context-cache
- https://console.groq.com/docs/prompt-caching
- https://docs.z.ai/guides/capabilities/cache

OpenRouter:
- https://openrouter.ai/docs/guides/best-practices/prompt-caching
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/docs/cookbook/administration/usage-accounting
- https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/
- https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation
- https://openrouter.ai/docs/faq

Production engineering writeups with measured numbers:
- https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything (2026-04-30)
- https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching (2026-04-10)
- https://foreverse.app/blog/sillytavern-cache-benchmark (2026-07-24)
- https://foreverse.app/blog/prompt-caching-explained (2026-07-04)
- https://olafdsouza.com/blog/your-inference-provider-sucks-at-caching (2026-09-02)
- https://derivai.substack.com/p/prompt-caching-production-ai-agent-costs (2026-07-23)
- https://tianpan.co/blog/2026/04/28/prompt-cache-thrashing-multi-tenant-noisy-neighbor (2026-04-28)
- https://earendil.com/posts/prompt-caching/ (2026-07-22)
- https://ngrok.com/blog/prompt-caching/ (2025-12-16)
- https://blog.cloudflare.com/ai-code-review/
- https://mmoustafa.com/blog/so-you-want-to-use-openrouter/ (2026-09-07)
- https://wren.wtf/shower-thoughts/stop-using-opencode/
- https://dev.to/mukundakatta/your-hermes-agents-prompt-cache-is-30-hit-because-of-one-timestamp-heres-how-to-find-it-2o1f
- https://tokencostlab.com/blog/prompt-caching-trap (2026-05-28) — SEO-adjacent; numbers unverified

Gateway/SDK bug reports:
- https://github.com/anomalyco/opencode/issues/18440
- https://github.com/maximhq/bifrost/issues/3942

Research:
- https://arxiv.org/html/2601.06007v2 (Lumer et al., PwC, "Don't Break the Cache", Jan 2026) — controlled cache-boundary study, 3 providers, 500+ sessions
- https://arxiv.org/abs/2307.03172 (Liu et al., "Lost in the Middle", TACL 2024)
- https://research.trychroma.com/context-rot (Chroma, 2025-07-14)
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (2025-09-29)
- https://artificialanalysis.ai/models/caching

SillyTavern source and issues:
- https://github.com/SillyTavern/SillyTavern/blob/release/src/prompt-converters.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js
- https://github.com/SillyTavern/SillyTavern/blob/release/default/config.yaml
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/vectors/index.js
- https://github.com/SillyTavern/SillyTavern/issues/171
- https://github.com/SillyTavern/SillyTavern/issues/2693
- https://github.com/SillyTavern/SillyTavern/issues/3848
- https://github.com/SillyTavern/SillyTavern/issues/3896
- https://github.com/SillyTavern/SillyTavern/issues/4260
- https://github.com/SillyTavern/SillyTavern/issues/4781
- https://github.com/SillyTavern/SillyTavern/issues/4865
- https://github.com/SillyTavern/SillyTavern/issues/4928
- https://github.com/SillyTavern/SillyTavern/issues/5227
- https://github.com/SillyTavern/SillyTavern/issues/5746
- https://github.com/SillyTavern/SillyTavern/issues/5852
- https://github.com/SillyTavern/SillyTavern/pull/3085
- https://github.com/SillyTavern/SillyTavern/pull/4903
- https://github.com/SillyTavern/SillyTavern/pull/5542
- https://github.com/SillyTavern/SillyTavern/pull/5629
- https://github.com/SillyTavern/SillyTavern/pull/5788
- https://github.com/SillyTavern/SillyTavern/pull/5826
- https://github.com/SillyTavern/SillyTavern/pull/5889
- https://github.com/SillyTavern/SillyTavern/pull/6017

Tools and community:
- https://github.com/TonyStef/Grov
- https://github.com/stephenlthorn/cache-lens
- https://github.com/O1af/isometric-eval
- https://news.ycombinator.com/item?id=46070749
- https://news.ycombinator.com/item?id=46176355
- https://news.ycombinator.com/item?id=47361756
- https://news.ycombinator.com/item?id=47442486
- https://news.ycombinator.com/item?id=41425910 (chub.ai hiring post — architecture only)
- https://theunofficialguidetochubai.wordpress.com/faq/ (community doc, not a dev statement)
