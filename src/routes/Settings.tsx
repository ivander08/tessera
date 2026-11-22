import { useEffect, useState } from 'react';
import { apiJson } from '../lib/api';
import type { ProviderKeyRow } from '../lib/apiTypes';
import { messageOf, useAsync, useUnsavedChanges } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { ThemeEditor, useLiveTheme } from '../components/ThemeEditor';
import { useToast } from '../components/Toast';
import type { PresetSummary } from '../components/PresetEditor';
import { PROVIDERS } from '../lib/providers';
import { parseTheme, type Theme } from '../lib/theme';
import { parseSteers, STEERS_SETTING_KEY, type Steer } from '../lib/steers';


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
  /** Custom steering chips, a JSON array of `{label, text}`; see `src/lib/steers.ts`. */
  steers?: string;
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
  // What the theme looked like when the row was loaded. A snapshot is needed because the
  // editor mutates `theme` live: without the original there is nothing to call "changed".
  // Null until the settings row arrives, which keeps the first paint from counting as a
  // pending edit.
  const [themeSeed, setThemeSeed] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  // Which provider keys are currently readable. A 50-character key typed blind on a
  // phone is unverifiable without one.
  const [shownKey, setShownKey] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  // The default-preset picker saves on change, so it reports its own state rather than
  // sharing `busy` with the Save button it no longer depends on.
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultStatus, setDefaultStatus] = useState<string | null>(null);
  const toast = useToast();

  const form: SettingsShape = { ...data, ...edits };

  // Seed the theme editor from storage when the row loads, then let it own the value.
  // Re-seeding on every render would fight the user's drag; keyed on the fetched object,
  // a reload after saving re-seeds from what the server actually stored.
  useEffect(() => {
    if (!data) return;
    const seeded = parseTheme(data.theme);
    setTheme(seeded);
    setThemeSeed(JSON.stringify(seeded));
  }, [data]);

  useLiveTheme(theme);

  // Three ways the screen can hold something the server does not: an edited field, a
  // provider key typed but not stored, or a theme dragged away from the snapshot. The
  // default-preset picker is excluded because it writes on change — its value is pending
  // nothing, and counting it would warn about work the user already committed.
  const dirty =
    Object.keys(edits).some((key) => key !== 'default_preset_id') ||
    Object.values(keyDraft).some((value) => value.trim() !== '') ||
    (themeSeed !== null && JSON.stringify(theme) !== themeSeed);
  useUnsavedChanges(dirty);

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
      // The form no longer holds anything the server lacks. Clearing here rather than
      // waiting for the reload keeps the unsaved guard from firing on a page the user
      // just committed — including when they close the tab before the fetch lands.
      setEdits({});
      setThemeSeed(JSON.stringify(theme));
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

  /**
   * Writes `default_preset_id` by itself.
   *
   * Separate from `save()` because it is a different kind of change: picking the default
   * preset is a choice about which chat template applies, not a form field waiting for a
   * commit. It writes the pointer ALONE, so a typo in another field cannot block it and a
   * failure here cannot half-save the rest.
   */
  async function saveDefaultPreset(value: string): Promise<void> {
    setSavingDefault(true);
    try {
      await apiJson('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: { default_preset_id: value } }),
      });
      setDefaultStatus(value ? 'Saved.' : 'Cleared.');
      reload();
    } catch (cause) {
      setDefaultStatus(messageOf(cause));
    } finally {
      setSavingDefault(false);
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

  // The custom steering chips shown on the composer ahead of the built-in six. Like the
  // default-preset picker they write on change — a chip list is a set of small committed
  // actions, not a form field waiting for one Save — so nothing here participates in the
  // unsaved-changes guard.
  const customSteers = parseSteers(data?.steers);
  const [chipLabel, setChipLabel] = useState('');
  const [chipPrompt, setChipPrompt] = useState('');
  const [savingChips, setSavingChips] = useState(false);

  /**
   * Writes the whole chip list as the one `steers` setting.
   *
   * Add and remove are the same write: the server stores a string, so every mutation
   * serializes the next array whole. `reload()` re-reads the row afterwards, which keeps
   * this section on the server's truth rather than tracking its own copy.
   */
  async function writeChips(next: Steer[]): Promise<boolean> {
    setSavingChips(true);
    try {
      await apiJson('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: STEERS_SETTING_KEY, value: JSON.stringify(next) }),
      });
      reload();
      return true;
    } catch (cause) {
      toast.failure(messageOf(cause));
      return false;
    } finally {
      setSavingChips(false);
    }
  }

  async function addChip() {
    const label = chipLabel.trim();
    const text = chipPrompt.trim();
    if (label.length === 0 || text.length === 0) return;
    if (await writeChips([...customSteers, { label, text }])) {
      setChipLabel('');
      setChipPrompt('');
      toast.success('Chip added.');
    }
  }

  async function removeChip(index: number) {
    if (await writeChips(customSteers.filter((_, at) => at !== index))) {
      toast.success('Chip removed.');
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
            disabled={savingDefault}
            value={form.default_preset_id ?? ''}
            onChange={(event) => {
              // The pointer is its own save: this control looks like it takes effect
              // immediately — every other select in the app does — and leaving it pending
              // on a Save button three sections down is why it appeared not to stick.
              const value = event.target.value;
              // Only this key is written. Spreading `form` here copied every loaded
              // setting into `edits`, which left the form looking dirty after a change
              // that had already been saved.
              setEdits((current) => ({ ...current, default_preset_id: value }));
              void saveDefaultPreset(value);
            }}
          >
            <option value="">— none —</option>
            {presetList.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>

        {(defaultStatus || savingDefault) && (
          <p className="form-hint" style={{ marginTop: 6 }}>
            {savingDefault ? 'Saving…' : defaultStatus}
          </p>
        )}
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
        <h2 className="eyebrow">Steering chips</h2>
        <p className="form-hint" style={{ marginTop: 0 }}>
          One-tap instructions on the chat composer. A chip steers the next reply only —
          it is never stored in the scene — and your chips are shown ahead of the
          built-in ones.
        </p>

        {customSteers.map((chip, index) => (
          <div key={`${index}:${chip.label}`} className="form-row">
            <span className="form-label">
              <span>{chip.label}</span>
              <span className="form-hint">{chip.text}</span>
            </span>
            <button
              type="button"
              className="btn"
              disabled={savingChips}
              onClick={() => void removeChip(index)}
            >
              Remove
            </button>
          </div>
        ))}
        {customSteers.length === 0 && (
          <p className="form-hint" style={{ marginTop: 6 }}>
            No custom chips yet — the composer shows the six built-in ones.
          </p>
        )}

        <div className="form-row">
          <span className="form-label">
            <span>Add a chip</span>
            <span className="form-hint">
              The label is what you tap; the prompt is the instruction the model receives.
            </span>
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={chipLabel}
              onChange={(event) => setChipLabel(event.target.value)}
              placeholder="Label — e.g. Shorter responses"
              className="field"
              style={{ flex: '0 1 200px', minWidth: 0 }}
              maxLength={40}
            />
            <input
              value={chipPrompt}
              onChange={(event) => setChipPrompt(event.target.value)}
              placeholder="Prompt — e.g. Keep this turn under half its usual length."
              className="field"
              style={{ flex: '1 1 240px', minWidth: 0 }}
              maxLength={400}
            />
            <button
              type="button"
              className="btn"
              disabled={
                savingChips || chipLabel.trim().length === 0 || chipPrompt.trim().length === 0
              }
              onClick={() => void addChip()}
            >
              Add
            </button>
          </div>
        </div>
      </section>

      <section className="section panel panel-pad">
        <h2 className="eyebrow">Provider keys</h2>
        {PROVIDERS.map((providerId) => (
          <div key={providerId} className="form-row">
            <label className="form-label" htmlFor={`provider-key-${providerId}`}>
              <span className="font-mono">{providerId}</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={`provider-key-${providerId}`}
                type={shownKey[providerId] ? 'text' : 'password'}
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
                style={{ fontFamily: 'var(--font-data)', flex: '1 1 140px', minWidth: 0 }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn"
                aria-pressed={shownKey[providerId] ?? false}
                aria-label={shownKey[providerId] ? `Hide ${providerId} key` : `Show ${providerId} key`}
                onClick={() =>
                  setShownKey((current) => ({ ...current, [providerId]: !current[providerId] }))
                }
              >
                {shownKey[providerId] ? 'Hide' : 'Show'}
              </button>
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
