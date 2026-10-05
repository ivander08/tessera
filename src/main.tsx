import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import App from './App';
import { ToastProvider } from './components/Toast';
import { apiJson } from './lib/api';
import { applyTheme, parseTheme, DEFAULT_THEME, type Theme } from './lib/theme';

function Root() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  // The theme lives in the settings table with everything else, so it follows the user
  // across devices. It is fetched rather than inlined to avoid a second source of truth;
  // the CSS defaults mean the first paint is already dark and correct rather than white.
  useEffect(() => {
    let alive = true;
    apiJson<Record<string, string>>('/api/settings')
      .then((settings) => {
        if (alive) setTheme(parseTheme(settings.theme));
      })
      .catch(() => {
        // Unauthenticated or offline: the defaults are already applied, so there is
        // nothing to recover from and nothing worth telling the user about yet.
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyTheme(theme, media.matches);
    apply();
    // `auto` has to follow the OS while the app is open, not only at load.
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return (
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </StrictMode>,
);
