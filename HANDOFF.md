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

## The one thing that needs investigating

`verify/e2e.ts` passes 17 of 18 checks. The failure is real and I did not paper over it:

```
FAIL  the cached share grows across turns  — 55.6% -> 49.8%
      cached tokens stayed at exactly 120 while prompt tokens grew 216 -> 241
```

A **frozen** cached count while the prompt grows means the cacheable prefix is not
advancing — the opposite of what the 90%-at-turn-40 measurement showed on a long chat.
Either something about a short chat with a large tail behaves differently, or the earlier
measurement was measuring a different path.

Do not relax the assertion. Reproduce first:

```sh
bun run worker:dev
bun run verify/e2e.ts http://localhost:8787 "$(grep -oP 'TESSERA_TOKEN=\K\S+' .dev.vars)"
```

Then send ~10 turns to one chat and watch `cachedTokens` across them. It should climb in
~128-token steps; if it is pinned, the prefix is being mutated somewhere.

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
