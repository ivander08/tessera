// Prevents an extra console window on Windows in release. Without this the app opens a
// terminal alongside the webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop shell for Tessera: a window around the same `dist/` bundle the Worker serves.
//
// There are no `#[tauri::command]` handlers and no plugins, and that is deliberate:
//
// * Every piece of behaviour — the prefix-stable prompt assembler, the SSE parser, the
//   provider adapters — lives in TypeScript under `src/lib/`, shared verbatim with the
//   Worker. Reimplementing any of it in Rust would fork the logic that this project
//   exists to get exactly right.
// * The frontend talks to the deployed Worker over ordinary `fetch`, not over IPC.
//
// In particular, do NOT add `tauri-plugin-http`. Its `fetch` buffers the entire response
// body in Rust before the first chunk reaches JavaScript, so SSE never streams and the
// chat silently stops feeling incremental:
//   https://github.com/tauri-apps/plugins-workspace/issues/2415  (duplicate #2129)
// The webview's own `fetch` streams correctly. `src/lib/native/sse.ts` asserts at startup
// that nothing has replaced it.
//
// With no plugins registered, the webview needs no ACL capabilities at all: it has no
// access to the IPC layer, which is the tightest possible default. There is intentionally
// no `src-tauri/capabilities/` directory. If a plugin is ever added, it needs a capability
// file or every call will be rejected with "command not allowed".
//
// Desktop only. Tauri's Android/iOS targets require the `lib` + `main` split (the
// `#[cfg_attr(mobile, tauri::mobile_entry_point)]` entry point); Android ships via
// Capacitor instead, so that split is not needed here. See WRAPPERS.md.

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Tessera");
}
