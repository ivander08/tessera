import { useEffect, useState } from 'react';
import { apiJson } from '../lib/api';
import type { ModelInfo, ProviderKeyRow } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { KnobEditor } from '../components/KnobEditor';
import { ThemeEditor, useLiveTheme } from '../components/ThemeEditor';
import { parseTheme, type Theme } from '../lib/theme';

const PROVIDERS = ['openrouter', 'kenari'] as const;

interface SettingsShape {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  authorsNote?: string;
  maxTokens?: string;
  contextBudget?: string;
  knobs?: string;
  idrPerUsd?: string;
  cheapProvider?: string;
  cheapModel?: string;
  theme?: string;
}

export default function Settings() {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<SettingsShape>('/api/settings'),
    [],
  );
  const keys = useAsync(() => apiJson<ProviderKeyRow[]>('/api/keys'), []);

  const [edits, setEdits] = useState<SettingsShape>({});
  const [theme, setTheme] = useState<Theme>(() => parseTheme(null));
  const [status, setStatus] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  // The loaded settings are the base; local edits layer on top. Deriving the form
  // during render rather than copying `data` into state in an effect removes a
  // cascading render and a stale-clone class of bug where an edit made before the
  // fetch resolved would be silently discarded.
  const form: SettingsShape = { ...data, ...edits };

  // Seed the theme editor from storage once, then let it own the value. Re-seeding on
  // every render would fight the user's drag.
  useEffect(() => {
    if (data?.theme) setTheme(parseTheme(data.theme));
  }, [data?.theme]);

  // Apply while editing, so a slider shows its effect as it moves rather than after a
  // save round trip.
  useLiveTheme(theme);
  const setForm = (next: SettingsShape) => setEdits(next);

  const provider = form.provider ?? '';
  const model = form.model ?? '';

  const models = useAsync(
    () => (provider ? apiJson<ModelInfo[]>(`/api/models/${provider}`) : Promise.resolve([])),
    [provider, keys.data],
  );

  const modelList = models.data ?? [];

  const keyed = new Set((keys.data ?? []).map((row) => row.provider));

  async function save() {
    setStatus(null);
    const entries: Array<[string, string]> = [
      ['provider', form.provider ?? ''],
      ['model', form.model ?? ''],
      ['systemPrompt', form.systemPrompt ?? ''],
      ['authorsNote', form.authorsNote ?? ''],
      ['maxTokens', form.maxTokens ?? ''],
      ['contextBudget', form.contextBudget ?? ''],
      ['knobs', form.knobs ?? '{}'],
      ['idrPerUsd', form.idrPerUsd ?? ''],
      ['cheapProvider', form.cheapProvider ?? ''],
      ['cheapModel', form.cheapModel ?? ''],
      ['theme', JSON.stringify(theme)],
    ];
    try {
      for (const [key, value] of entries) {
        await apiJson('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ key, value }),
        });
      }
      setStatus('Saved.');
      reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    }
  }

  async function saveKey(providerId: string) {
    const value = (keyDraft[providerId] ?? '').trim();
    if (!value) return;
    try {
      await apiJson(`/api/keys/${providerId}`, {
        method: 'PUT',
        body: JSON.stringify({ key: value }),
      });
      setKeyDraft((current) => ({ ...current, [providerId]: '' }));
      setStatus(`${providerId} key stored.`);
      keys.reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    }
  }

  if (loading) return <Frame>Loading…</Frame>;
  if (error) return <Frame>{error}</Frame>;

  return (
    <Frame>
      <section className="section panel panel-pad">
        <h2 className="eyebrow">Provider keys</h2>
        {PROVIDERS.map((providerId) => (
          <div key={providerId} className="flex items-center gap-2">
            <span className="w-24 font-mono text-sm">{providerId}</span>
            <input
              type="password"
              value={keyDraft[providerId] ?? ''}
              onChange={(event) =>
                setKeyDraft((current) => ({ ...current, [providerId]: event.target.value }))
              }
              placeholder={keyed.has(providerId) ? 'stored — replace' : 'not set'}
              className="field" style={{ fontFamily: 'var(--font-data)' }}
            />
            <button
              type="button"
              onClick={() => void saveKey(providerId)}
              className="btn"
            >
              Save
            </button>
          </div>
        ))}
      </section>

      <section className="section panel panel-pad">
        <h2 className="eyebrow">Model</h2>
        <div className="flex gap-2">
          <select
            value={provider}
            onChange={(event) => setForm({ ...form, provider: event.target.value, model: '' })}
            className="field"
          >
            <option value="">— provider —</option>
            {PROVIDERS.map((providerId) => (
              <option key={providerId} value={providerId}>
                {providerId}
              </option>
            ))}
          </select>

          <select
            value={model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
            disabled={modelList.length === 0}
            className="field"
          >
            <option value="">— model —</option>
            {modelList.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name ? `${entry.name} (${entry.id})` : entry.id}
              </option>
            ))}
          </select>
        </div>
        {models.error && <p className="note warn">{models.error}</p>}
        <p className="form-hint">
          No default model ships with Tessera. Nothing sends until both are chosen here.
        </p>
      </section>

      <KnobEditor
        provider={provider}
        model={model}
        models={modelList}
        value={form.knobs ?? '{}'}
        onChange={(next) => setForm({ ...form, knobs: next })}
      />

      <section className="section panel panel-pad">
        <h2 className="eyebrow">Prompt</h2>
        <Field label="System prompt (used when the card defines none)">
          <textarea
            value={form.systemPrompt ?? ''}
            onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
            rows={4}
            className="field"
          />
        </Field>
        <Field label="Author's note (tail — safe to change every turn)">
          <input
            value={form.authorsNote ?? ''}
            onChange={(event) => setForm({ ...form, authorsNote: event.target.value })}
            className="field"
          />
        </Field>
        <div className="flex gap-3">
          <Field label="Max output tokens">
            <input
              value={form.maxTokens ?? ''}
              onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
              inputMode="numeric"
              className="field" style={{ maxWidth: 32 * 4 }}
            />
          </Field>
          <Field label="Context budget (prompt tokens)">
            <input
              value={form.contextBudget ?? ''}
              onChange={(event) => setForm({ ...form, contextBudget: event.target.value })}
              inputMode="numeric"
              className="field" style={{ maxWidth: 40 * 4 }}
            />
          </Field>
        </div>
        <Field label="Cheap model provider (used for summaries, state updates and drafting)">
          <input
            value={form.cheapProvider ?? ''}
            onChange={(event) => setForm({ ...form, cheapProvider: event.target.value })}
            placeholder={form.provider ?? 'same as above'}
            className="field" style={{ maxWidth: 48 * 4 }}
          />
        </Field>
        <Field label="Cheap model id">
          <input
            value={form.cheapModel ?? ''}
            onChange={(event) => setForm({ ...form, cheapModel: event.target.value })}
            placeholder={form.model ?? 'same as above'}
            className="field" style={{ maxWidth: 64 * 4 }}
          />
        </Field>
        <Field label="IDR per USD (Kenari bills in Rupiah; blank leaves costs unreported)">
          <input
            value={form.idrPerUsd ?? ''}
            onChange={(event) => setForm({ ...form, idrPerUsd: event.target.value })}
            inputMode="decimal"
            className="field" style={{ maxWidth: 32 * 4 }}
          />
        </Field>
      </section>

      <ThemeEditor value={theme} onChange={setTheme} />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="btn primary"
        >
          Save settings
        </button>
        {status && <span className="form-hint">{status}</span>}
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppBar title={<span className="bar-title">Settings</span>} />
      <main className="sheet">{children}</main>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="form-hint">{label}</span>
      {children}
    </label>
  );
}
