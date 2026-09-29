# Tessera

A personal, BYOK AI roleplay client. One TypeScript codebase → website, Android APK, desktop app. No server you have to run.

> A *tessera* is a single tile in a mosaic — meaningless alone, the picture only emerges from many. Memory as fragments that form a whole.

---

## What this is

A replacement for chub.ai built around two things nobody currently ships together:

1. **A cache-optimized prompt assembler.** Every LLM provider caches only the exact token prefix from position 0, and every existing roleplay frontend mutates that prefix every turn. Measured cost of that mistake in a real roleplay app: a **46.5%** cache hit rate where **91.5%** was achievable. One timestamp line in a system prompt took a hit rate from 91% to **0%**.
2. **Engine-authoritative state tracking** with per-character knowledge isolation. No existing BYOK app combines structured world state + epistemic isolation + cross-session persistence. The field's memory frameworks score **0.12–0.18** against a 0.345 uncompressed-retrieval baseline, with theory-of-mind at **0.05–0.10**.

## Status

**Design complete. No code yet.** See [`PLAN.md`](PLAN.md).

## Hard constraints

| | |
|---|---|
| Mobile must work with the laptop off | No self-hosted server. SillyTavern's architecture is disqualified. |
| Personal use, solo dev | Cloudflare free tier only |
| The AI writes the code; the user reviews | Boring stack, small independently-verifiable steps |
| Android | Sideloaded APK is fine; no store fight |
| Providers | OpenRouter + Kenari (both verified browser-callable) |

## Architecture

```mermaid
flowchart TB
    subgraph devices["Devices — one codebase, three shells"]
        W["Website / PWA"]
        A["Android APK<br/>(Capacitor, later)"]
        D["Desktop app<br/>(Tauri, later)"]
    end

    subgraph cf["Cloudflare — free tier, always on"]
        WK["Worker<br/>keys · LLM proxy · background jobs"]
        DB[("D1<br/>chats · cards · memory · state")]
    end

    P["OpenRouter / Kenari"]

    W --> WK
    A --> WK
    D --> WK
    WK --> DB
    WK --> P
```

The Worker exists to hold API keys, run background summarization while the app is closed, and log cache metrics across devices — not to host the frontend, which is static files on Cloudflare Pages.

## The cache-safe context layout

```
[ IMMUTABLE HEAD ]  ← cached; never changes for the life of the chat
  1. System prompt           (static text; NO time, NO date, NO IDs)
  2. Character card
  3. Example dialogue
  4. Persona / user card
  5. World book — ALWAYS-ON entries, fixed order
  6. Preset rules

[ GROWING BODY ]  ← cached; append-only
  7. Chat history            (oldest → newest, never reordered, never spliced)

[ VOLATILE TAIL ]  ← uncached; the only part that changes per turn
  8. Retrieved memory        (appended block, never spliced into history)
  9. Scene state             (time · place · present · mood · relationships)
 10. Author's note / steering
 11. Current user message
```

Full rationale, provider mechanics, and the anti-pattern list in [`docs/research/12-caching.md`](docs/research/12-caching.md).

## Research

21 documents, ~770KB, in [`docs/research/`](docs/research/). Every claim URL-attributed; version-sensitive facts dated.

| File | Contents |
|---|---|
| `01-sillytavern.md` | Full feature/stack/extension teardown, 12 ranked pain points, mobile story, caching internals |
| `02-chub.md` | Incumbent teardown — pricing, the 20/day cut, crypto-only payments, why "cache rate" complaints happen |
| `03-competitors.md` | 20+ competing clients compared, plus the unserved-feature analysis |
| `04-leads.md` | Horde Studio, Simulith, awesome-ai-companion, three r/SillyTavernAI threads |
| `05-memory.md` | SillyTavern's four memory systems, MemGPT/mem0/Zep, state tracking, token budgets |
| `06-dungeon.md` | AI Dungeon, NovelAI, state-tracker implementations and their failure modes, multi-agent designs |
| `07-charcraft.md` | What makes a good card, token economics, the `mes_example` trap, failure modes |
| `08-presets.md` | Freaky Frankenstein identified, sampler matrix, preset JSON schemas |
| `09-oss.md` | Reuse/fork/learn/ignore shortlist with licenses, graveyard lessons |
| `10-platform.md` | PWA vs Tauri vs Capacitor, iOS/Android distribution, free-tier sync options |
| `11-backends.md` | Per-provider CORS results, model landscape, preset/control matrix |
| `12-caching.md` | **The core research.** Provider mechanics, anti-patterns, design rules |
| `13a-tts.md` / `13b-stt.md` / `13c-imagegen.md` / `13d-voice-image.md` | Voice and image providers, with NSFW policy constraints |
| `14-cards.md` | Character card v2/v3, PNG embedding, CharX, BYAF, lorebook schemas |
| `15a/b/c-slice-*.md` | Asset storage, chub API + ToS, SillyTavern extension API |

## Milestones

- **M1 — It chats.** Worker + D1 + Pages. Streaming. Persists across devices.
- **M2 — It knows your characters.** PNG/JSON/CharX import with full field mapping.
- **M3 — It's fast and cheap.** Cache observability, `session_id`, enforced prefix stability.
- **M4 — It remembers.** Background summarization, FTS5 recall, memory viewer.
- **M5 — It tracks the world.** State schema, cheap-model patch call, validator.
- **M6 — It makes characters.** Generation, critique, token-cost analysis.
- **M7 — Presets.** ST sampler import, FF5 prompt-preset import.
- **M8 — Wrappers.** Capacitor APK, Tauri desktop.

## Out of scope for v1

Group chat · image generation · voice · full RPG mechanics · local model inference · multi-user · chub API browsing · app store distribution · embeddings

Named explicitly in `PLAN.md` §11 so they don't creep in.
