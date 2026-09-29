# Voice + image generation for a BYOK roleplay client

Researched **2026-09-29**. Prices USD list/PAYG. Full version + sources: `local://research-voice-image.md`.

## (a) TTS

| Provider | Price | Latency | Streaming | Clone | NSFW |
|---|---|---|---|---|---|
| ElevenLabs v4 / v4 Turbo | $0.022 / $0.011 per 1k ch (promo to Oct 12; list $0.08/$0.04) | ~100 ms | HTTP `/stream` + WS `stream-input` | IVC/PVC | **policy silent on adult; fiction carve-out** |
| ElevenLabs Flash v2.5 | $0.04/1k ch | **~75 ms** | WS | yes | same |
| OpenAI tts-1 / tts-1-hd | $15 / $30 per 1M chars | tts-1 faster | chunked | gated | NCII + underage RP banned |
| OpenAI gpt-4o-mini-tts | $0.60/1M text + $12/1M audio tok | — | `stream_format: audio\|sse` | gated | same |
| Google Cloud TTS | Std $4 / Neural2 $16 / Chirp3:HD $30 / Studio $160 per 1M | — | gRPC `StreamingSynthesize` (Chirp3-HD only) | Instant clone $60/1M | **prohibited** |
| Gemini 3.8 Flash TTS | $0.50/1M text + $9/1M audio tok | — | `stream: true` | voice design | **prohibited** |
| Azure Speech | Neural $15 / HD $22 / CNV $24 per 1M | — | chunked + WS SDK | CNV $24/1M + $52/hr train + $4.03/hr host | **prohibited** |
| Deepgram Aura-1/2/Flux | $0.0150 / $0.030 / $0.045 per 1k ch | Flux realtime | REST + WSS | no | AUP |
| **Kokoro-82M** | free, **Apache-2.0** | ~300 ms GPU; ~3.5 s old i7 CPU | `TextSplitterStream` | voice mixing | **none** |
| XTTS-v2 | free, **CPML non-commercial** | <200 ms claimed | yes | 6 s zero-shot | none |
| Piper (`piper1-gpl`) | free, **GPL-3.0** engine + MIT voices | CPU-realtime, RPi4 | raw PCM/HTTP | no | none |
| edge-tts | free, **LGPLv3**, unofficial | <200 ms class | WS MP3 | no | none, ToS-hostile |
| Chatterbox | free, **MIT** | Turbo 350M 1-step; Nano 110M 3× realtime on 8 cores | via wrappers | 10 s zero-shot | none; **all output PerTh-watermarked** |
| Fish Speech S2 | **non-commercial** (Fish Audio Research License 2026-03-07) | WS `/v1/tts/live` | yes | 10–30 s | none |

**API shapes.** ElevenLabs: `POST /v1/text-to-speech/{voice_id}` (`/stream` for chunked), `xi-api-key`, `output_format` enum (`pcm_*`, `ulaw_8000`; 44.1 kHz PCM/WAV needs Pro+). `previous_text`/`next_text`/`previous_request_ids` give cross-chunk prosody continuity. True streaming is `wss://…/v1/text-to-speech/{voice_id}/stream-input`, returning base64 chunks **plus character-level alignment** (`charStartTimesMs`) — needed for word-highlight karaoke. Flash v2.5 has the largest single-request cap (40,000 chars); Google is tightest (5,000 bytes). OpenAI: `POST /v1/audio/speech` with `instructions` — prompt accent/emotion/whispering, a natural fit for roleplay mood.

**Content policy is the decisive axis.** ElevenLabs' Prohibited Use Policy (updated **2026-08-17**) §8 carves out fiction ("This section does not apply to activity in purely fictional contexts") and has **no clause banning consensual adult sexual content** — unstated, not granted; §5 still bans sexualizing a real person's voice. OpenAI (eff. 2025-10-29) bans NCII and underaged sexual/violent roleplay with no fiction carve-out, and requires AI-voice disclosure. Google's Generative AI Prohibited Use Policy and Microsoft's AI Code of Conduct are hard nos. Locals have no policy, only licences: commercially usable = **Kokoro (Apache-2.0), Piper (GPL engine/MIT voices), Chatterbox (MIT)**; **XTTS-v2 (CPML) and Fish Speech are non-commercial only** — Coqui shut down Jan 2024 and nobody now grants CPML commercial licences (coqui-ai/TTS#3490, discussion #4304); maintained fork is `idiap/coqui-ai-TTS` (MPL-2.0).

**How SillyTavern abstracts providers** (`public/scripts/extensions/tts/readme.md`) — copy this. A provider is a class registered with `registerTtsProvider(name, Class)` implementing `generateTts(text, voiceId)`, `fetchTtsVoiceObjects()`, `getVoice(name)`, `onRefreshClick()`, `checkReady()`, `loadSettings(obj)`, `settings`, `settingsHtml`; optional `previewTtsVoice()`, `separator`, `processText()`, `dispose()`. Three details worth stealing: (1) **`generateTts` may return an async generator** — the core does `if (typeof response[Symbol.asyncIterator] === 'function') for await (chunk of response) processResponse(chunk)`, so streaming is an optional capability of the same interface, not a second code path; (2) **voice maps keyed by character *and* segment qualifier** (`'{char} ("Quotes")'`), with `parseMessageSegments()` splitting messages into `dialogue`/`action` so narration and speech use different voices, plus a per-provider `separator` (`' ... ... ... '`) as a pause token; (3) a **post-processing hook** `globalThis.rvcVoiceConversion(response, char, text)`. ST ships ~25 adapters and gets **ElevenLabs generation-history dedupe** free by looking up `/api/speech/elevenlabs/history` for an identical `(text, voice_id)` pair before paying to regenerate — a real saving on swipes.

## (b) STT / voice input

| Option | Cost | Offline | Mobile |
|---|---|---|---|
| **Groq `whisper-large-v3-turbo`** | **$0.04/hr** (10 s min billed) | no | any — OpenAI-compatible, 216× realtime, no streaming |
| OpenAI gpt-transcribe / gpt-4o-mini-transcribe | $0.0045 / $0.003 per min | no | any |
| OpenAI gpt-live-transcribe | $0.017/min | no | WS — **no server VAD**, you must do endpointing |
| Deepgram Nova-3 streaming | $0.0048/min promo | no | WS, ≤300 ms |
| AssemblyAI U3.6 Pro Realtime | $0.45/hr | no | **billed on socket-open time** |
| ElevenLabs Scribe v2 / Realtime | $0.22 / $0.39 per hr | no | ~150 ms realtime |
| Google STT v2 | $0.016/min | no | gRPC, 25 KB/request cap — bad BYOK fit |
| whisper.cpp `whisper-server` | free, MIT | yes | desktop; base ≈0.2–0.4 s / 30 s window |
| `whisper.rn` | free, MIT | yes | base encoder 62 ms / 30 s on Snapdragon 8 Elite |
| Web Speech API | free | no | **unusable** |

**Recommendation: push-to-talk, clip-and-POST, not streaming.** A 5–10 s Opus clip uploads in 20–200 ms and transcribes in 50–400 ms — 100–400 ms after button release, perceptually instant, with no WebSocket lifecycle, VAD, or per-minute socket billing. Capture with `MediaRecorder` (Chrome 47+, Safari 14.1+/iOS 14+). **Web Speech API is disqualifying**: absent in Android WebView (Chromium bug 41172064 — the object exists but never fires, so feature-detection gives a *false positive*) and in iOS WKWebView/SafariViewController (WebKit bug 225298, open since 2021), absent in Firefox, and in Chrome the audio goes to Google servers. Probing this host's Chromium 154, `audio/webm;codecs=opus` and `audio/mp4;codecs=mp4a.40.2` are supported while `audio/wav`, `audio/mpeg`, `audio/ogg;codecs=opus` are **not** — so WAV for a local `whisper-server` needs an encoder or `--convert`. Use `getUserMedia` + `AnalyserNode` for a local level meter. Cap clips at 30–60 s.

## (c) Image generation

| Backend | Cost/image | NSFW | Self-host | Consistency |
|---|---|---|---|---|
| A1111 WebUI | $0 | yes | AGPL-3.0 (master frozen 2024-07-27) | IPAdapter, ControlNet, LoRA |
| Forge-Classic / Forge-Neo | $0 | yes | yes | live lineage; upstream Forge last pushed 2025-07-31 |
| SD.Next | $0 | yes | Apache-2.0, pushed 2026-09-29 | full local stack |
| ComfyUI | $0 (RunPod ≈$0.02) | yes | GPL-3.0, 135k★ | **everything** |
| NovelAI Diffusion V5 | $25/mo Opus ≈ **1,730 free images** per refilled bar | **yes, expressly permitted** | no | **Precise Reference** (+5 Anlas), Vibe Transfer ≤16 vibes |
| OpenAI gpt-image-2.5 | $0.006 low → $0.211 high (1024²) | **no** | no | weak; docs warn it "may struggle to maintain visual consistency" |
| Gemini 3.1 Flash Image (Nano Banana 2) | **$0.067/1K**, $0.101/2K, $0.151/4K | no | no | strongest hosted: ≤14 refs, ≤5 char refs, 360° workflow; SynthID |
| FLUX.2 via api.bfl.ai | klein-4B from $0.014, pro $0.03/MP | tolerated | dev/klein weights only | ≤10 multi-refs; LoRA endpoints |
| fal.ai | flux/dev $0.025/MP, flux-lora $0.035/MP | checker disable needs account auth | n/a | per-call LoRA |
| Replicate | flux-dev $0.025, flux-1.1-pro $0.04, schnell $3/1000 | per-model | n/a | LoRA |
| AI Horde | **$0**, kudos-prioritised | **yes** | crowd-run | worker's checkpoint |
| RunPod serverless ComfyUI | 4090 $0.74/hr ⇒ ~$0.02/image | your workflow | rented | full ComfyUI |

**AI Horde verified live 2026-09-29**: `POST /api/v2/generate/async` with anonymous key `0000000000` + `Client-Agent` header → `{id, kudos}`; poll `/generate/check/{id}` then `/generate/status/{id}` (base64 WebP in `generations[0].img`). A 512²/10-step request completed with `queue_position: 0, wait_time: 0` in ~4 s, cost 5 kudos, ran on `stable_diffusion`/`nainai-540331-sd15`. Fleet: **164 image models / 679 workers**, incl. `WAI-NSFW-illustrious-SDXL`, `CyberRealistic Pony`, `Flux.1-Schnell fp8`. A rapid second request returned **HTTP 403** — real rate limiting. Anonymous = lowest priority, "may be restricted during high load"; registered keys need 25 kudos for priority; kudos can never be bought.

**FLUX licensing is a trap**: FLUX.1 [dev] and FLUX.2 [dev]/klein-9B are non-commercial; only **klein-4B** and **FLUX.1 [schnell]** are Apache-2.0; pro/max/flex are API-only.

**SillyTavern integration (the reference).** Storage: client base64-encodes and `POST`s `/api/images/upload` `{image, format, ch_name, filename}`; server writes `<data-root>/<user>/user/images/<char>/<char>_<timestamp>.png` (`USER_DIRECTORY_TEMPLATE.userImages = 'user/images'`) and returns the relative path; gallery = `/api/images/list` + `/api/images/folders`. **Rendering is not a `{{img}}` macro** — ST pushes a chat message with `extra.media = [{url, type, title: prompt, generation_type, negative, source: GENERATED}]` and `media_display: GALLERY`, with text defaulting to `'[{{char}} sends a picture that contains: {{prompt}}].'`; images are **hidden from the LLM prompt by default** with a per-initiator "let the character see it" toggle. `/sd quiet=true` returns the URL without posting. Generation modes `you|face|me|scene|last|raw_last|background` each have an LLM prompt template; non-`raw_last` modes spend a **second LLM call** to turn chat context into the prompt. Interactive mode uses a verb+noun regex; a function-calling mode replaces it. **ComfyUI contract**: `POST {url}/prompt` with API-format workflow JSON → `prompt_id`, poll `GET /history/{id}` every 100 ms (ST ignores `/ws`), then `GET /view?filename=&subfolder=&type=`; abort via `/interrupt`. The shipped `Char_Avatar_Comfy_Workflow.json` is `ETN_LoadImageBase64(%char_avatar%) → ImageScale → VAEEncode → KSampler(denoise=%denoise%)` — **img2img seeded from the character avatar at denoise 0.7**, the cheapest consistency trick and the right first ship. **A1111**: `/sdapi/v1/txt2img`, `override_settings`, `/sdapi/v1/interrupt`, needs `--api`; its API wiki is unmaintained since 2023-09-09. **NovelAI**: `POST https://image.novelai.net/ai/generate-image`, Bearer token, response is a **ZIP** containing the PNG — the only major cloud backend permitting NSFW, and Precise Reference is the closest thing to a hosted consistency API. ST's **expressions** extension classifies the last message's emotion with a one-word LLM prompt and swaps a sprite — far cheaper than generating per message.

**chub.ai** is broader and **credit-metered, not subscription-metered** (verified against its live gateway): text2img/img2img/inpaint/upscale/tts/stt/voice_clone = 25 credits, expressions/model3d/imagine = 50, video/video2video = 100, background/removebg = 5 (`GET https://gateway.chub.ai/images/costs`). Voice is first-class (`/tts`, `/stt`, `/voice_clone`, `/voices`, `/live/voice`). Mars $20/mo = unlimited voice + multimedia; Mercury $5/mo = 600 credits; free = ~300 one-time. **All auth is header API keys and CORS allow-origin is pinned to `https://chub.ai`** — a third-party browser client needs a proxy, awkward for a host-nothing app. Full OpenAPI (197 paths) at `https://gateway.chub.ai/openapi.json`. **JanitorAI** has no in-chat generation.

**Character consistency.** Avatar img2img (denoise 0.6–0.8) is the free first step. Per-character **LoRA** is the fidelity winner: `kohya-ss/sd-scripts` (Apache-2.0, pushed 2026-09-24) and `ostris/ai-toolkit` (MIT, pushed 2026-09-27, ships `train_lora_flux_24gb.yaml`) — plan on 24 GB VRAM or a rented GPU; inference then costs nothing extra (fal `flux-lora` $0.035/MP). The SDXL identity-adapter ecosystem has **visibly stalled**: `tencent-ailab/IP-Adapter` last push **2024-06-28**, `cubiq/ComfyUI_IPAdapter_plus` **maintenance-only since 2025-04-14**, `instantX-research/InstantID` **2024-07-18**. `ToTheBeginning/PuLID` (pushed 2025-07-31) covers SDXL + Flux. Newer edit models (Flux Redux/Kontext, Qwen-Image-Edit, Nano Banana refs) are where activity is. NovelAI's documented trick: generate a `multiple views, turnaround, reference sheet` of a standing figure on a plain background at one of 1024×1536 / 1472×1472 / 1536×1024, since Character Reference always normalises to those sizes.

## (d) Cost reality check

200 messages/day × ~150 chars + 10 images/day (≈900k TTS chars, 300 images/month):

| Configuration | TTS | STT | Images | Total |
|---|---|---|---|---|
| Kokoro local + Groq + AI Horde | $0 | ~$0.03 | $0 | **≈$0** |
| ElevenLabs Flash + Groq + fal FLUX | $36 | ~$0.03 | $7.50 | **≈$44** |
| ElevenLabs v4 + OpenAI + Nano Banana Pro | $20 promo / $72 list | ~$0.10 | $40 | **$60–112** |
| ElevenLabs + NovelAI Opus (NSFW-capable) | $36 | $0 | $25 flat | **≈$61** |

Latency: TTS first-audio 75 ms (ElevenLabs Flash) → ~300 ms (Kokoro GPU) → 1–3.5 s (Kokoro CPU/WASM). STT 100–400 ms/clip. Images 1–4 s (fal Flux, local SDXL) → 30–165 s (AI Horde anonymous at peak).

### Shortlist

1. **TTS — two adapters, not ten.** (i) OpenAI-compatible `/v1/audio/speech` (covers OpenAI, Kokoro-FastAPI, most self-hosted servers in one path); (ii) ElevenLabs WS `stream-input` — the only provider with low-latency streaming *and* per-character alignment. Ship **local Kokoro** (Apache-2.0, 82M, in-browser via `kokoro-js` on WebGPU, q8f16 ≈86 MB) as the free/offline/uncensored default: for a BYOK app it removes cost, latency, privacy and content-policy concerns at once.
2. **STT — clip-and-POST.** One OpenAI-compatible `/v1/audio/transcriptions` adapter (Groq for price, OpenAI for quality — both reuse keys the user already has) plus local `whisper.rn`/`whisper-server`. Do not ship Web Speech.
3. **Images — abstract at the workflow level.** `generateImage(prompt, negative, w, h, seed, refs) → bytes` with four implementations: A1111/SD.Next, ComfyUI (`/prompt` → poll `/history` → `/view`, `%placeholder%` templating, `%char_avatar%` img2img), OpenAI-compatible `/v1/images/generations`, and NovelAI. Add AI Horde as a free bonus tier with its priority caveats surfaced in the UI.
4. **Consistency ladder**: avatar img2img → per-character LoRA (user-trained or hosted) → reference adapters where supported. Store per-character prompt/negative prefix + reference image, marked shareable so they travel with the card.
5. **Storage/rendering**: adopt ST's model — per-character folder, `media[]` on the message rather than inline Markdown, images hidden from the LLM by default with an opt-in "let the character see it", plus a per-character gallery.

## Sources

https://elevenlabs.io/pricing/api · https://elevenlabs.io/use-policy · https://elevenlabs.io/docs/overview/models · https://elevenlabs.io/docs/api-reference/text-to-speech/convert · https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input · https://developers.openai.com/api/docs/pricing · https://developers.openai.com/api/docs/guides/text-to-speech · https://developers.openai.com/api/docs/guides/image-generation · https://developers.openai.com/api/docs/guides/transcription · https://developers.openai.com/api/docs/guides/realtime-vad · https://openai.com/policies/usage-policies/ · https://cloud.google.com/text-to-speech/pricing · https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd · https://policies.google.com/terms/generative-ai/use-policy · https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/image-generation · https://azure.microsoft.com/en-us/pricing/details/speech/ · https://prices.azure.com/api/retail/prices · https://aka.ms/AI-CoC · https://deepgram.com/pricing · https://console.groq.com/docs/speech-to-text · https://www.assemblyai.com/pricing · https://huggingface.co/hexgrad/Kokoro-82M · https://www.npmjs.com/package/kokoro-js · https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX · https://github.com/remsky/Kokoro-FastAPI · https://huggingface.co/api/models/coqui/XTTS-v2 · https://github.com/idiap/coqui-ai-TTS · https://github.com/coqui-ai/TTS/issues/3490 · https://github.com/OHF-Voice/piper1-gpl · https://github.com/rany2/edge-tts · https://github.com/resemble-ai/chatterbox · https://github.com/resemble-ai/Perth · https://github.com/fishaudio/fish-speech · https://github.com/ggml-org/whisper.cpp · https://github.com/mybigday/whisper.rn · https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition · https://bugs.webkit.org/show_bug.cgi?id=225298 · https://issues.chromium.org/issues/41172064 · https://docs.sillytavern.app/extensions/tts/ · https://docs.sillytavern.app/extensions/stable-diffusion/ · https://docs.sillytavern.app/extensions/speech-recognition/ · https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/extensions/tts/readme.md · https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/stable-diffusion.js · https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/novelai.js · https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/images.js · https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/speech.js · https://github.com/SillyTavern/SillyTavern/blob/main/src/constants.js · https://github.com/SillyTavern/SillyTavern/blob/main/default/content/Char_Avatar_Comfy_Workflow.json · https://docs.chub.ai/docs/the-basics/just-chatting · https://docs.chub.ai/docs/stages/overview · https://gateway.chub.ai/openapi.json · https://gateway.chub.ai/images/costs · https://theunofficialguidetochubai.wordpress.com/2024/12/12/use-images-in-chat/ · https://docs.novelai.net/en/image/models · https://docs.novelai.net/en/image/precisereference · https://docs.novelai.net/en/image/vibetransfer · https://docs.novelai.net/en/subscription/ · https://docs.novelai.net/en/faq/ · https://fal.ai/models/fal-ai/flux/dev · https://fal.ai/models/fal-ai/flux-lora · https://fal.ai/pricing · https://replicate.com/pricing · https://docs.bfl.ai/quick_start/pricing · https://www.runpod.io/pricing · https://aihorde.net/ · https://aihorde.net/api/swagger.json · https://github.com/Haidra-Org/AI-Horde · https://github.com/Haidra-Org/haidra-assets/blob/main/docs/kudos.md · https://docs.comfy.org/development/comfyui-server/comms_routes · https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API · https://github.com/Haoming02/sd-webui-forge-classic · https://github.com/vladmandic/sdnext · https://github.com/kohya-ss/sd-scripts · https://github.com/ostris/ai-toolkit · https://github.com/tencent-ailab/IP-Adapter · https://github.com/cubiq/ComfyUI_IPAdapter_plus · https://github.com/instantX-research/InstantID · https://github.com/ToTheBeginning/PuLID · https://huggingface.co/black-forest-labs/FLUX.1-dev · https://huggingface.co/black-forest-labs/FLUX.1-schnell
