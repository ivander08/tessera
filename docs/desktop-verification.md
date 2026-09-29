# Desktop verification via CDP

The Tauri webview can be driven over the Chrome DevTools Protocol, which is the only way
to confirm the *actual* desktop binary streams rather than merely that it launches.

## Why this is needed

`GET /api/chats` returns 200 whether or not the request had a valid `Origin`, so a
passing curl proves nothing about the native shell. CORS failure is also invisible from
outside: the webview refuses the response and the page just shows an error. Driving the
webview is the only check that catches a wrong origin — and it did: Tauri on Windows
serves from `http://tauri.localhost`, not the `https://` variant, and the Worker's
allowlist originally had only the `https` one.

## Recipe

1. Launch the built binary with the webview's remote debugging port open. Tauri passes
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` straight through to WebView2:

   ```sh
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
     src-tauri/target/release/tessera.exe
   ```

2. Attach and drive:

   ```js
   const tab = await browser.open({
     name: 'desktop',
     url: 'http://tauri.localhost',
     app: { cdp_url: 'http://127.0.0.1:9222' },
   });
   await tab.evaluate(`localStorage.setItem('tessera.token', ${JSON.stringify(token)})`);
   await tab.goto('http://tauri.localhost/settings');
   ```

3. Confirm the console shows `[tessera] native shell: streaming OK, api at …`, then send
   a turn and check that `delta` frames arrive over time rather than all at once.

## Note

Setting the env var on an already-running instance has no effect — WebView2 reads it at
process start.
