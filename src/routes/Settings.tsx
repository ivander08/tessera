import { useEffect, useState } from 'react';
import { apiJson } from '../lib/api';
import type { ProviderKeyRow } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { ThemeEditor, useLiveTheme } from '../components/ThemeEditor';
import { useToast } from '../components/Toast';
import type { PresetSummary } from '../components/PresetEditor';
import { parseTheme, type Theme } from '../lib/theme';

const PROVIDERS = ['openrouter', 'kenari'] as const;

/**
 * What is left of the settings row.
 *
 * Everything that shapes a generation belongs to a PRESET now — the model pair, the cheap
 * model pair, every prompt, the token budgets, the lore settings, the sampler knobs. This
 * screen keeps the things that are about the app rather than about a scene: where the keys
 * live, what money is worth, how it looks, and which preset a chat uses when it names none.
 *
 * That split is the whole point. It used to be half and half: the global screen had a
 * system prompt and a context budget but no pre-history, no post-history, no stop strings
 * and no response length, so neither layer could be understood on its own.
 */
interface SettingsShape {
  idrPerUsd?: string;
  default_preset_id?: string;
  theme?: string;
  // Legacy generation keys. Read only by the migration card below; nothing here writes them.
  provider?: string;
  model?: string;
  systemPrompt?: string;
  authorsNote?: string;
  maxTokens?: string;
  contextBudget?: string;
  cheapContextBudget?: string;
  cheapProvider?: string;
  cheapModel?: string;
  knobs?: string;
  loreScanDepth?: string;
  loreTokenBudget?: string;
  loreRecursive?: string;
  reasoning?: string;
}

export default function Settings() {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<SettingsShape>('/api/settings'),
    [],
  );
  const keys = useAsync(() => apiJson<ProviderKeyRow[]>('/api/keys'), []);
  const presets = useAsync(() => apiJson<PresetSummary[]>('/api/presets'), []);

  const [edits, setEdits] = useState<SettingsShape>({});
  const [theme, setTheme] = useState<Theme>(() => parseTheme(null));
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const toast = useToast();

  const form: SettingsShape = { ...data, ...edits };

  // Seed the theme editor from storage once, then let it own the value. Re-seeding on
  // every render would fight the user's drag.
  useEffect(() => {
    if (data?.theme) setTheme(parseTheme(data.theme));
  }, [data?.theme]);

  useLiveTheme(theme);

  const presetList = presets.data ?? [];
  const presetName = (id: string): string =>
    presetList.find((entry) => entry.id === id)?.name ?? 'a deleted preset';

  // A row written before the split still holds generation settings. The card below offers
  // to move them; until then `loadEffectiveSettings` keeps reading them, so nothing breaks.
  const legacy = Boolean(
    data &&
      (data.provider ||
        data.model ||
        data.systemPrompt ||
        data.authorsNote ||
        data.maxTokens ||
        data.contextBudget ||
        data.cheapProvider ||
        data.cheapModel ||
        data.cheapContextBudget),
  );

  async function save() {
    setBusy(true);
    const settings: Record<string, string> = {
      idrPerUsd: form.idrPerUsd ?? '',
      default_preset_id: form.default_preset_id ?? '',
      theme: JSON.stringify(theme),
    };
    try {
      await apiJson('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
      toast.success('Settings saved.');
      reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Moves the legacy generation settings into a new preset and makes it the default.
   *
   * Two calls rather than a bespoke endpoint: create the preset, fill it, then point
   * `default_preset_id` at it. The order matters — the pointer is written LAST, so a
   * failure halfway leaves the install on the legacy row rather than on an empty preset.
   */
  async function migrate() {
    if (!data) return;
    setMigrating(true);
    try {
      const created = await apiJson<{ id: string }>('/api/presets', {
        method: 'POST',
        body: JSON.stringify({ name: 'Default (moved from settings)' }),
      });

      let knobs: unknown = {};
      try {
        knobs = JSON.parse(data.knobs ?? '{}');
      } catch {
        knobs = {};
      }

      await apiJson(`/api/presets/${encodeURIComponent(created.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          id: created.id,
          knobs,
          config: {
            provider: data.provider ?? '',
            model: data.model ?? '',
            cheapProvider: data.cheapProvider ?? '',
            cheapModel: data.cheapModel ?? '',
            cheapContextBudget: Number(data.cheapContextBudget ?? '') || 0,
            reasoning: data.reasoning === 'on',
            authorsNote: data.authorsNote ?? '',
            systemPrompt: data.systemPrompt ?? '',
            maxTokens: Number(data.maxTokens ?? '') || 1024,
            contextSize: Number(data.contextBudget ?? '') || 16384,
            loreScanDepth: Number(data.loreScanDepth ?? '') || 4,
            loreTokenBudget: Number(data.loreTokenBudget ?? '') || 1024,
            loreRecursive: data.loreRecursive === 'true',
          },
        }),
      });

      await apiJson('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          settings: { default_preset_id: created.id },
        }),
      });

      toast.success('Moved into a preset and made it the default.');
      presets.reload();
      reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setMigrating(false);
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
      toast.success(`${providerId} key stored.`);
      keys.reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    }
  }

  if (loading) return <Frame>Loading…</Frame>;
  if (error) return <Frame>{error}</Frame>;

  return (
    <Frame>
      <section className="section panel panel-pad">
        <h2 className="eyebrow">Generation</h2>
        <p className="form-hint" style={{ marginTop: 0 }}>
          Every generation setting lives in a preset: the model and its cheap sibling, the
          prompts, the token budgets, the lore settings and the sampler knobs. The preset a
          chat uses is chosen on the chat screen; this is the one new chats start with.
        </p>

        <label className="form-row" htmlFor="settings-default-preset">
          <span className="form-label">
            <span>Default preset</span>
            <span className="form-hint">
              {form.default_preset_id
                ? `New chats use “${presetName(form.default_preset_id)}”.`
                : 'No default yet — the legacy settings below are still being used.'}
            </span>
          </span>
          <select
            id="settings-default-preset"
            className="field"
            value={form.default_preset_id ?? ''}
            onChange={(event) => setEdits({ ...form, default_preset_id: event.target.value })}
          >
            <option value="">— none —</option>
            {presetList.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>

        {presets.error && <p className="note warn">{presets.error}</p>}

        {legacy && (
          <div className="note" style={{ marginTop: 14 }}>
            <p style={{ margin: '0 0 8px' }}>
              This install still has generation settings in the old place (model, prompts,
              budgets). They keep working, but they are no longer editable here.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => void migrate()}
              disabled={migrating || busy}
            >
              {migrating ? 'Moving…' : 'Move them into a preset'}
            </button>
          </div>
        )}
      </section>

      <section className="section panel panel-pad">
        <h2 className="eyebrow">Provider keys</h2>
        {PROVIDERS.map((providerId) => (
          <div key={providerId} className="form-row">
            <label className="form-label" htmlFor={`provider-key-${providerId}`}>
              <span className="font-mono">{providerId}</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`provider-key-${providerId}`}
                type="password"
                value={keyDraft[providerId] ?? ''}
                onChange={(event) =>
                  setKeyDraft((current) => ({ ...current, [providerId]: event.target.value }))
                }
                placeholder={
                  (keys.data ?? []).some((row) => row.provider === providerId)
                    ? 'stored — replace'
                    : 'not set'
                }
                className="field"
                style={{ fontFamily: 'var(--font-data)' }}
              />
              <button type="button" onClick={() => void saveKey(providerId)} className="btn">
                Save
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="section panel panel-pad">
        <h2 className="eyebrow">Cost</h2>
        <Field label="IDR per USD (Kenari bills in Rupiah; blank leaves costs unreported)">
          <input
            value={form.idrPerUsd ?? ''}
            onChange={(event) => setEdits({ ...form, idrPerUsd: event.target.value })}
            inputMode="decimal"
            className="field"
            style={{ maxWidth: 32 * 4 }}
          />
        </Field>
      </section>

      <ThemeEditor value={theme} onChange={setTheme} />

      {/* 26px, matching the gap between the sections above it. The button was flush
          against the Appearance panel once that panel gained its own spacing. */}
      <div className="flex items-center gap-3" style={{ marginTop: 26 }}>
        <button type="button" onClick={() => void save()} className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
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
    <label className="form-row">
      <span className="form-label">
        <span>{label}</span>
      </span>
      {children}
    </label>
  );
}
