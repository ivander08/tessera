# TTS Provider Matrix for a BYOK Roleplay/Chat App

Researched 2026-09-29. All prices USD. "TTFA" = time-to-first-audio.

## Summary table

| Provider | Price /1M chars | Streaming | Cloning | NSFW | Self-host |
|---|---|---|---|---|---|
| ElevenLabs | $40 (Flash/Turbo) – $80 (v3/v4 list) | HTTP `/stream` + WS `stream-input` | IVC free-tier+, PVC Creator+ | Policy silent on adult; fictional carve-out | No |
| OpenAI | tts-1 $15; tts-1-hd $30; gpt-4o-mini-tts $0.60/M text + $12/M audio tok | `stream_format: audio\|sse` | Custom voice, gated | No blanket ban; CSAM/NCII banned | No |
| Google Cloud TTS | Standard $4; Neural2 $16; Chirp3:HD $30; Studio $160; Instant clone $60 | Bidirectional `StreamingSynthesize` (Chirp3-HD only) | Chirp 3 Instant Custom Voice $60/M | **Prohibited** (sexually explicit) | No |
| Gemini TTS | 3.8-Flash $0.50/M text + $9/M audio tok | `stream: true` | Voice design + replication | **Prohibited** | No |
| Azure Speech | Neural $15; Neural HD $22; Custom Neural $24 | Chunked HTTP; SDK WebSocket | Custom Neural $24/M + $52/hr training + $4.03/hr hosting | **Prohibited** (erotic/pornographic/fetish) | No |
| Kokoro-82M | Free / <$1/M hosted | `TextSplitterStream`; WS via FastAPI | No (voice mixing/tuning) | None (license has no AUP) | Apache-2.0, ~330 MB fp32 / 86 MB q8f16 |
| XTTS-v2 | Free, non-commercial only | `inference_stream` (<200 ms claim) | 6 s zero-shot | None in license | CPML non-commercial, ~2.1 GB weights |
| Piper | Free | Raw PCM `--output-raw`, HTTP `/synthesize` | No | None (GPL engine, MIT voices) | GPL-3.0, 63–121 MB per voice, RPi4-class |
| edge-tts | Free (unofficial) | WS, chunked MP3 | No | None, but ToS-hostile | LGPLv3 client |
| Chatterbox | Free | Not built in (server wrappers add it) | 10 s zero-shot | None (MIT) | MIT; 110M–500M params, ~2.3–3.5 GB VRAM |
| Fish Speech S2 | Free weights (non-commercial); API $15/M bytes | WS `/v1/tts/live`; API `latency="balanced"` | 10–30 s zero-shot | None in license | Research License, 4B params, 2×H100/H200 official |

## Cloud providers

**ElevenLabs** — Models: `eleven_v4` ($0.08/1k, promo $0.022 until Oct 12 2026, 10k char cap), `eleven_v4_turbo` ($0.04/1k, promo $0.011, ~100 ms median inference latency), `eleven_v3` ($0.08/1k, 5k chars), `eleven_v3_conversational` ($0.04/1k, ~280 ms), `eleven_multilingual_v2` ($0.08/1k, 10k chars), `eleven_flash_v2_5` ($0.04/1k, ~75 ms, **40,000 char cap** — the largest). `eleven_turbo_v2_5`/`eleven_turbo_v2` are deprecated in favour of Flash. Free tier = 10,000 credits/month; TTS costs 1 credit/char on v2 Multilingual, 0.5–1 credit/char on Flash/Turbo. API: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream`, auth header `xi-api-key`, `output_format` enum (`mp3_44100_128` default; `mp3_44100_192` needs Creator+, `pcm_44100` needs Pro+). WebSocket input-streaming at `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input` with `auto_mode`, `inactivity_timeout` (max 180 s), and per-chunk base64 audio + char alignment. Cloning: Instant (IVC, <2 min samples, most plans) and Professional (PVC, Creator+, voice-captcha verified). NSFW: the Prohibited Use Policy (last updated 2026-08-17) bans CSAM, "unauthorized sexualization", and non-consensual impersonation, but §8 explicitly exempts "purely fictional contexts" for violent/hateful material — there is **no explicit clause banning consensual adult sexual content** [INFERENCE: erotic fictional roleplay is not clearly prohibited, but it is not affirmatively permitted either]. Free tier forbids commercial use.

**OpenAI** — `tts-1` $15/1M chars, `tts-1-hd` $30/1M chars; `gpt-4o-mini-tts` is token-billed at $0.60/1M text tokens in + $12/1M audio tokens out (the per-minute conversion is [UNVERIFIED] — no primary tokens/second figure found). API: `POST https://api.openai.com/v1/audio/speech`, `Authorization: Bearer`. `input` max 4096 chars (model page says 2000 input tokens). `response_format` ∈ {mp3, opus, aac, flac, wav, pcm}; `stream_format` ∈ {sse, audio} (`sse` unsupported on tts-1/tts-1-hd). 13 built-in voices; custom voices are limited-access (consent recording with a mandated phrase, ≤20/org, ≤30 s sample). Policies (effective 2025-10-29) ban CSAM, non-consensual intimate content, underage sexual roleplay, and voice cloning without consent; adult content between adults is not blanket-banned, but disclosure that the voice is AI is required.

**Google Cloud TTS** — Standard/WaveNet $4/M (4M free/mo), Neural2 $16/M, Chirp 3: HD $30/M, Studio $160/M, Chirp 3 Instant Custom Voice $60/M (no free tier); 1M free chars/mo for Neural2/Studio/Chirp3-HD. REST `POST https://texttospeech.googleapis.com/v1beta1/text:synthesize`, OAuth2 `cloud-platform` scope, JSON in, base64 `audioContent` out. Hard limit **5,000 bytes per request**. Streaming only via `StreamingSynthesize` — bidirectional gRPC ("receives audio while sending text"), and the voice-type table marks only Chirp 3: HD as streaming-capable. Gemini TTS: `gemini-3.8-flash-tts` $0.50/M text tokens + $9/M audio tokens (promo to 2026-12-31), `gemini-3.8-flash-lite-tts` $0.50 + $6.00, legacy `gemini-2.5-flash-preview-tts` $0.50 + $10.00; audio tokens = **25 tokens per second of audio** (so Flash TTS ≈ $0.0135/min). `stream: true` returns headerless `audio/l16` 24 kHz PCM chunks; unary returns WAV. Limits: 8,192 input tokens, 16,384 output tokens, 2 speakers max in one request, 200 stored custom voices/project with 1-year TTL. Voice replication is a first-class feature. NSFW: the Generative AI Prohibited Use Policy bans "sexually explicit content — for example, content created for the purpose of pornography or sexual gratification". **Prohibited.**

**Azure Speech** — Neural $15/1M chars (eastus retail API), Neural HD $22/1M, Custom Neural realtime $24/1M and long-audio $100/1M, training $52/compute-hr, endpoint hosting $4.032/hr, Personal Voice $24/1M + $600 per 1k profiles/mo. Free F0 tier = 0.5M chars/mo. REST `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`, `Content-Type: application/ssml+xml`, auth `Ocp-Apim-Subscription-Key` or Bearer, **`X-Microsoft-OutputFormat` is required** — streaming values (`audio-24khz-48kbitrate-mono-mp3`, `raw-24khz-16bit-mono-pcm`, `webm-24khz-16bit-mono-opus`) vs non-streaming (`riff-24khz-16bit-mono-pcm`). The response body "can be played as it's transferred". Limits: 10 min audio/request, ≤50 `<voice>`/`<audio>` tags, 64 KB SSML per WebSocket turn, 30 TPS default (raisable to 1,000). NSFW: the Enterprise AI Services Code of Conduct states Microsoft "prohibits content that is erotic, pornographic, or otherwise sexually explicit... This includes sexually suggestive content, depictions of sexual activity, and fetish content." **Prohibited.**

## Local / open-weight

**Kokoro-82M** — 82M params, **Apache-2.0** (both HF model card and repo LICENSE). 11.5M HF downloads; repo last pushed 2025-08-06, so it is stable rather than actively developed. 54 voices across 8 language codes; `af_heart` (grade A) and `af_bella` (A-) are the best English voices. `kokoro-js` 1.2.1 (npm, Apache-2.0, last published 2025-05-03) runs it fully in-browser via Transformers.js with `device: "webgpu"` and `dtype` ∈ {fp32, fp16, q8, q4, q4f16}; ONNX weights at `onnx-community/Kokoro-82M-v1.0-ONNX` (fp32 325 MB, q8f16 86 MB). `TextSplitterStream` gives incremental generation as text arrives — ideal for LLM token streaming. `remsky/Kokoro-FastAPI` (Apache-2.0, 5,495★, pushed 2026-09-10) is an OpenAI-compatible `/v1/audio/speech` server with CPU/CUDA/ROCm Docker images, SSML, multi-speaker mixing, and `stream: true`. No voice cloning — `inno-kokoro` tuning blends voices rather than cloning. No AUP in the license. Market API rate <$1/M chars.

**XTTS-v2** — `coqui/XTTS-v2`, license "other" = **Coqui Public Model License 1.0.0**, which opens: "This license allows only non-commercial use of a machine learning model and its outputs." 6-second zero-shot cloning, 17 languages, 24 kHz. `inference_stream()` with `stream_chunk_size`; README claims <200 ms latency. Weights ≈2.1 GB (model.pth 1.87 GB + dvae.pth 210 MB). Coqui the company shut down in January 2024 (issue #3490 filed 2024-01-04 citing "the recent announcement that Coqui is shutting down"), leaving the commercial-license path dead — discussion #4304 (2025-06-19) asks who now grants commercial licenses and got no answer. The maintained community fork is `idiap/coqui-ai-TTS` (MPL-2.0, 2,332★, pushed 2026-06-10, PyPI `coqui-tts`). **The CPML non-commercial restriction still governs the weights.** Unsuitable for a paid app.

**Piper** — `rhasspy/piper` is **archived** (last push 2025-08-26, MIT, 11,292★); its README is now just "Development has moved". Successor is `OHF-Voice/piper1-gpl` (**GPL-3.0**, 5,711★, pushed 2026-09-28, releases through v1.8.0 on 2026-09-04) — actively maintained by the Open Home Foundation, which is currently seeking maintainers. Engine GPL-3.0 is a licensing consideration for a closed-source app if linked in-process; the HTTP server (`python -m piper.http_server`, `/synthesize` POST, WAV out) keeps it at arm's length. Voices on `rhasspy/piper-voices` are MIT; sizes 63 MB (en_US-lessac-medium) to 121 MB (en_US-ryan-high). Explicitly "optimized for the Raspberry Pi 4", i.e. CPU-realtime on very weak hardware. No cloning.

**edge-tts** — `rany2/edge-tts`, **LGPLv3** (MIT only for `srt_composer.py`), 12,122★, PyPI 7.2.8 released 2026-03-22 — **still working in 2026**. It is a reverse-engineered client of `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` using a hardcoded `TrustedClientToken` and a spoofed `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold` plus an Edge User-Agent. Free, no key, 300+ voices, chunked MP3 over WebSocket, `<200 ms`-class. Risks: undocumented and unsanctioned by Microsoft, no ToS grant, spoofing is deliberate evasion of client verification; open issues report intermittent 503 handshakes and `NoAudioReceived` (2026-04, 2026-07). Treat as a free-tier convenience with an outage plan, never as a paid-tier dependency.

**Chatterbox (Resemble AI)** — `resemble-ai/chatterbox`, **MIT**, 26,611★, pushed 2026-07-21. Four models: original 500M English, Multilingual V3 500M (23 languages), **Turbo 350M** (English, 1-step decoder, native `[laugh]`/`[cough]`/`[chuckle]` tags), **Nano 110M** (English, "3x faster than realtime on 8 CPU cores"). Controls: `exaggeration` (default 0.5) and `cfg_weight` (default 0.5) — the first open model with emotion-exaggeration control. Zero-shot cloning from a ~10 s reference clip. **Every output is watermarked** with PerTh (`perth.PerthImplicitWatermarker`), which survives MP3 compression and is ~100% detectable — a real constraint if the app wants unmarked output. VRAM from NVIDIA's own ACE sample: ~2.3 GB Turbo-only, ~3.5 GB Multilingual, ~8.5 GB full pipeline; RTF 0.22 measured on an RTX 5080 for Turbo. Resemble's hosted service claims sub-200 ms latency.

**Fish Speech / OpenAudio** — `fishaudio/fish-speech` is **NOASSERTION** = the **Fish Audio Research License** (last updated 2026-03-07): "Any use of the Fish Audio Materials or Derivative Works for a Commercial Purpose requires a separate written license agreement." Commercial Purpose explicitly includes "(i) creating, modifying, or distributing Your product or service, including via a hosted service or application programming interface". The `fishaudio/openaudio` GitHub repo does not exist (404); OpenAudio S1-mini was a brand for the fish-speech-1.5-era model, and `fishaudio/s1-mini` is **gated** on HF (401 to anonymous reads) with card license `cc-by-nc-sa-4.0` — also non-commercial. Current flagship is S2 Pro (4B params, `fishaudio/s2-pro`, license "other"). Vendor-published latency on a single H200: RTF 0.195, TTFA ~100 ms; API `latency="balanced"` gives ~300 ms TTFA. Cloning: zero-shot from a 10–30 s sample, or a saved `reference_id`. API `POST https://api.fish.audio/v1/tts` at $15/M UTF-8 bytes (≈180k English words), with `s2.1-pro-free` at $0 for dev; WebSocket at `wss://api.fish.audio/v1/tts/live`. Official self-hosting baseline is 2 GPUs minimum (inference worker + vocoder), NVIDIA H100/H200 — not a desktop-class target.

## Notes for the design doc

- **NSFW is the decisive axis.** ElevenLabs is the only hosted provider whose policy text does not clearly ban consensual adult sexual content, and even there it is unstated rather than granted. OpenAI permits adult content between adults but bans NCII and underage roleplay. Google, Azure and (by Code of Conduct) Microsoft-hosted TTS are hard nos. That leaves local models as the only unambiguously policy-free path — and of those, **only Kokoro (Apache-2.0), Piper (GPL engine + MIT voices) and Chatterbox (MIT) are commercially usable**. XTTS-v2 (CPML) and Fish Speech (Research License) are non-commercial only, which rules them out for a paid app despite their better cloning.
- **Longest single request** matters for chapter-length replies: ElevenLabs Flash v2.5 (40,000 chars) > Google (5,000 bytes) > OpenAI (4,096 chars) > Azure (10 min of audio) > Gemini (8,192 input tokens).
- **Cheapest credible hosted tier** is OpenAI `tts-1` at $15/M, tied with Azure Neural and Fish Audio; Kokoro self-hosted or via DeepInfra ($0.80/M) is roughly 20× cheaper.
- **On-device story** is Kokoro-82M via `kokoro-js` on WebGPU/WASM (~86 MB q8f16) for desktop and mobile web; Chatterbox-Nano (110M, MIT, 3× realtime on 8 CPU cores) is the alternative when voice cloning is required offline.

## Sources

- https://elevenlabs.io/pricing/api
- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/api-reference/text-to-speech/stream
- https://elevenlabs.io/docs/api-reference/websockets
- https://elevenlabs.io/docs/overview/capabilities/voices
- https://elevenlabs.io/use-policy
- https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
- https://developers.openai.com/api/docs/guides/text-to-speech.md
- https://developers.openai.com/api/docs/guides/custom-voices.md
- https://developers.openai.com/api/docs/models/gpt-4o-mini-tts.md
- https://developers.openai.com/api/docs/pricing
- https://openai.com/policies/usage-policies/
- https://cloud.google.com/text-to-speech/pricing
- https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1beta1/text/synthesize
- https://docs.cloud.google.com/text-to-speech/docs/reference/rpc/google.cloud.texttospeech.v1beta1
- https://cloud.google.com/text-to-speech/docs/create-audio-text-streaming
- https://cloud.google.com/text-to-speech/docs/list-voices-and-types
- https://cloud.google.com/text-to-speech/quotas
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts
- https://ai.google.dev/gemini-api/docs/terms
- https://policies.google.com/terms/generative-ai/use-policy
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
- https://prices.azure.com/api/retail/prices (Azure Speech, eastus)
- https://aka.ms/AI-CoC
- https://huggingface.co/hexgrad/Kokoro-82M
- https://huggingface.co/hexgrad/Kokoro-82M/raw/main/VOICES.md
- https://github.com/hexgrad/kokoro
- https://raw.githubusercontent.com/hexgrad/kokoro/main/kokoro.js/README.md
- https://www.npmjs.com/package/kokoro-js
- https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- https://huggingface.co/spaces/webml-community/kokoro-webgpu
- https://github.com/remsky/Kokoro-FastAPI
- https://huggingface.co/coqui/XTTS-v2
- https://huggingface.co/coqui/XTTS-v2/raw/main/LICENSE.txt
- https://github.com/coqui-ai/TTS/issues/3490
- https://github.com/coqui-ai/TTS/discussions/4304
- https://github.com/idiap/coqui-ai-TTS
- https://github.com/rhasspy/piper
- https://github.com/OHF-Voice/piper1-gpl
- https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md
- https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/CLI.md
- https://huggingface.co/rhasspy/piper-voices
- https://github.com/rany2/edge-tts
- https://raw.githubusercontent.com/rany2/edge-tts/master/src/edge_tts/constants.py
- https://pypi.org/pypi/edge-tts/json
- https://github.com/resemble-ai/chatterbox
- https://huggingface.co/ResembleAI/chatterbox
- https://huggingface.co/ResembleAI/chatterbox-nano
- https://github.com/resemble-ai/Perth
- https://docs.nvidia.com/ace-for-games/chatterbox-tts/samples.html
- https://github.com/fishaudio/fish-speech
- https://raw.githubusercontent.com/fishaudio/fish-speech/main/LICENSE
- https://huggingface.co/fishaudio/s2-pro
- https://docs.fish.audio/features/text-to-speech.md
- https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits.md
- https://docs.fish.audio/developer-guide/self-hosting/requirements.md
- https://docs.fish.audio/api-reference/endpoint/websocket/tts-live.md
