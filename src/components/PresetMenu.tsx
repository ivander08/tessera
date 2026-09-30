import { useState } from 'react';
import { apiJson } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { MenuAction, MenuLabel, MenuSep } from './AppBar';
import { PresetEditor, type PresetDetail } from './PresetEditor';
import { Modal } from './Modal';

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
 *
 * Editing happens in a modal over the chat rather than by navigating away. Adjusting the
 * preset is something you do mid-scene, and losing your place in the transcript to do it
 * is the same mistake as putting the picker in Settings.
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
  const [editing, setEditing] = useState<PresetDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

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

  async function edit(presetId: string) {
    setProblem(null);
    try {
      setEditing(await apiJson<PresetDetail>(`/api/presets/${encodeURIComponent(presetId)}`));
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
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

      {/* Scrolls, so a long list cannot push the rest of the menu off the screen. */}
      <div className="menu-scroll">
        {rows.map((preset) => (
          <div key={preset.id} className="menu-row">
            <MenuAction
              label={preset.name}
              hint={current === preset.id ? '✓' : preset.knob_count ? `${preset.knob_count}` : undefined}
              onClick={() => void choose(preset.id)}
            />
            <button
              type="button"
              className="menu-edit"
              data-menu-keep
              title={`Edit ${preset.name}`}
              aria-label={`Edit ${preset.name}`}
              onClick={() => void edit(preset.id)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {problem && <div className="menu-item" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{problem}</div>}

      {current && (
        <>
          <MenuSep />
          <MenuAction label="Use global settings" onClick={() => void choose(null)} />
        </>
      )}

      {editing && (
        <Modal
          title={editing.name}
          subtitle="Changes apply from the next turn. Chats using this preset pick them up then."
          onClose={() => setEditing(null)}
        >
          <PresetEditor
            key={editing.id}
            preset={editing}
            onSaved={() => {
              setEditing(null);
              presets.reload();
              onChanged?.();
            }}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </>
  );
}
