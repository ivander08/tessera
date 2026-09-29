import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import type { ModelInfo, ProviderKeyRow } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';
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
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-dim">Provider keys</h2>
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
              className="flex-1 rounded border border-white/15 bg-black/30 px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void saveKey(providerId)}
              className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            >
              Save
            </button>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-dim">Model</h2>
        <div className="flex gap-2">
          <select
            value={provider}
            onChange={(event) => setForm({ ...form, provider: event.target.value, model: '' })}
            className="rounded border border-white/15 bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-accent"
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
            className="flex-1 rounded border border-white/15 bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-40"
          >
            <option value="">— model —</option>
            {modelList.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name ? `${entry.name} (${entry.id})` : entry.id}
              </option>
            ))}
          </select>
        </div>
        {models.error && <p className="text-sm text-amber-400">{models.error}</p>}
        <p className="text-xs text-ink-dim">
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

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-dim">Prompt</h2>
        <Field label="System prompt (used when the card defines none)">
          <textarea
            value={form.systemPrompt ?? ''}
            onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
            rows={4}
            className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Author's note (tail — safe to change every turn)">
          <input
            value={form.authorsNote ?? ''}
            onChange={(event) => setForm({ ...form, authorsNote: event.target.value })}
            className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <div className="flex gap-3">
          <Field label="Max output tokens">
            <input
              value={form.maxTokens ?? ''}
              onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
              inputMode="numeric"
              className="w-32 rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
          <Field label="Context budget (prompt tokens)">
            <input
              value={form.contextBudget ?? ''}
              onChange={(event) => setForm({ ...form, contextBudget: event.target.value })}
              inputMode="numeric"
              className="w-40 rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </div>
        <Field label="Cheap model provider (used for summaries, state updates and drafting)">
          <input
            value={form.cheapProvider ?? ''}
            onChange={(event) => setForm({ ...form, cheapProvider: event.target.value })}
            placeholder={form.provider ?? 'same as above'}
            className="w-48 rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Cheap model id">
          <input
            value={form.cheapModel ?? ''}
            onChange={(event) => setForm({ ...form, cheapModel: event.target.value })}
            placeholder={form.model ?? 'same as above'}
            className="w-64 rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="IDR per USD (Kenari bills in Rupiah; blank leaves costs unreported)">
          <input
            value={form.idrPerUsd ?? ''}
            onChange={(event) => setForm({ ...form, idrPerUsd: event.target.value })}
            inputMode="decimal"
            className="w-32 rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
      </section>

      <ThemeEditor value={theme} onChange={setTheme} />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-black"
        >
          Save settings
        </button>
        {status && <span className="text-sm text-ink-dim">{status}</span>}
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <nav className="flex items-center gap-3">
          {/* Presets are the other half of the sampler and prompt settings on this
              screen, so this is where you go looking for them. */}
          <Link to="/presets" className="text-sm text-ink-dim hover:text-ink">
            Presets
          </Link>
          <Link to="/" className="text-sm text-ink-dim hover:text-ink">
            ← Chats
          </Link>
        </nav>
      </header>
      {children}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-ink-dim">{label}</span>
      {children}
    </label>
  );
}
