import { useState } from 'react';
import { apiJson } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { PresetEditor, type PresetDetail } from './PresetEditor';
import { Modal } from './Modal';

/**
 * Switches the preset for the current chat, from the chat's own menu.
 *
 * This is where chub puts it, and the placement is not cosmetic: a preset is a
 * generation configuration — sampler values, stop strings, prefill, prompt structure —
 * and you change it *while* writing, when the prose is coming out wrong.
 *
 * The list opens in its own sheet. Inline entries mean a reader with a hundred presets
 * scrolls past all of them every time they want anything else in the menu, and the menu
 * stops being navigable. One entry that opens a list keeps the menu a fixed length.
 *
 * Editing happens in a second sheet over the chat rather than by navigating away, for
 * the same reason the picker is here at all.
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
  const [open, setOpen] = useState(false);
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
    setOpen(false);
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
  const activeName = rows.find((row) => row.id === current)?.name ?? 'Global settings';

  return (
    <>
      {/* The sheet lives in this subtree, so the menu must not close on this click —
          closing it unmounts the sheet before it can paint. The menu does close once a
          preset is chosen, which `choose` does explicitly. */}
      <button
        type="button"
        className="menu-item"
        data-menu-keep
        onClick={() => setOpen(true)}
      >
        <span className="menu-item-label">Preset</span>
        <span className="menu-item-value">{activeName}</span>
      </button>

      {open && (
        <Modal
          title="Preset"
          subtitle="Sampler values, prompt structure, stop strings and the model they were tuned for."
          onClose={() => setOpen(false)}
        >
          {presets.loading && <p className="sheet-sub">Loading…</p>}

          {!presets.loading && rows.length === 0 && (
            <p className="sheet-sub">
              No presets yet. A preset overrides the sampler, prompt and stop-string
              settings for this chat.
            </p>
          )}

          {problem && <div className="note danger" style={{ marginBottom: 10 }}>{problem}</div>}

          <div className="pick-list">
            {rows.map((preset) => (
              <div key={preset.id} className={`pick-row${current === preset.id ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="pick-main"
                  onClick={() => void choose(preset.id)}
                >
                  <span className="pick-name">{preset.name}</span>
                  <span className="pick-note">
                    {preset.kind}
                    {preset.knob_count ? ` · ${preset.knob_count} knobs` : ''}
                  </span>
                  {current === preset.id && <span className="pick-tick">✓</span>}
                </button>
                <button
                  type="button"
                  className="menu-edit"
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

          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            {current && (
              <button type="button" className="btn" onClick={() => void choose(null)}>
                Use global settings
              </button>
            )}
            <a className="btn" href="/presets">
              Manage presets
            </a>
          </div>
        </Modal>
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
