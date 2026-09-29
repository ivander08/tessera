# Image Generation Backends + Character Consistency (research, 2026-09-29)

## 1. Backend comparison

Costs are per image unless noted. "NSFW?" = can the app legally/technically route adult content through it.

| Backend | Cost/image | Latency | NSFW? | Self-host | Consistency tooling |
|---|---|---|---|---|---|
| A1111 WebUI API | $0 (own GPU) | 2-8 s SDXL 1024² on 12 GB | Yes (model-dependent) | Yes, AGPL-3.0 | IPAdapter, ControlNet reference-only, LoRA, textual inversion |
| Forge / reForge / Forge-Classic | $0 | ~20-40% faster than A1111 on same GPU | Yes | Yes | same as A1111 + Flux/GGUF support in Forge-Neo |
| ComfyUI API | $0 (or RunPod ~$0.02) | 2-6 s SDXL; 4-step schnell <1 s | Yes | Yes, GPL-3.0 | Everything: IPAdapter+, Redux, PuLID, InstantID, LoRA, ControlNet |
| NovelAI Diffusion V5 | $25/mo Opus ⇒ ~1,730 free images/100% bar | ~5-15 s | Yes, expressly permitted | No | Precise Reference (Character/Style), Vibe Transfer, 22-char positioning |
| OpenAI gpt-image-2.5 | $0.006 low → $0.211 high (1024²) | up to 2 min on complex prompts | **No** | No | weak — docs warn it "may struggle to maintain visual consistency" |
| Gemini 3.1 Flash Image (Nano Banana 2) | $0.067 / 1K image; $0.101 / 2K; $0.151 / 4K | seconds | **No** | No | strongest hosted: up to 14 refs, 5 char refs, 360° view workflow |
| Imagen 4 (Vertex) | $0.04; Fast $0.02; Ultra $0.06 | seconds | **No** | No | subject fine-tuning (4-8 images/subject) |
| BFL FLUX.2 via api.bfl.ai | klein-4B from $0.014, klein-9B $0.015, pro $0.03/MP, max $0.07/MP | klein = sub-second, 4-step | Tolerated (safety_tolerance 0-6) | dev/klein weights only | multi-reference up to 10 images; LoRA/finetune endpoints |
| fal.ai | flux/dev $0.025/MP, flux-lora $0.035/MP | 2-5 s | safety checker can be disabled | n/a | `fal-ai/flux-lora` accepts a trained LoRA per call |
| Replicate | flux-dev $0.025, flux-1.1-pro $0.04, flux-schnell $3.00/1000 | 3-10 s | yes (open models) | n/a | LoRA via `go_fast`/train endpoints |
| AI Horde | **$0**, kudos-prioritised | median ~45-165 s queued | Yes (only CSAM filtered) | Yes, AGPL-3.0 | whatever the worker's checkpoint offers |
| Pollinations | free tier (watermark), paid tiers | 5-20 s | restricted | Yes, MIT | none |
| TogetherAI | SDXL $0.0019/MP … Nano Banana Pro $0.134/MP | seconds | **No** for Google/OpenAI rows | n/a | none |
| Chutes | per-token / private chute by GPU-hour | seconds | unmoderated TEE GPUs | Yes | self-deployed |
| Local SDXL/Illustrious/Pony/Flux-GGUF | $0 | SDXL ~2-5 it/s on 8 GB | Yes | Yes | full local stack |

### Backend notes

**A1111** is functionally frozen. `master` last moved 2024-07-27; the `dev` branch last moved 2026-03-02 (`gh api repos/AUTOMATIC1111/stable-diffusion-webui/commits?sha=dev`). 165,148 stars, AGPL-3.0. API needs `--api`; routes are registered in `modules/api/api.py` (`/sdapi/v1/txt2img|img2img|options|progress|interrupt|sd-models|samplers|upscalers|png-info`), auth via `--api-auth user:pass`, CORS via `--cors-allow-origins`. Response is `{images:[b64], parameters, info}`.

**Forge** upstream (lllyasviel, 13,037★) last pushed 2025-07-31. reForge (Panchovix, 1,042★, pushed 2026-04-14) is semi-active but its own README now recommends **Forge-Classic** (Haoming02/sd-webui-forge-classic, 1,770★, pushed 2026-09-29) and the `neo` branch (Flux/GGUF/Qwen-Image/Nunchaku) as the maintained forks. Treat Forge-Classic/Neo as the live lineage.

**ComfyUI** (Comfy-Org/ComfyUI, 135,459★, GPL-3.0, pushed daily) is the only backend with a real workflow-as-API contract: POST `/prompt` with an API-format graph → `prompt_id`; poll `GET /history/{id}`; fetch pixels via `GET /view`; `/ws` streams `executing`/`progress`/`executed`. `--listen` and `--enable-cors-header` are in `comfy/cli_args.py:63,67`. ComfyUI-Manager (16,302★) installs custom nodes; note v3.38 moved manager data to a protected path after a security issue.

**NovelAI** V5 shipped 2026-08-21 (268,000 B200 GPU-hours). Opus ($25) gets unlimited *Anlas-free* generations at ≤28 steps and "normal" resolution, metered by a continuously refilling bar: ~11%/day for the first 30 days then ~14%/day, 9 days empty→full new / 7 days continuing, ≈1,730 images per full bar at 23 steps 1 MP (≈7,000/month). 28 steps is the default and the free threshold. NSFW is permitted. Consistency is hosted: **Precise Reference** (Character/Style/both, +5 Anlas per reference, multi-character refs blend), **Vibe Transfer** (up to 16 vibes, +2 Anlas each above 4), and V5 character positioning (up to 22 characters). API is `https://image.novelai.net/ai/generate-image`, Bearer access token, returns a **ZIP** containing the PNG; model strings in ST are `nai-diffusion-4-5-full|curated`, `nai-diffusion-4-full`, `nai-diffusion-3` — V5's endpoint id is [UNVERIFIED].

**OpenAI**: gpt-image-2.5-sunburst/flare at $8/1M image input, $2 cached, $30/1M image output, $5/1M text input; measured per-image $0.006 (low 1024²) to $0.211 (high). `moderation: "low"` relaxes but never disables filtering; `moderation_blocked` returns categories `sexual|violence|harassment|self-harm`. **NSFW is not available.**

**Google**: Nano Banana 2 = `gemini-3.1-flash-image`, $0.067/1K, $0.101/2K, $0.151/4K; Lite $0.0336/1K. All outputs carry a SynthID watermark. Up to 14 reference images, 5 character refs on Pro / 4 on 3.1 Flash, documented 360° character-consistency prompting. Also **no NSFW**.

**FLUX licensing** is the trap: FLUX.1 [dev] = flux-1-dev-non-commercial; FLUX.2 [dev] and klein-9B = flux-non-commercial; only **klein-4B is Apache-2.0**; FLUX.1 [schnell] is Apache-2.0; [pro]/[max]/[flex] are API-only. BFL's own docs list FLUX.2 [dev] as "Local only — no hosted API". Replicate notes outputs are commercial only when generated *on Replicate*.

**AI Horde** is the only free option with real NSFW: kudos are earned by running a worker (horde-worker-reGen), never sold, 1 kudos tax per request, baseline 10 kudos = 50-step 512². Live at time of writing: 16 image workers online, 187.6 M images served, 75,877/day; observed queue ETAs 0 s (Pony XL) to 165 s (WAI-NSFW-illustrious-SDXL). API: `POST /api/v2/generate/async` → `id`, `GET /api/v2/generate/check/{id}`, `GET /api/v2/generate/status/{id}`, or `webhook`. Anonymous key `0000000000`.

**Local**: ComfyUI claims 4 GB VRAM + 8 GB RAM via async weight streaming; `--lowvram` (text encoders on CPU), `--novram`, `--reserve-vram`, dynamic VRAM on by default on Nvidia. FLUX.1 dev is 12 B / ~23 GB, with fp8 and GGUF (ComfyUI-GGUF) routes for 8-12 GB cards; ComfyUI's own docs say use `t5xxl_fp16` only above 32 GB VRAM. Licenses: SDXL = CreativeML OpenRAIL++-M; Pony V6 XL's Civitai metadata allows commercial *image* use with derivatives but requires credit; its HF mirrors disagree (cdla-permissive-2.0 vs creativeml-openrail-m) — [UNVERIFIED]; Illustrious v0.1 has no license field on HF and v1.0 is community-reported as Fair AI Public License 1.0-SD (non-free; has Prohibited Uses + network-copyleft notices).

## 2. Integration patterns

**SillyTavern** is the reference implementation. Server: `/api/sd/generate` proxies to `/sdapi/v1/txt2img` and aborts via `/sdapi/v1/interrupt` on client disconnect; `/api/sd/comfy/generate` POSTs the workflow to `/prompt` then polls `/history/{id}` every 100 ms (ST ignores `/ws`), with `%prompt%`, `%negative_prompt%`, `%model%` placeholders substituted into the API-format JSON; `/api/sd/comfyrunpod/*` for serverless; `/api/novelai/generate-image`; `/api/horde/generate-image`.

Storage: `USER_DIRECTORY_TEMPLATE.userImages = 'user/images'` resolved as `<DATA_ROOT>/<user-handle>/user/images/`, and `POST /api/images/upload` writes into a `ch_name` subfolder — i.e. `data/default-user/user/images/<character>/<timestamp>.png`. The character gallery is that folder.

**Rendering is not a `{{img}}` macro.** Generated images are attached to the chat message as `message.extra.media[]`, a `MediaAttachment` `{url, type, title, generation_type, negative, source}`, with `media_index` driving image swipes and `media_display: GALLERY` / `inline_image`. `/sd quiet=true` suppresses the chat message (still saved to the gallery) and pipes the relative URL, so the documented pattern is:

```stscript
/sd quiet=true me | /send Here's a picture of me: ![my portrait]({{pipe}})
```

Modes: `you|face|me|scene|last|raw_last|background`, each with its own prompt template, plus a common prefix, a per-character prefix/negative (`{{charPrefix}}`), style presets, an interactive verb+noun trigger, and an optional function-tool trigger. Non-`raw_last` modes spend a *second* LLM call to turn chat context into the image prompt — budget for that.

**chub.ai** has image generation but not in-chat: the chat kebab menu has **"Imagine"**, and the docs' feature list mentions image generation alongside chat trees. Free tier reportedly gives 300 credits at 25 credits per image, Mars $20/mo unlimited (unofficial guide, Dec 2024 — [UNVERIFIED], and chub.ai itself is Cloudflare-blocked from this host). The architecturally interesting part is **Stages**: iframe-sandboxed third-party extensions on separate subdomains, used for expression packs that "show a character's emotional state with a set of images" — a reusable model for avatar/expression-driven visuals.

**JanitorAI** has no in-chat generation: a separate dashboard "Generate" tool writes to a gallery, and users embed images manually with `![desc](url)` from third-party hosting.

## 3. Character consistency

Three tiers, in increasing effort:

1. **Adapter, no training** — IPAdapter (tencent-ailab/IP-Adapter, Apache-2.0, 6,694★, last push 2024-06-28) with `plus_face`/FaceID variants; ComfyUI_IPAdapter_plus (cubiq, GPL-3.0, 6,135★) went **maintenance-only on 2025-04-14**; InstantID (11,997★, last push 2024-07-18 — code Apache-2.0 but insightface face models and checkpoints are research-only); PuLID (3,555★, Apache-2.0, pushed 2025-07-31) covers SDXL v1.1 *and* PuLID-FLUX v0.9.1, runs on 16 GB. All of these are SD1.5/SDXL-first; the Flux IP-Adapter (XLabs-AI/x-flux, 1,703★, Apache-2.0) is stale since 2024-10-30.
2. **Reference conditioning** — ControlNet `reference-only` preprocessor (Mikubill/sd-webui-controlnet, 17,840★, last push 2024-08-12) needs no control model and links attention layers straight to a reference image. For Flux: FLUX.1 Redux [dev] for image variation, and FLUX.2 multi-reference (up to 10 images, "8 consistent characters from reference images" per BFL). On the hosted side, Nano Banana's multi-image refs and NovelAI's Precise Reference are the same idea productised.
3. **Trained identity** — LoRA on a character sheet. kohya-ss/sd-scripts covers FLUX.1/SDXL/SD3.5/HunyuanImage; bmaltais/kohya_ss (12,607★) is the GUI; ostris/ai-toolkit (12,156★, MIT, pushed 2026-09-27) trains FLUX.2 dev/klein-base and ships `train_lora_flux_24gb.yaml`, i.e. plan on 24 GB VRAM or a rented GPU. Inference then costs nothing extra: `fal-ai/flux-lora` at $0.035/MP, or locally.

For a BYOK app the pragmatic ladder is: seed-locked + prompt-prefix consistency for free, then a per-character LoRA (trained once, hosted or local) for the paid tier, with IPAdapter/PuLID as the no-training middle step on local SDXL.

## Sources

- https://github.com/AUTOMATIC1111/stable-diffusion-webui (165,148★, AGPL-3.0, dev branch 2026-03-02)
- https://github.com/AUTOMATIC1111/stable-diffusion-webui/blob/master/modules/api/api.py
- https://github.com/AUTOMATIC1111/stable-diffusion-webui/blob/master/modules/cmd_args.py
- https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API
- https://github.com/lllyasviel/stable-diffusion-webui-forge (13,037★, pushed 2025-07-31)
- https://github.com/Panchovix/stable-diffusion-webui-reForge (1,042★, pushed 2026-04-14)
- https://github.com/Haoming02/sd-webui-forge-classic (1,770★, pushed 2026-09-29)
- https://github.com/Comfy-Org/ComfyUI (135,459★, GPL-3.0)
- https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/cli_args.py
- https://docs.comfy.org/development/comfyui-server/comms_routes
- https://docs.comfy.org/development/comfyui-server/startup-flags
- https://docs.comfy.org/tutorials/flux/flux-1-text-to-image
- https://github.com/Comfy-Org/ComfyUI-Manager
- https://docs.novelai.net/en/image/models
- https://docs.novelai.net/en/image/stepsguidance
- https://docs.novelai.net/en/image/precisereference
- https://docs.novelai.net/en/image/vibetransfer
- https://docs.novelai.net/en/image/multiplecharacters
- https://docs.novelai.net/en/faq
- https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/pricing
- https://ai.google.dev/gemini-api/docs/image-generation
- https://ai.google.dev/gemini-api/docs/pricing
- https://cloud.google.com/vertex-ai/generative-ai/pricing
- https://docs.bfl.ai/quick_start/pricing
- https://docs.bfl.ai/flux_2/flux2_overview
- https://bfl.ai/pricing
- https://github.com/black-forest-labs/flux
- https://fal.ai/models/fal-ai/flux/dev
- https://fal.ai/models/fal-ai/flux-lora
- https://replicate.com/black-forest-labs/flux-dev
- https://replicate.com/pricing
- https://aihorde.net/api/
- https://github.com/Haidra-Org/AI-Horde
- https://github.com/Haidra-Org/haidra-assets/blob/main/docs/kudos.md
- https://github.com/Haidra-Org/AI-Horde/blob/main/FAQ.md
- https://github.com/Haidra-Org/horde-worker-reGen
- https://stablehorde.net/api/v2/status/models
- https://stablehorde.net/api/v2/stats/img/totals
- https://platform.stability.ai/pricing
- https://together.ai/pricing
- https://docs.together.ai/docs/serverless-models
- https://chutes.ai/pricing
- https://chutes.ai/docs/models/vonkaiser-imageclassic
- https://github.com/pollinations/pollinations/blob/master/APIDOCS.md
- https://huggingface.co/docs/inference-providers/pricing
- https://www.runpod.io/pricing
- https://github.com/runpod-workers/worker-comfyui
- https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0
- https://huggingface.co/api/models/black-forest-labs/FLUX.1-dev
- https://huggingface.co/api/models/black-forest-labs/FLUX.1-schnell
- https://huggingface.co/api/models/black-forest-labs/FLUX.2-dev
- https://huggingface.co/api/models/black-forest-labs/FLUX.2-klein-9B
- https://civitai.com/api/v1/models/257749 (Pony V6 XL permissions)
- https://freedevproject.org/faipl-1.0-sd/
- https://github.com/tencent-ailab/IP-Adapter
- https://github.com/cubiq/ComfyUI_IPAdapter_plus
- https://github.com/instantX-research/InstantID
- https://github.com/ToTheBeginning/PuLID
- https://github.com/XLabs-AI/x-flux
- https://github.com/Mikubill/sd-webui-controlnet
- https://github.com/kohya-ss/sd-scripts
- https://github.com/bmaltais/kohya_ss
- https://github.com/ostris/ai-toolkit
- https://github.com/city96/ComfyUI-GGUF
- https://github.com/leejet/stable-diffusion.cpp
- https://docs.sillytavern.app/extensions/stable-diffusion/
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/stable-diffusion.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/images.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/horde.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/novelai.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/constants.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/stable-diffusion/index.js
- https://docs.chub.ai/docs/the-basics/just-chatting
- https://docs.chub.ai/docs/stages/overview
- https://docs.chub.ai/docs/the-basics/api-connections
- https://theunofficialguidetochubai.wordpress.com/faq/ (unofficial, Dec 2024)
- https://discover.oreateai.com/discover/does-janitor-ai-actually-have-an-image-generator
- https://discover.oreateai.com/discover/the-real-way-to-send-and-display-images-in-janitor-ai-chats
