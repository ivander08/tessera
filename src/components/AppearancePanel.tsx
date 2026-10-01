import { useEffect, useState } from 'react';
import { apiJson } from '../lib/api';
import { applyTheme, parseTheme, type Theme } from '../lib/theme';
import { ThemeEditor } from './ThemeEditor';
import { useToast } from './Toast';

/**
 * Appearance, reachable from inside the chat.
 *
 * Chub puts this in the chat for a reason: the decisions a reader wants to make about
 * type — is the narration too loud, is the line too long, are the italics too dark — are
 * made while reading, and a settings page you have to leave the scene to reach means the
 * adjustment is made from memory instead of from the thing being adjusted.
 *
 * Changes apply live and save on a debounce, so the reader sees the effect while they
 * are still looking at the text that prompted it. There is no save button for the same
 * reason there is no preview: the transcript behind the panel IS the preview.
 */
export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState<Theme>(() => parseTheme(null));
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    void apiJson<Record<string, string>>('/api/settings')
      .then((settings) => {
        if (alive) {
          setTheme(parseTheme(settings.theme));
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  // Applied to the document on every change so the effect is visible immediately, and
  // written to the server once the reader stops moving the control.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(theme, media.matches);
    const apply = () => applyTheme(theme, media.matches);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void apiJson('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: 'theme', value: JSON.stringify(theme) }),
      }).catch((cause: unknown) =>
        // No success toast: this autosaves on a debounce while the reader drags a slider,
        // so a toast per save would be a stream of them. The transcript behind the panel
        // is the confirmation. A failure is the opposite — it needs saying.
        toast.failure(cause instanceof Error ? cause.message : String(cause)),
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [theme, loaded, toast]);

  return (
    <>
      <ThemeEditor value={theme} onChange={setTheme} />
      <p className="form-hint" style={{ marginTop: 14 }}>
        Changes apply as you make them, and follow you to other devices.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}
