# STT / voice input for a BYOK desktop+mobile roleplay chat app

Research date: **2026-09-29**. All prices USD list-price, PAYG tier, unless noted.
Scope: push-to-talk / dictation into a chat composer. No user-hosted server.

---

## 0. TL;DR recommendation

**Ship two tiers, default to the cheap cloud one.**

1. **Default: cloud STT with a short push-to-talk clip.** Record with `MediaRecorder`/native recorder, POST the clip to a Whisper-compatible endpoint the user already has a key for (Groq `whisper-large-v3-turbo` at **$0.04/hr ≈ $0.0007/min** is the price/performance winner; OpenAI `gpt-transcribe` at **$0.0045/min** is the quality/boring default). Cost per 5-second utterance is a rounding error (<$0.0001). This is 1 HTTP call, no WebSocket lifecycle, no VAD, works identically on every platform, and works in a WebView.
2. **Opt-in: local whisper.cpp** for privacy/offline users. On desktop this is trivial (`whisper-server` sidecar or WASM). On mobile use `whisper.rn` with `base`/`small` q8 — Snapdragon 8 Elite encoder timings are 61 ms / 166 ms for a 30 s window, i.e. comfortably realtime.
3. **Do not build on the browser `SpeechRecognition` API.** It is unavailable in Android WebView, unavailable in iOS WKWebView / SafariViewController / home-screen PWAs, absent in Firefox, and in Chrome it silently ships the user's microphone audio to Google servers. For a privacy-positioned BYOK app this is disqualifying.
4. **Do not use OpenAI Realtime transcription sessions for push-to-talk.** `gpt-live-transcribe` explicitly does **not** support `server_vad`/`semantic_vad`; you must run your own VAD and send `input_audio_buffer.commit`. That is a WebSocket, a VAD, and a session lifecycle — for a chat app's push-to-talk the clip-and-POST path is strictly simpler and cheaper.

---

## 1. OpenAI transcription API

### 1.1 Models and endpoints (as of 2026-09-29)

| Model ID | Route | Price | Notes |
|---|---|---|---|
| `gpt-transcribe` | `/v1/audio/transcriptions` (+ realtime transcription sessions) | **$0.0045/min** | OpenAI's *recommended* file model. Supports `stream=true` (SSE deltas on a *completed* file), `prompt`, `keywords`, `languages`. No timestamps. |
| `gpt-live-transcribe` | realtime transcription sessions only | **$0.017/min** | Recommended realtime model. Tunable `delay`: `minimal`/`low`/`medium`/`high`/`xhigh`. No timestamps, no speaker labels, no confidence. |
| `gpt-realtime-whisper` | realtime transcription sessions | **$0.017/min** | Prior realtime streaming model; still supported. |
| `gpt-realtime-translate` | realtime translation sessions | **$0.034/min** | Live translation. |
| `gpt-4o-transcribe` | `/v1/audio/transcriptions`; Realtime endpoint | **$0.006/min** ($2.50/1M in, $10/1M out) | Legacy-but-supported. Better WER than `whisper-1`. `json` response format only. |
| `gpt-4o-mini-transcribe` | `/v1/audio/transcriptions` | **$0.003/min** ($1.25/1M in, $5/1M out) | Cheapest OpenAI option. Default snapshot `gpt-4o-mini-transcribe-2025-12-15`. |
| `gpt-4o-transcribe-diarize` | `/v1/audio/transcriptions` | **$0.006/min** | Speaker labels via `response_format=diarized_json` + `chunking_strategy`. **Not** supported in Realtime sessions. No `prompt`. |
| `whisper-1` | `/v1/audio/transcriptions`, `/v1/audio/translations` | **$0.006/min** | Only model with **word/segment timestamps** (`verbose_json` + `timestamp_granularities[]`), `srt`/`vtt`, and English **translation**. 224-token prompt limit. No streaming. |

Source: <https://developers.openai.com/api/docs/pricing> (Transcription models table), <https://developers.openai.com/api/docs/guides/transcription>, model pages `.../models/whisper-1`, `.../models/gpt-transcribe`, `.../models/gpt-live-transcribe`, `.../models/gpt-4o-transcribe`, `.../models/gpt-4o-mini-transcribe`, `.../models/gpt-realtime-whisper`.

### 1.2 Limits and formats

- **Max file size: 25 MB** on `/v1/audio/transcriptions`. For larger audio, compress or chunk at ≤25 MB, avoiding splits mid-sentence. (`guides/speech-to-text` § "Longer inputs")
- **Supported input formats: `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`.** (same page)
- `gpt-transcribe` and `gpt-live-transcribe` accept `prompt` (free-form context), `keywords[]` (literal terms), `languages[]` (ISO 639-1 / selected 639-3 / regional `zh-*`). `languages` replaces the singular `language` — do not send both.
- Keyword constraints: one term per line, no `<`, `>`, CR or LF; the API rejects the whole request on violation.
- `whisper-1` prompt limit is **224 tokens**; `gpt-4o-transcribe*` support prompting but not `keywords`/`languages`; `gpt-4o-transcribe-diarize` supports neither.

### 1.3 Streaming vs Realtime — the key distinction

OpenAI's own docs draw this line explicitly: *"Streaming output and live audio are separate decisions. You can stream the transcription of a completed file without opening a Realtime session."* (`guides/transcription`)

- **File streaming**: `stream=true` with `gpt-transcribe` → `transcript.text.delta` events, then a final `transcript.text.done`. Also supported on `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`. **`whisper-1` does not stream.**
- **Realtime transcription session**: create with `type: "transcription"`. Events: `conversation.item.input_audio_transcription.delta` and `.completed`. Audio sent as base64 PCM16 via `input_audio_buffer.append`, with `input_audio_buffer.commit` to finalize a turn. Connect over WebSocket (server-side pipelines) or WebRTC (browser).

### 1.4 Server VAD — the answer is model-dependent

From `guides/realtime-vad`:

> "In transcription Realtime sessions, turn detection support depends on the transcription model. Models that support VAD default to `server_vad`, while **`gpt-live-transcribe` and `gpt-realtime-whisper` require turn detection to be omitted or set to `null`**. Send `input_audio_buffer.commit` to finish each audio turn with these models."

And `guides/realtime-transcription` states it flatly:

> "In `gpt-live-transcribe` transcription sessions, omit `audio.input.turn_detection` or set it to `null`. **The model doesn't support `server_vad` or `semantic_vad`.** ... Use client-side VAD to detect the end of speech, then send `input_audio_buffer.commit`."

So: **server VAD exists in the Realtime API** (`server_vad` with `threshold`, `prefix_padding_ms`, `silence_duration_ms`; and `semantic_vad` with `eagerness`), **but not for the recommended live-transcription model.** `gpt-4o-transcribe` supports the Realtime endpoint but the model page lists *Realtime transcription sessions as "Not supported"* — i.e. it is usable as the input-transcription model inside a speech-to-speech session, not as a standalone transcription session. `gpt-transcribe` **is** supported in transcription sessions and is documented for the "committed turn" workflow (WebSocket only).

Practical consequence: a push-to-talk chat app that uses OpenAI realtime must implement its own endpointing (energy threshold or Silero VAD) and send `commit`. Given that, the Realtime session buys you nothing over recording a clip and POSTing it.

---

## 2. Other cloud STT

### 2.1 Deepgram

Streaming (`wss://api.deepgram.com/v1/listen`; Flux uses `/v2/listen`):

| Model | PAYG streaming | Growth |
|---|---|---|
| Flux English (`flux-general-en`) | $0.0065/min (promo; reg. $0.0077) | $0.0057/min |
| Flux Multilingual (`flux-general-multi`) | $0.0078/min | $0.0068/min |
| Nova-3 Monolingual | $0.0048/min (promo; reg. $0.0077) | $0.0042/min |
| Nova-3 Multilingual | $0.0058/min (promo; reg. $0.0092) | $0.0050/min |

Pre-recorded: Nova-3 $0.0043/min; Nova-3 Multilingual $0.0052/min; Whisper Large $0.0048/min.
Add-ons stack: Keyterm Prompting $0.0013/min, Redaction $0.0020/min, Diarization $0.0020/min (streaming).

Source: <https://deepgram.com/pricing> (2026-09-29). Promo rates explicitly marked "limited-time promotional rates on streaming".

**Latency** (Deepgram's own guidance, `developers.deepgram.com/docs/measuring-streaming-latency`):
- transcription latency 150–300 ms (they target ≤300 ms)
- total client-observed transcript latency 200–500 ms
- Flux end-of-turn detection 100–500 ms; Flux quickstart claims ~260 ms EOT
- buffer sizes should be 20–100 ms of audio; Flux specifically recommends **80 ms chunks**

**Nova-3 accuracy claim**: "54.2% reduction in word error rate (WER) for streaming and 47.4% for batch processing compared to competitors" (`docs/models-languages-overview`). 45+ languages. This is a vendor claim; treat as directional.

**Flux** is the interesting one for a chat app: model-native turn detection with `eot_threshold` (default 0.7), `eager_eot_threshold` for speculative early responses, `eot_timeout_ms` (default 5000). Note the documented cost caveat: using `EagerEndOfTurn` "can increase LLM API calls by 50-70% due to speculative response generation."

### 2.2 AssemblyAI

| Model | Price |
|---|---|
| Universal-3.5 Pro (pre-recorded) | $0.21/hr |
| Universal-2 (pre-recorded) | $0.15/hr |
| Universal-3.6 Pro Realtime (`universal-3-6-pro`) | $0.45/hr |
| Universal-Streaming English / Multilingual | $0.15/hr |
| Voice Agent API (STT+LLM+TTS, `wss://agents.assemblyai.com/v1/ws`) | $4.50/hr ($0.075/min) |

Source: <https://www.assemblyai.com/pricing> (page self-dates "Last updated: 2026-09-28").

**Critical billing gotcha, quoted verbatim:** *"Streaming is billed per session duration — the time the WebSocket connection is open, not the duration of audio sent. Idle connection time counts. Close connections immediately when calls end."* For a chat app holding a socket open between utterances this is a real money leak.

Current streaming endpoint is `wss://streaming.assemblyai.com/v3/ws`; the v2 endpoint (`wss://api.assemblyai.com/v2/realtime/ws`) is **inactive**.

Benchmarks (vendor, `assemblyai.com/llms/models.md`): Universal-3.5 Pro English mean WER 5.6% (median 4.9%); Universal-3.6 Pro Realtime on 12,460 voice-agent conversations: normalized WER 5.13%, short-utterance error rate 1.45%, median end-of-turn latency 537 ms, P50 ~150 ms post-VAD.

### 2.3 Groq Whisper

OpenAI-compatible: `https://api.groq.com/openai/v1/audio/transcriptions` and `.../translations`.

| Model | Cost/hr | Real-time speed factor | WER (vendor) |
|---|---|---|---|
| `whisper-large-v3` | $0.111 | 189× | 10.3% |
| `whisper-large-v3-turbo` | **$0.04** | **216×** | 12% |

Source: <https://console.groq.com/docs/speech-to-text> and `.../docs/model/whisper-large-v3-turbo`.

- Max file size **25 MB (free tier), 100 MB (dev tier)**.
- **Minimum billed length 10 seconds** — a 2-second push-to-talk clip still bills 10 s ($0.00011 for turbo). Fine.
- Supported formats: `flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`, `wav`, `webm`.
- Server downsamples to 16 kHz mono; for lower latency convert to `wav`, for size use `flac`.
- **No streaming endpoint.** Groq's own guidance for large files is client-side chunking with overlap (`groq-api-cookbook/tutorials/audio-chunking`). There is no Realtime/WebSocket transcription API.
- `whisper-large-v3-turbo` does **not** support translation; `whisper-large-v3` does.
- Prompt limit 224 tokens; `response_format` `json`/`verbose_json`/`text`; `timestamp_granularities[]` `segment`/`word`.

**Verdict: best price/performance cloud STT for this app.** 216× realtime means a 10-second clip transcribes in well under 100 ms of model time; the dominant latency is network + upload.

### 2.4 Google Cloud Speech-to-Text

V2 API, standard recognition:

| Volume / month | Price |
|---|---|
| 0 – 500,000 min | **$0.016/min** |
| 500k – 1M min | $0.010/min |
| 1M – 2M min | $0.008/min |
| ≥2M min | $0.004/min |
| Dynamic batch (v2) | $0.003/min |

Source: <https://cloud.google.com/speech-to-text/pricing>. Billed per second of audio, rounded up to 1-second increments. **Multichannel audio is billed per channel** — a 30 s 4-channel request bills 120 s but only counts 30 s against quota.

Models (`docs.cloud.google.com/speech-to-text/docs/transcription-model`, page dated 2026-09-24): `chirp_3` (latest multilingual generative ASR, diarization + auto language detection), `chirp_2`, `telephony`, plus `latest_long`/`latest_short`/`command_and_search`.

**Streaming is gRPC-only** and there is a hard **25 KB limit per streamed request message** (including the initial config), which is a documented footgun for browser clients. Realistically you'd proxy through a server you host — which this project forbids. **Not a good BYOK fit.**

### 2.5 Azure Speech in Foundry Tools

From the Azure retail prices API (`prices.azure.com/api/retail/prices`, `productName eq 'Azure Speech'`, `armRegionName eq 'eastus'`, retrieved 2026-09-29):

| Meter | Price |
|---|---|
| S1 Speech To Text (real-time) | **$1.00 / hour** |
| S1 Speech to Text Batch | $0.18 / hour |
| S1 Custom Speech To Text | $1.20 / hour |
| S1 Speech to Text Enhanced Feature Audio (add-on) | $0.30 / hour |
| Fast Transcription Speech To Text | $0.36 / hour (promo meter $0.10/hr) |
| S1 Conversation Transcription Audio | $1.20 / hour |
| S1 Speech Translation | $2.50 / hour |

Free tier (F0): **5 audio hours/month** for real-time transcription, shared with custom.
Quotas (`learn.microsoft.com/.../speech-services-quotas-and-limits`, updated 2026-09-24): concurrent real-time STT + speech translation requests **combined** = 100 (S0, adjustable); fast/batch transcription share 600 requests/min; fast transcription max file 500 MB / 5 hours.

Azure also fronts OpenAI models (Voice Live API) and has newer `MAI-Transcribe-2` / `MAI-Transcribe-1.5` meters. At **$1.00/hr vs Groq's $0.04/hr** this is 25× more expensive and requires an Azure resource, not a simple API key. **Not recommended for BYOK.**

### 2.6 ElevenLabs Scribe

| Model | Price | Claimed |
|---|---|---|
| `scribe_v2` | **$0.22 / hour** | "Over 98% transcription accuracy", 90+ languages, keyterm prompting (1000 terms), diarization up to 32 speakers, 65 entity types |
| `scribe_v2_realtime` | **$0.39 / hour** | "Low latency (~150ms†)" — †excluding application & network latency |
| `scribe_v2_medical` | $0.22 / hour | 35% fewer clinical errors vs Scribe v2 |

Sources: <https://elevenlabs.io/pricing/api>, <https://elevenlabs.io/docs/overview/models>, `.../docs/overview/capabilities/speech-to-text`.

The "over 98% accuracy" is a vendor claim with no published WER benchmark attached; do not treat as comparable to the ASR-leaderboard numbers above. At $0.22/hr it is 5.5× Groq turbo and 3× Deepgram Nova-3 pre-recorded.

---

## 3. Local whisper.cpp

### 3.1 Project health

- `ggml-org/whisper.cpp`: **54,001 stars, 6,200 forks, MIT**, 346 open issues, last push **2026-09-28T18:35Z**, latest release **v1.9.4 (2026-09-11)**. Not archived. (`gh api repos/ggml-org/whisper.cpp`)

### 3.2 Model sizes and RAM

From `whisper.cpp` README "Memory usage":

| Model | Disk | RAM |
|---|---|---|
| tiny | 75 MiB | ~273 MB |
| base | 142 MiB | ~388 MB |
| small | 466 MiB | ~852 MB |
| medium | 1.5 GiB | ~2.1 GB |
| large | 2.9 GiB | ~3.9 GB |

**Quantized** models from `models/README.md`: `large-v3-turbo-q5_0` **547 MiB**, `large-v3-q5_0` **1.1 GiB**, `large-v2-q5_0` 1.1 GiB. Quantization is done with the bundled `quantize` tool (`q5_0` etc.). `whisper.rn`'s own TIPS doc notes: *"the q8 model demonstrated performance improvements in our Android tests (on devices using Qualcomm or Google SoCs)."*

For a phone, `base-q8_0` (~150 MB) or `small-q8_0` (~500 MB) are the sane targets.

### 3.3 `whisper-server` HTTP endpoint

From `examples/server/README.md`:

- Listens on `--host` (default `127.0.0.1`) `--port` (default `8080`).
- `POST /inference` — multipart form: `file`, `temperature`, `temperature_inc`, `prompt`, `carry_initial_prompt`, `response_format` (`json` etc.).
- `POST /load` — hot-swap the model at runtime via `-F model=<path>`.
- VAD flags: `--vad`, `--vad-model`, `--vad-threshold` (0.5), `--vad-min-speech-duration-ms` (250), `--vad-min-silence-duration-ms` (100), `--vad-max-speech-duration-s`, `--vad-speech-pad-ms` (30), `--vad-samples-overlap` (0.1).
- Silero VAD v6.2.0 model is **864 KB** (`models/download-vad-model.sh silero-v6.2.0`).
- Upstream warning: don't run with admin privileges; it accepts user file uploads and shells out to ffmpeg with `--convert`.

This is a clean drop-in for a desktop app: spawn the sidecar on `127.0.0.1:<random port>`, POST clips, kill on exit. It is a plain multipart API, not OpenAI-shaped, so you need a thin adapter if you want one code path for cloud and local.

### 3.4 CPU realtime factor

whisper.cpp's own benchmark thread is issue #89 ("Benchmark results", opened Oct 2022, still the canonical reference). The numbers below are **encoder time** for a 30 s window plus model load, in ms:

| CPU | Config | tiny | base | small | medium |
|---|---|---|---|---|---|
| MacBook M1 Pro | NEON BLAS, 8 thr | 102 | 220 | 685 | 1928 |
| Mac Mini M1 | NEON BLAS, 4 thr | 194 | 380 | 1249 | 3980 |
| Ryzen 9 5950X | AVX2, 8 thr | 197 | 421 | 1393 | 4404 |
| Ryzen 9 3900X | AVX2, 8 thr | 422 | 880 | 2874 | 9610 |
| Raspberry Pi 4 | NEON, 4 thr | 13839 | 30552 | — | — |

Interpretation for a **modern laptop** (M-series Mac or recent Ryzen): `base` encodes 30 s of audio in **~0.2–0.4 s** and `small` in **~0.7–1.4 s**. Add decoder time proportional to output length, but for a 5–10 s push-to-talk clip you are looking at **well under half a second end-to-end for base, and roughly realtime for small**. `medium` on x86 is ~4.4 s per 30 s window — still faster than realtime but noticeably laggy for interactive use.

Hardware acceleration is available and materially changes this: Core ML (ANE) is *"more than x3 faster compared with CPU-only"*; ANEForge is *"about 2x faster than the Core ML encoder from `tiny` to `medium`"*; CUDA/Vulkan/ROCm/OpenVINO/VitisAI (AMD Ryzen AI NPU)/CANN (Ascend)/MUSA backends all exist.

**Note the numbers are from 2022 hardware.** No recent re-benchmark exists in the repo. Treat the table as a conservative floor. [UNVERIFIED for 2026 laptop hardware — no primary benchmark published for current-gen CPUs in the repo.]

### 3.5 Mobile builds

- **First-party examples**: `examples/whisper.objc` (iOS), `examples/whisper.swiftui` (iOS/macOS), `examples/whisper.android` (Android/JNI). README recommends *"tiny or base models for running on an Android device."*
- **Prebuilt XCFramework** for iOS/visionOS/tvOS/macOS, usable as a SwiftPM `binaryTarget`.
- **`whisper.rn`** (`mybigday/whisper.rn`) is the production-grade React Native binding: **804 stars, MIT, last push 2026-09-29**, npm **v0.7.4** (release 2026-08-27). Ships prebuilt `rnwhisper.xcframework` (iOS) and per-CPU-variant `librnwhisper*.so` (Android, incl. a Hexagon NPU variant), plus an experimental **Hexagon NPU** path on Snapdragon 8 Gen 1+ (auto-enabled when `useGpu` is on and the device qualifies; needs `libcdsprpc.so` in the manifest). Also has `initParakeet` (NVIDIA Parakeet TDT 0.6B v3) and a `RealtimeTranscriber` with Silero VAD, auto-slicing and memory bounds (`maxSlicesInMemory`, `maxResultsInMemory`, `maxPromptSlices`).
- **whisper.rn benchmark, Samsung S25 Ultra (Snapdragon 8 Elite), 4 threads, flash attention on, ms:**

| Model | Enc. | Dec. | 
|---|---|---|
| tiny | 37 | 3.2 |
| base | 62 | 3.5 |
| small | 166 | 10.9 |
| medium | 379 | 24.6 |
| large-v3-turbo | 1010 | 7.5 |

  These are per-30s-window. `base` and `small` are comfortably interactive; `medium` is marginal; `large-v3-turbo` is not realtime on CPU.
- `whisper.rn` TIPS: default `maxThreads` is "2 for 4-core devices, 4 for more cores"; advice is *against* using all cores or fewer than 2. For `medium`/`large` on iOS enable the Extended Virtual Addressing entitlement.

### 3.6 Browser / WASM

- **whisper.cpp WASM** exists (`examples/whisper.wasm`, live demo <https://ggml.ai/whisper.cpp/>). Upstream states: *"you should be able to achieve x2 or x3 real-time for the `tiny` and `base` models on a modern CPU and browser"*, i.e. **transcribe 60 s of audio in ~20–30 s**. The example *"is capable of running all models up to size `small` inclusive. Beyond that, the memory requirements and performance are unsatisfactory."* Only greedy sampling. **Max audio length 120 seconds.** Requires WASM SIMD.
- Measured WASM encoder times from issue #89 on an M1 Pro, 8 threads: Chrome tiny 3776 ms, base 8200 ms (vs 134/168 ms native). Firefox is faster: tiny 2626, base 6226. That is ~**2.5× slower than realtime for base** — acceptable for a 5–10 s clip (≈1–3 s), not acceptable for live streaming.
- **transformers.js** (`huggingface/transformers.js`, 16,331 stars, Apache-2.0, pushed 2026-09-29, npm `@huggingface/transformers` **v4.3.0**, 2026-09-16) is the practical alternative: `AutoModelForSpeechSeq2Seq.from_pretrained('onnx-community/whisper-tiny.en')`, with WebGPU support. It gives you the same ONNX/quantized model zoo plus WebGPU acceleration that whisper.cpp WASM does not have. [UNVERIFIED: no first-party WebGPU latency benchmark for whisper-tiny/base found.]

**Practical browser answer**: WASM whisper is a viable *offline fallback* for short clips on desktop, and a poor choice for mobile browsers. For a Tauri/Capacitor desktop shell, prefer a native `whisper-server` sidecar over WASM.

---

## 4. Browser Web Speech API

### 4.1 Availability matrix

From `mdn/browser-compat-data` `api/SpeechRecognition.json` and caniuse `speech-recognition`:

| Browser | Status |
|---|---|
| Chrome desktop | ✅ unprefixed since **139**; `webkitSpeechRecognition` since **33** |
| Chrome Android | ✅ (mirrors Chrome) |
| Edge | ⚠️ API present, **no events fire** (caniuse note #3); requires the Azure speech component at `edge://components` |
| Opera | ⚠️ same as Edge (note #3) |
| Safari macOS | ⚠️ `webkitSpeechRecognition` since **14.1**; **Siri must be enabled** |
| iOS Safari | ⚠️ prefixed since 14.1 (mirrors Safari) |
| **Firefox** | ❌ **`version_added: "preview"`** — flag-gated behind `media.webspeech.recognition.enable`; *"actual support is waiting for permissions to be sorted out"* (caniuse note #2) |
| Samsung Internet | ✅ (Blink) |

**Safari-specific exclusions, quoted from caniuse note #4:**
> "Safari 14.1 and TP 119+ include prefixed support for `webkitSpeechRecognition` without support for `SpeechGrammar` or `SpeechGrammarList`. Siri needs to be enabled. **[Not available in SafariViewController and web apps added to Home Screen]**"

Confirmed upstream by WebKit engineer Sihui Liu in bug 225298: *"Yes, SpeechRecognition API is not available in SafariViewController and web apps added to Home Screen for now. There are some implementation details we need to figure out before we can enable it."* The bug has been open since 2021 and the thread is a string of "any update?" with no resolution — treat as permanent for planning purposes.

### 4.2 The Chrome privacy caveat

MDN's `SpeechRecognition` page carries this note:

> "On some browsers, like Chrome, using Speech Recognition on a web page involves a server-based recognition engine. **Your audio is sent to a web service for recognition processing, so it won't work offline.**"

Chrome's own Web Speech API blog post confirms the architecture and adds: *"Pages hosted on HTTPS do not need to ask repeatedly for permission, whereas HTTP hosted pages do."* The audio goes to Google's speech service. For an app whose entire pitch is "you bring your own key, we host nothing," routing the user's voice to Google without their explicit consent is a positioning problem, not just a technical one.

**Chrome is moving toward on-device.** `SpeechRecognition.processLocally` (`true` forces local processing), plus static `SpeechRecognition.available(langs)` and `SpeechRecognition.install(langs)` to install language packs, and `SpeechRecognition.phrases` for contextual biasing. Per MDN BCD these are **Chrome 139+ desktop only** — `chrome_android: false`, `safari: false`, `firefox: preview`. `unspokenPunctuation` is Chrome 151+. So today you cannot rely on on-device recognition being available, and you cannot even rely on it on Android Chrome.

### 4.3 WebView — unusable on mobile, confirmed

- **Android WebView**: `webkitSpeechRecognition` exists in the object model but produces no results. Chromium issue 41172064 is titled exactly that: *"Android Webview42 has webkitSpeechRecognition, but it doesn't work."* Feature-detection therefore gives a false positive — a particularly nasty failure mode. Stack Overflow 40337687 documents the same on Android 6/Chrome 44 WebView vs Chrome 54 system browser, with the only "fix" being `onPermissionRequest` grants, which addresses the mic permission and not the missing recognition backend.
- **iOS WKWebView**: not available, per the WebKit bug above (`SafariViewController` and home-screen web apps explicitly excluded). Capacitor on iOS uses WKWebView.

**Conclusion: a Capacitor/Cordova WebView shell cannot use the Web Speech API for recognition on either platform.** You must use a native plugin (`@capacitor-community/speech-recognition`) or record audio and POST it.

### 4.4 `MediaRecorder` + `getUserMedia` capture

Availability (MDN BCD `api/MediaRecorder.json` + caniuse `mediarecorder`):

| Browser | Since |
|---|---|
| Chrome / Edge | 47 |
| Firefox | 25 |
| Opera | 36 |
| Safari | 14.1 |
| **iOS Safari** | **14** |

caniuse currently reports `y` through Safari 27.2 / iOS 27.2. **This is universally available and is the correct capture path.**

Codec support — I probed `MediaRecorder.isTypeSupported` in this host's Chromium (Chrome/Edge 154):

```
audio/webm                     true
audio/webm;codecs=opus         true
audio/ogg;codecs=opus          false
audio/mp4                      true
audio/mp4;codecs=mp4a.40.2     true
audio/mpeg                     false
audio/wav                      false
```

So on Chromium you get **WebM/Opus or MP4/AAC**; Ogg/Opus, MP3 and WAV are *not* MediaRecorder outputs. Both WebM and MP4 are in OpenAI's and Groq's accepted format lists, so no transcoding is needed. On iOS Safari the practical container is MP4/AAC (Safari added Ogg/Opus playback only in 18.4+, and MediaRecorder output on iOS is MP4/AAC in practice).

There is no `audio/wav` from MediaRecorder, so if you target whisper.cpp's `whisper-server` (which wants WAV, or ffmpeg with `--convert`) you need either `--convert`, a JS WAV encoder, or Web Audio `decodeAudioData` + manual PCM writing.

---

## 5. On-device mobile options

| Option | Platform | Model size / RAM | Offline? | Notes |
|---|---|---|---|---|
| **iOS `SFSpeechRecognizer`** | iOS 10+ | system-managed | ⚠️ by default network-based; set `requiresOnDeviceRecognition = true` (iOS 13+) | Must also check `supportsOnDeviceRecognition`. Apple: *"on-device requests won't be as accurate."* **Hard 1-minute limit**: *"the framework stops speech recognition tasks that last longer than one minute."* Irrelevant for push-to-talk; fatal for continuous. |
| **iOS 26 `SpeechAnalyzer` / `SpeechTranscriber`** | iOS 26+ | system-managed | ✅ on-device | New Swift-native API with `AsyncSequence` results, `AssetInventory` for language packs, `bestAvailableAudioFormat`, model retention/preheat options, `insufficientResources` error when too many concurrent analyses. This is the modern path; `SFSpeechRecognizer` is legacy. |
| **Android `SpeechRecognizer`** | API 8+ | system-managed | ⚠️ **documented as network-based by default** | Android's own doc: *"The implementation of this API is likely to stream audio to remote servers to perform speech recognition. As such this API is not intended to be used for continuous recognition, which would consume a significant amount of battery and bandwidth."* On-device: `createOnDeviceSpeechRecognizer()` + `isOnDeviceRecognitionAvailable()`. |
| **Google ML Kit GenAI Speech Recognition** | API 31+ (Basic); **Pixel 10/11 only** (Advanced) | model downloaded via AICore | ✅ | `com.google.mlkit:genai-speech-recognition:1.0.0-alpha1`. Basic = traditional on-device model, 15 locales (most beta). Advanced = Gemini Nano, 20 locales, **Pixel 10 and Pixel 11 only**. Alpha; AICore init flakiness is documented. |
| **Vosk** | Android, iOS, desktop | small models ~40–50 MB, **~300 MB RAM** | ✅ | `alphacep/vosk-api`: 15,157 stars, Apache-2.0, last push 2026-08-09, **latest release v0.3.50 from 2024-04-22** — the repo is maintained but releases have stalled for ~2.5 years. WER is dated: `vosk-model-small-en-us-0.15` is **9.85%** on LibriSpeech test-clean, vs Moonshine Tiny Streaming at 4.83%. Streaming API with zero-latency response, reconfigurable vocabulary. |
| **Moonshine** | Python, JS/WASM, iOS, Android, macOS, Linux, Windows, RPi | Tiny Streaming 34M params, Small 123M, Medium 245M; micro variant fits in **470 KB RAM** on an RP2350 | ✅ | `moonshine-ai/moonshine`: 11,153 stars, last push 2026-08-31, release v0.1.5 (2026-08-24). Models are **MIT by default** (legacy non-English non-streaming models are Community-licensed). English streaming WER on LibriSpeech test-clean, quantized: Tiny **4.83%**, Small **2.61%**, Medium **2.17%** — better than Whisper Tiny and competitive with Whisper Small at a fraction of the size. Explicitly built for streaming (`Moonshine v2` paper, arXiv 2602.12241, "ergodic streaming encoder... bounded, low-latency inference"). **Strongest local option for mobile.** |
| **NVIDIA Parakeet TDT 0.6B v3** | via `whisper.cpp`/`whisper.rn` Parakeet API, or sherpa-onnx | GGUF: q4_0 **356 MB**, q4_k 416 MB, q8_0 669 MB, f16 1.26 GB | ✅ | 25 European languages. `whisper.rn`'s `initParakeet` + `ParakeetContext`; **inputs must be 16-bit PCM WAV or base64 raw mono 16 kHz** — no MP3/AAC/FLAC decoding. `senstella/parakeet-mlx` (984 stars) is Apple-Silicon-only (MLX), so not useful for the app itself. |
| **WhisperKit (Argmax)** | iOS 16+/macOS 13+ (Swift only) | `large-v3-v20240930_626MB` recommended | ✅ | `argmaxinc/argmax-oss-swift`: **6,384 stars, MIT**, v1.1.0 (2026-08-06). CoreML on ANE. Ships an **OpenAI-compatible local HTTP server** (`POST /v1/audio/transcriptions`, `/v1/audio/translations`, with SSE streaming) — `make build-local-server`, `argmax-cli serve`. Swift-only, so it does not help a React Native/Capacitor app directly. The **Pro SDK** adds Android (Kotlin) and a Deepgram-compatible WebSocket server, but is commercial. |
| **`whisper.rn`** | iOS + Android, React Native | tiny 75 MB → large-v3-turbo-q5_0 547 MB | ✅ | See §3.5. The only mature cross-platform RN binding. |

**Notes on the mobile on-device landscape:** the two best options for a cross-platform RN app are `whisper.rn` (mature, but Whisper's architecture is inefficient for streaming — the encoder must see the whole window) and **Moonshine** (better WER-per-byte and purpose-built for streaming, but the RN/Android story is newer). Android's own `SpeechRecognizer` and ML Kit are free and zero-download for users, but Android's default recognizer is network-based and Google-mediated, which conflicts with the privacy pitch; ML Kit Advanced is Pixel-10/11-only in alpha.

---

## 6. Mobile constraints

### 6.1 Microphone permissions

**Capacitor** — `@capacitor-community/speech-recognition` (npm **v7.0.1**, published 2026-09-28, "Actively Maintained"):
- iOS `Info.plist`: `NSSpeechRecognitionUsageDescription` **and** `NSMicrophoneUsageDescription` — both required.
- Android: *"No further action required"* — the plugin's manifest merge handles it, but your app still needs `RECORD_AUDIO` at runtime.
- API: `available()`, `start({language, maxResults, prompt, popup, partialResults})`, `stop()`, `isListening()`, `checkPermissions()`, `requestPermissions()`, plus `partialResults` and `listeningState` listeners.
- Known limits: `getSupportedLanguages()` *"is not available on Android 13 and newer"*; `partialResults` *"doesn't work if `popup` is true"* on Android.

For plain recording (the clip-and-POST path) you don't need this plugin at all — a generic audio-recorder plugin plus `getUserMedia` semantics is enough.

**Expo** — `expo-audio` (SDK 57) config plugin:
```json
["expo-audio", {
  "microphonePermission": "Allow $(PRODUCT_NAME) to access your microphone.",
  "recordAudioAndroid": true,
  "enableBackgroundRecording": false,
  "enableBackgroundPlayback": true
}]
```
`enableBackgroundRecording` adds a recording foreground service + persistent notification on Android and the `audio` background mode on iOS, with an explicit warning that it *"can significantly impact battery life."*

`expo-speech-recognition` (npm **57.1.0**, published 2026-09-16; `jamsch/expo-speech-recognition`, **684 stars**, last push 2026-09-16) wraps `SFSpeechRecognizer` / Android `SpeechRecognizer` / Web `SpeechRecognition` behind one API and can even polyfill the `webkitSpeechRecognition` global. Its published compatibility table is the single best summary of what actually works:

| Platform | Supported | Engine |
|---|---|---|
| Android (RN) | ✅ | Google |
| iOS (RN) | ✅ | Siri |
| Chrome desktop | ✅ | Google (server-based) |
| Safari desktop ≥16 | ✅ | Siri (Siri must be enabled) |
| Chrome on Android | ✅ | Google |
| **Chrome on iOS** | ❌ | *"Not working (Last tested 2023)"* |
| Edge on Windows | unknown | Azure; verify at `edge://components` |
| Edge on Mac ARM | ❌ | — |
| Brave desktop | ❌ | waiting on on-device Web Speech API |
| **Firefox desktop** | ❌ | no implementation |

Its mobile feature matrix also shows: **Continuous Recognition** unsupported on Android 12 and below; **On-Device Recognition** unsupported on Android 12 and below; **Audio Recording** and **Audio File Transcription** need Android 13+ or iOS; **Word Confidence & Timing** on Android only with on-device recognition; **Punctuation** on Android only with on-device recognition.

### 6.2 Background audio / audio session

- **iOS `AVAudioSession.Category`** (`developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct`): `playback`, `record`, `playAndRecord`, `ambient`, `soloAmbient`, `multiRoute`, `audioProcessing`.
  - `playAndRecord` is *"the category for recording (input) and playback (output) of audio, such as for a VoIP app"* — the right one if you want TTS playback while the mic is armed.
  - `record` **silences playback** — wrong if the app speaks.
  - `playAndRecord` supports only the *mirrored* variant of AirPlay; `record` and `multiRoute` don't allow AirPlay at all.
  - `ambient`/`soloAmbient`/`playback` support both mirrored and non-mirrored AirPlay.
  - `expo-speech-recognition` exposes `iosCategory`, `iosVoiceProcessingEnabled` (prevents mic feedback from speakers, but *"may switch the AVAudioSession mode to `voiceChat` and lower the volume of speaker playback"*), plus `setCategoryIOS()` / `getAudioSessionCategoryAndOptionsIOS()` / `setAudioSessionActiveIOS()`.
- **Android**: since Android 14 (API 34) every foreground service must declare a type. Microphone capture from the background requires the `microphone` FGS type + `FOREGROUND_SERVICE_MICROPHONE` permission **and** the granted `RECORD_AUDIO` runtime permission. `mediaPlayback` (used for TTS) requires `FOREGROUND_SERVICE_MEDIA_PLAYBACK`. `expo-audio`'s `enableBackgroundPlayback` configures exactly these.
- **Practical advice for a chat app**: do **not** enable background recording. Push-to-talk is a foreground, user-initiated, seconds-long interaction. Background mic + FGS + persistent notification is a large battery and app-review cost for no user benefit.

### 6.3 Latency budget

Published numbers, for calibration:

| Source | Figure |
|---|---|
| Deepgram | transcription 150–300 ms; total client-observed 200–500 ms; EOT 100–500 ms |
| ElevenLabs Scribe v2 Realtime | ~150 ms (excluding network) |
| AssemblyAI U3.6 Pro Realtime | P50 ~150 ms post-VAD, P90 ~240 ms post-VAD; median EOT 537 ms |
| Groq whisper-large-v3-turbo | 216× realtime (i.e. model time ≈ audio_duration/216) |

A realistic end-to-end budget for **push-to-talk on a phone**:

```
mic capture (clip length)      = however long the user talks
+ encode to Opus/AAC           ~10–30 ms
+ upload 5–10 s of Opus @24kbps ≈ 15–30 KB  → 20–200 ms on LTE/Wi-Fi
+ server transcription         ≈ 50–150 ms (Groq turbo) / 200–400 ms (Deepgram)
+ response download            ~10–50 ms
--------------------------------------------------------------
= 100–400 ms after the user releases the button
```

That is perceptually instant. **The clip length itself dominates.** Which means: a good push-to-talk UX (button down = record, button up = send) has a better latency *perception* than any streaming pipeline, because the user is talking during the wait.

**Recommendation: push-to-talk, clip-and-POST, not streaming.** Add a live "listening…" waveform from local amplitude analysis (`getUserMedia` + Web Audio `AnalyserNode`, or `expo-speech-recognition`'s `volumechange` event which returns −2…10) so the user gets feedback without any network round-trip.

---

## 7. Comparison table

| Provider / option | Cost | Latency | Offline? | Mobile support | Notes |
|---|---|---|---|---|---|
| **Groq `whisper-large-v3-turbo`** | **$0.04/hr** (10 s min billed) | ~audio/216 + network; 100–300 ms for a clip | ❌ | ✅ any platform that can POST | **Best price/perf.** OpenAI-compatible endpoint. No streaming. |
| **OpenAI `gpt-transcribe`** | $0.0045/min = $0.27/hr | file; supports SSE streaming | ❌ | ✅ | Recommended file model. `keywords`/`languages`. No timestamps. |
| **OpenAI `gpt-4o-mini-transcribe`** | $0.003/min = $0.18/hr | file only | ❌ | ✅ | Cheapest OpenAI. |
| **OpenAI `whisper-1`** | $0.006/min = $0.36/hr | file only | ❌ | ✅ | Only OpenAI model with timestamps + translation. |
| **OpenAI `gpt-live-transcribe`** | $0.017/min = $1.02/hr | streaming, tunable `delay` | ❌ | ✅ (WebRTC/WS) | **No server VAD** — you must do client-side endpointing. |
| **Deepgram Nova-3 streaming** | $0.0048/min promo | ≤300 ms transcription | ❌ | ✅ (WS) | Promo pricing; check expiry. |
| **Deepgram Flux** | $0.0065–0.0078/min | ~260 ms EOT | ❌ | ✅ (WS) | Built-in turn detection; 80 ms chunks. |
| **AssemblyAI U3.6 Pro Realtime** | $0.45/hr = $0.0075/min | P50 ~150 ms post-VAD | ❌ | ✅ (WS) | **Billed on socket-open time**, not audio. |
| **Google Cloud STT v2** | $0.016/min std; $0.003/min batch | streaming gRPC only | ❌ | ⚠️ needs proxy | 25 KB/request streaming limit. Poor BYOK fit. |
| **Azure Speech S1** | $1.00/hr real-time | — | ❌ | ✅ SDK | 25× Groq. Needs Azure resource. |
| **ElevenLabs Scribe v2** | $0.22/hr | file | ❌ | ✅ | ">98% accuracy" is unbenchmarked marketing. |
| **ElevenLabs Scribe v2 Realtime** | $0.39/hr | ~150 ms | ❌ | ✅ | |
| **whisper.cpp native (desktop)** | free | base ~0.2–0.4 s / 30 s window | ✅ | ❌ (desktop) | `whisper-server` on `127.0.0.1:8080`. |
| **whisper.cpp WASM (browser)** | free | ~2.5× slower than realtime for base | ✅ | ⚠️ desktop only in practice | Max 120 s audio; models ≤ `small`. |
| **whisper.rn (RN mobile)** | free | base enc 62 ms / 30 s on S25 Ultra | ✅ | ✅ iOS + Android | Mature. Hexagon NPU experimental. |
| **Moonshine streaming** | free (MIT) | designed for low TTFT | ✅ | ✅ (iOS/Android/JS) | English LibriSpeech-clean 4.83% (tiny) / 2.17% (medium). |
| **Vosk** | free (Apache-2.0) | zero-latency streaming API | ✅ | ✅ | ~300 MB RAM; dated accuracy (9.85% small-en). Releases stalled since 2024-04. |
| **WhisperKit (Argmax)** | free (MIT) + Pro SDK | ANE-accelerated | ✅ | ⚠️ Swift only (Pro adds Android) | Ships an OpenAI-compatible local server. |
| **iOS `SFSpeechRecognizer`** | free | network or on-device | ⚠️ opt-in | ✅ iOS | 1-minute cap; on-device less accurate. |
| **Android `SpeechRecognizer`** | free | network by default | ⚠️ opt-in | ✅ Android | Docs: *"likely to stream audio to remote servers."* |
| **ML Kit GenAI STT** | free | on-device | ✅ | ⚠️ Pixel 10/11 for Advanced | Alpha. |
| **Web Speech API** | free | server round-trip | ❌ | ❌ **unusable in WebView** | Audio → Google. Not in Firefox. |
| **`MediaRecorder` + `getUserMedia`** | free | n/a (capture) | ✅ | ✅ everywhere | Chrome 47+, Safari 14.1/iOS 14+. WebM/Opus or MP4/AAC. |

---

## 8. Design notes for the app

1. **One abstraction, two implementations.** Define a `transcribe(blob: AudioClip) -> string` interface. Cloud impl = one `fetch` to an OpenAI-compatible `/v1/audio/transcriptions`. Local impl = `whisper.rn` on mobile, `whisper-server` sidecar or WASM on desktop. Because Groq and OpenAI share a wire format, and `whisper-server` is one small adapter away, this stays cheap.
2. **Reuse the user's existing LLM key where possible.** A user with an OpenAI key gets `gpt-4o-mini-transcribe` for free; a user with a Groq key gets the cheapest option on the market. Expose "voice input provider" separately from "chat provider" — most BYOK users have several keys.
3. **Record in the format the endpoint wants.** Opus/WebM or AAC/MP4 are both accepted by OpenAI and Groq, so no transcoding for the cloud path. For the local path, either build with `WHISPER_COMMON_FFMPEG` + `--convert`, or encode WAV client-side.
4. **Cap the clip length** at ~30–60 s with a visible timer. This bounds cost, bounds upload time, keeps you inside whisper.cpp's comfortable window, and matches the actual use case (dictating one message).
5. **Show local volume feedback, never a network-dependent one.** Users need to know the mic is live before they finish talking.
6. **Don't ship the Web Speech API path at all** unless you gate it behind a clear "your audio will be sent to Google/Apple" consent, and even then only on platforms where it works (Chrome desktop, Safari desktop). It is a support burden (false-positive feature detection in Android WebView) with a privacy cost and no capability the clip-and-POST path lacks.
7. **If you later want continuous/live mode** (voice call with a character), that is a different product: it needs a streaming provider with real endpointing (Deepgram Flux, or AssemblyAI U3.6 Pro Realtime) or a local streaming model (Moonshine streaming, which is explicitly designed for it). Whisper-family models are architecturally wrong for it — the encoder needs the whole window, so TTFT grows with utterance length (see Moonshine v2 paper abstract).

---

## Sources

- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/guides/realtime-vad
- https://developers.openai.com/api/docs/guides/transcription
- https://developers.openai.com/api/docs/guides/voice-webrtc
- https://developers.openai.com/api/reference/resources/audio
- https://developers.openai.com/api/docs/models/whisper-1
- https://developers.openai.com/api/docs/models/gpt-transcribe
- https://developers.openai.com/api/docs/models/gpt-live-transcribe
- https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
- https://developers.openai.com/api/docs/models/gpt-realtime-whisper
- https://deepgram.com/pricing
- https://developers.deepgram.com/docs/models-languages-overview
- https://developers.deepgram.com/docs/measuring-streaming-latency
- https://developers.deepgram.com/docs/flux/quickstart
- https://deepgram.com/learn/introducing-flux-conversational-speech-recognition
- https://www.assemblyai.com/pricing
- https://www.assemblyai.com/llms/models.md
- https://console.groq.com/docs/speech-to-text
- https://console.groq.com/docs/model/whisper-large-v3-turbo
- https://cloud.google.com/speech-to-text/pricing
- https://docs.cloud.google.com/speech-to-text/docs/transcription-model
- https://docs.cloud.google.com/speech-to-text/docs/streaming-recognize
- https://azure.microsoft.com/en-us/pricing/details/speech/
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
- https://prices.azure.com/api/retail/prices?$filter=productName%20eq%20%27Azure%20Speech%27
- https://elevenlabs.io/pricing/api
- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- https://github.com/ggml-org/whisper.cpp
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/README.md
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/server/README.md
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/whisper.wasm/README.md
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/stream.wasm/README.md
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/whisper.android/README.md
- https://github.com/ggml-org/whisper.cpp/issues/89
- https://github.com/mybigday/whisper.rn
- https://raw.githubusercontent.com/mybigday/whisper.rn/main/README.md
- https://raw.githubusercontent.com/mybigday/whisper.rn/main/docs/TIPS.md
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/README.md
- https://github.com/moonshine-ai/moonshine
- https://moonshine-voice.readthedocs.io/en/latest/models/available-models/
- https://moonshine-voice.readthedocs.io/en/latest/models/accuracy/
- https://moonshine-voice.readthedocs.io/en/latest/models/quantization/
- https://arxiv.org/abs/2602.12241
- https://raw.githubusercontent.com/moonshine-ai/moonshine/main/micro/README.md
- https://github.com/alphacep/vosk-api
- https://alphacephei.com/vosk/models
- https://github.com/k2-fsa/sherpa-onnx
- https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html
- https://raw.githubusercontent.com/senstella/parakeet-mlx/master/README.md
- https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally
- https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json
- https://github.com/mdn/browser-compat-data/blob/main/api/MediaRecorder.json
- https://github.com/Fyrd/caniuse/blob/main/features-json/speech-recognition.json
- https://github.com/Fyrd/caniuse/blob/main/features-json/mediarecorder.json
- https://developer.chrome.com/blog/voice-driven-web-apps-introduction-to-the-web-speech-api
- https://bugs.webkit.org/show_bug.cgi?id=225298
- https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/
- https://issues.chromium.org/issues/41172064
- https://stackoverflow.com/questions/40337687/android-webview-and-speechrecognition-api
- https://developer.apple.com/documentation/speech/sfspeechrecognizer
- https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition
- https://developer.apple.com/documentation/speech/speechanalyzer
- https://developer.apple.com/documentation/speech/speechtranscriber
- https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct
- https://developer.android.com/reference/android/speech/SpeechRecognizer
- https://developers.google.com/ml-kit/genai/speech-recognition/android
- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://github.com/capacitor-community/speech-recognition
- https://capacitorjs.com/docs/android/configuration
- https://docs.expo.dev/versions/latest/sdk/audio/
- https://github.com/jamsch/expo-speech-recognition
- https://huggingface.co/docs/transformers.js/en/api/models
- https://github.com/huggingface/transformers.js-examples
