import { useState } from 'react';
import { apiJson } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { MenuAction, MenuLabel, MenuSep } from './AppBar';

/**
 * Switches the preset for the current chat, from the chat's own menu.
 *
 * This is where chub puts it, and the placement is not cosmetic: a preset is a
 * generation configuration — sampler values, stop strings, prefill, prompt structure —
 * and you change it *while* writing, when the prose is coming out wrong. Putting it in
 * Settings meant leaving the scene to adjust the thing that shapes the scene.
 *
 * The list is profile-wide: every preset is available in every chat, and the choice is
 * stored per chat so two scenes can run different settings.
 */
interface PresetRow {
  id: string;
  name: string;
  kind: string;
  knob_count?: number;
}

export function PresetMenu({ chatId, onChanged }: { chatId: string; onChanged?: () => void }) {
  const presets = useAsync(() => apiJson<PresetRow[]>('/api/presets'), []);
  const [current, setCurrent] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Fetched lazily, on first render of the menu — a chat turn should not wait on it.
  if (!loaded) {
    setLoaded(true);
    void apiJson<{ id: string } | null>(`/api/chats/${encodeURIComponent(chatId)}/preset`)
      .then((preset) => setCurrent(preset?.id ?? null))
      .catch(() => setCurrent(null));
  }

  async function choose(presetId: string | null) {
    setCurrent(presetId);
    try {
      await apiJson('/api/preset/apply', {
        method: 'POST',
        body: JSON.stringify({ chatId, presetId }),
      });
      onChanged?.();
    } catch {
      // Put it back, so the tick never lies about what is stored.
      setCurrent(null);
    }
  }

  const rows = presets.data ?? [];

  return (
    <>
      <MenuLabel>Preset for this chat</MenuLabel>

      {presets.loading && <div className="menu-item" style={{ opacity: 0.5 }}>Loading…</div>}

      {!presets.loading && rows.length === 0 && (
        <div className="menu-item" style={{ opacity: 0.6, whiteSpace: 'normal' }}>
          None imported yet. Add one under Presets.
        </div>
      )}

      {rows.map((preset) => (
        <MenuAction
          key={preset.id}
          label={preset.name}
          hint={current === preset.id ? '✓' : preset.knob_count ? `${preset.knob_count}` : undefined}
          onClick={() => void choose(preset.id)}
        />
      ))}

      {current && (
        <>
          <MenuSep />
          <MenuAction label="Use global settings" onClick={() => void choose(null)} />
        </>
      )}
    </>
  );
}
