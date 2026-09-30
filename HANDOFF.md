# Session handoff — 2026-09-29

Everything is committed on `main`. **10 commits are pushed**; the last one (`6703a62`) is
local only — push it when convenient:

```sh
git push origin main
```

## Where things are

Live at **https://tessera.ivanderseah08.workers.dev** (Worker version `8cc99fd9`).
APK at `android/app/build/outputs/apk/debug/app-debug.apk` (5.5 MB).

279 tests, `tsc -b` clean, lint clean.

## Resolved: the cache "stall" was a step function

Investigated and closed. `verify/cache-progress.ts` over 24 consecutive turns shows the
cached count holding flat for several turns and then jumping by ~128-134:

```
turn  5: 131 cached   turn 12: 267   turn 18: 396   turn 23: 523
```

That is the provider extending the cached prefix in fixed-size blocks. The prefix was
advancing normally the whole time; my e2e assertion ("the cached share grows every turn")
was asserting the wrong property, because it fails on exactly the turns between block
boundaries. It now asserts what a real regression would break: caching engages, the
cached count never goes backwards, and the prompt grows rather than resetting.

`verify/meter-validity.ts` then confirmed the meter is honest at this scale:

```
warming:   cached 523, 524, 524, 654, 656, 657, 659, 659
timestamp injected into the system prompt:  cached 0, 0, 0, 0
restored:  cached 784, 917, 917, 917
```

A deliberate prefix break collapses the hit rate to zero and restoring recovers it. That
is the check the plan calls the most important one in the project, and it passes.

## Two known code-quality items

1. **`worker/src/effective.ts` duplicates `parsePresetConfig`.** PresetsUI pointed out
   that `effective.ts` reads `config_json` with inline type checks rather than calling
   the clamped parser in `src/lib/presets/presetConfig.ts`. One clamp, one implementation.
2. **`useAsync` has a `useCallback`-shaped hole** — it is a ref-based hook now, but
   several routes still pass `[]` as deps where they mean "re-run when X changes".

## What is built

| Area | State |
|---|---|
| Prompt assembler, sawtooth windowing, prefix guard | done — 90% cache at turn 40 |
| SSE parser, provider adapters (OpenRouter, Kenai) | done |
| Chat: swipes, edit, delete, regenerate, impersonate, continue | done |
| Markdown rendering (CommonMark, `<details>`, XSS-safe) | done |
| Theme system (tokens as data, light/dark, custom CSS) | done |
| Macros (`{{char}}`/`{{user}}` head-safe, dynamic tail-only) | done |
| Personas + `{{user}}` resolution | done |
| World state: engine, viewer, edit, weather | done |
| Keyword lorebook (full ST matching) | done |
| Memory: summaries, FTS5 recall, job queue | done — verified running |
| Presets (chub-shaped, ST import, per-chat) | done |
| Character CRUD: edit, fork, avatars | done |
| Forge: draft, critique, token cost | done |
| Android APK | built |
| Desktop (Tauri) | built — MSI 3.69 MiB, NSIS 2.79 MiB |

## Traps that bit, so they bite again

- **`bun run build` strips `VITE_API_BASE` from `dist/`.** Running it after `build:native`
  and then `cap sync` packages a bundle that cannot reach the API. `src/lib/native/bundle.test.ts`
  guards this; it caught me once.
- **`wrangler dev` does not reload `.dev.vars`.** Restart it after changing the token.
- **Alternatives get late `seq` values.** Anything ordering messages must order by the
  swipe group's *minimum* seq, or an edited early message jumps to the end.
- **`js-tiktoken` cannot go in the Worker** (2.3 MB vocabulary, exceeds startup CPU).
  Use `src/lib/tokenEstimate.ts` there.
- **Kenari buffers SSE at its gateway** — verified across five models. So a regression in
  our own streaming is invisible from the client. `worker/src/chat.streaming.test.ts`
  pins it against a deliberately slow upstream.

## Not done

- Share-sheet **handler** (intent filters are compiled in; nothing reads the intent yet)
- Release signing for the APK / installers
- iOS
- The cache investigation above
