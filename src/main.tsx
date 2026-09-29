import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import App from './App';
import { apiOrigin } from './lib/api';
import { assertNativeStreaming, isNativeShell } from './lib/native/sse';

// The native shells wrap this same bundle. Check once, at startup, that replies will
// actually stream — a buffered response body does not throw, it just makes the chat
// look slow, so without this the failure is invisible until someone notices.
if (isNativeShell()) {
  const { ok, reason } = assertNativeStreaming();
  if (ok) {
    console.info(`[tessera] native shell: streaming OK, api at ${apiOrigin()}`);
  } else {
    console.error(`[tessera] SSE will not stream — ${reason}`);
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
