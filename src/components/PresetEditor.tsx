import { useState } from 'react';
import { apiJson } from '../lib/api';
import type { ModelInfo } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';
import type { PresetConfig, ResponseLength } from '../lib/presets/presetConfig';
import { RESPONSE_LENGTHS } from '../lib/presets/presetConfig';
import type { PromptEntry } from '../lib/presets/types';
import { KnobEditor } from './KnobEditor';
import { PromptListEditor } from './PromptListEditor';

/** One preset, as `/api/presets/:id` returns it. */
export interface PresetDetail {
  id: string;
  name: string;
  kind: string;
  knobs: Record<string, number | string | string[]>;
  /** Always complete: the Worker runs `parsePresetConfig` before it answers. */
  config: PresetConfig;
  regex: unknown[];
  /** The imported prompt list, rendered as the tick list. */
  prompts: PromptEntry[];
  created_at: number;
  updated_at: number;
}

/** One row of `/api/presets`. */
export interface PresetSummary {
  id: string;
  name: string;
  kind: string;
  created_at: number;
  updated_at: number;
  /** `json_each` count over the stored knob map. */
  knob_count: number;
  /** SQLite 0/1, not booleans — the columns are `(x IS NOT NULL)` expressions. */
  has_regex: number;
  has_prompts: number;
  has_config: number;
}

/**
 * Edits one preset: its sampler knobs and its `PresetConfig`.
 *
 * The two halves are edited together because they are one object to the user, but they
 * are stored in two columns and mean different things. Knobs are sent to the provider
 * and either accepted or refused, so they are gated on the selected model's advertised
 * support — a preset is authored against a model, and a control that cannot take effect
 * is worse than no control. The config is prompt structure, and is independent of the
 * model entirely.
 */
export function PresetEditor({
  preset,
  onSaved,
  onCancel,
}: {
  preset: PresetDetail;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const settings = useAsync(
    () => apiJson<{ provider?: string; model?: string }>('/api/settings'),
    [],
  );
  const provider = settings.data?.provider ?? '';
  const model = settings.data?.model ?? '';
  const models = useAsync(
    () => (provider ? apiJson<ModelInfo[]>(`/api/models/${provider}`) : Promise.resolve([])),
    [provider],
  );

  const [name, setName] = useState(preset.name);
  // Knob support is decided against the model chosen in Settings, so the editor needs
  // the same provider/model pair the chat will send with. KnobEditor takes the numeric
  // half as JSON text and owns the support gating; this component owns the rest.
  const [knobsJson, setKnobsJson] = useState(() => JSON.stringify(numericKnobs(preset.knobs)));
  const [config, setConfig] = useState<PresetConfig>(preset.config);
  const [stopText, setStopText] = useState(() => (preset.config.stopStrings ?? []).join('\n'));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The preset's own model list, independent of what the chat is set to: this is the
  // model the preset will force when it is attached.
  const presetModels = useAsync(
    () =>
      config.provider
        ? apiJson<ModelInfo[]>(`/api/models/${config.provider}`)
        : Promise.resolve([]),
    [config.provider],
  );

  const carried = Object.entries(preset.knobs).filter(([, value]) => typeof value !== 'number');

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      // Non-numeric knobs are merged back untouched: they came from an import that knew
      // what they were (a stop sequence list, a sampler-chain string), and a form that
      // cannot edit them must not be a form that deletes them.
      const knobs: Record<string, number | string | string[]> = { ...Object.fromEntries(carried) };
      for (const [key, value] of Object.entries(JSON.parse(knobsJson) as Record<string, number>)) {
        if (typeof value === 'number' && Number.isFinite(value)) knobs[key] = value;
      }

      await apiJson<PresetDetail>(`/api/presets/${encodeURIComponent(preset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          id: preset.id,
          name,
          knobs,
          config: { ...config, stopStrings: splitStops(stopText) },
        }),
      });
      onSaved();
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-pad space-y-4">
      <label className="block space-y-1">
        <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">Name</span>
        <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
      </label>

      <KnobEditor
        provider={provider}
        model={model}
        models={models.data ?? []}
        value={knobsJson}
        onChange={setKnobsJson}
      />

      {carried.length > 0 && (
        <div className="space-y-1">
          <p className="text-[var(--text-xs)] text-[var(--ink-dim)]">
            Carried through from the import — not editable here, and preserved on save:
          </p>
          <ul className="space-y-0.5 font-mono text-[var(--text-xs)] text-[var(--ink-faint)]">
            {carried.map(([key, value]) => (
              <li key={key}>
                {key} = {JSON.stringify(value)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="space-y-3">
        <h3 className="text-[var(--text-sm)] font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
          Model
        </h3>
        <p className="form-hint" style={{ marginTop: 0 }}>
          Sampler values are per-model, so a preset is authored against one. Setting the pair
          here means choosing this preset also chooses the model it was tuned for. Leave it on
          the defaults to use whatever the chat is already set to.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">Provider</span>
            <select
              className="field"
              value={config.provider ?? ''}
              onChange={(event) => setConfig({ ...config, provider: event.target.value, model: '' })}
            >
              <option value="">— use the chat's —</option>
              <option value="openrouter">openrouter</option>
              <option value="kenari">kenari</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">Model</span>
            <select
              className="field"
              value={config.model ?? ''}
              disabled={!config.provider}
              onChange={(event) => setConfig({ ...config, model: event.target.value })}
            >
              <option value="">— use the chat's —</option>
              {(presetModels.data ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name ? `${entry.name} (${entry.id})` : entry.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        {presetModels.error && <p className="note warn">{presetModels.error}</p>}
      </section>

      <section className="space-y-3">
        <h3 className="text-[var(--text-sm)] font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
          Prompt structure
        </h3>

        <ConfigText
          label="System prompt"
          hint="Used when the card defines none. Part of the cached prefix, so it must not change per turn."
          value={config.systemPrompt ?? ''}
          onChange={(value) => setConfig({ ...config, systemPrompt: value })}
          rows={3}
        />
        <ConfigText
          label="Pre-history instructions"
          hint="Injected before the history. In the cached prefix — anything varying per turn belongs in the author's note instead."
          value={config.preHistoryInstructions ?? ''}
          onChange={(value) => setConfig({ ...config, preHistoryInstructions: value })}
          rows={3}
        />
        <ConfigText
          label="Post-history instructions"
          hint="Replaces the card's when set — one directive, not two competing ones."
          value={config.postHistoryInstructions ?? ''}
          onChange={(value) => setConfig({ ...config, postHistoryInstructions: value })}
          rows={3}
        />
        <ConfigText
          label="Impersonation prompt"
          hint="Used when the reply is written as you."
          value={config.impersonationPrompt ?? ''}
          onChange={(value) => setConfig({ ...config, impersonationPrompt: value })}
          rows={2}
        />
        <ConfigText
          label="Assistant prefill"
          hint="The reply must begin with this. Sent as a trailing assistant turn, which is the only form providers honour."
          value={config.assistantPrefill ?? ''}
          onChange={(value) => setConfig({ ...config, assistantPrefill: value })}
          rows={1}
        />
        <PromptListEditor
          entries={preset.prompts}
          order={config.promptOrder ?? []}
          onChange={(next) => setConfig({ ...config, promptOrder: next })}
        />

        <ConfigText
          label="Stop strings"
          hint="One per line. Up to 32; blanks are dropped."
          value={stopText}
          onChange={setStopText}
          rows={3}
        />

        <div className="grid grid-cols-2 gap-3">
          <ConfigNumber
            label="Max output tokens"
            value={config.maxTokens}
            onChange={(value) => setConfig({ ...config, maxTokens: value })}
          />
          <ConfigNumber
            label="Context size"
            value={config.contextSize}
            onChange={(value) => setConfig({ ...config, contextSize: value })}
          />
          <ConfigNumber
            label="Lore scan depth"
            value={config.loreScanDepth}
            onChange={(value) => setConfig({ ...config, loreScanDepth: value })}
          />
          <ConfigNumber
            label="Lore token budget"
            value={config.loreTokenBudget}
            onChange={(value) => setConfig({ ...config, loreTokenBudget: value })}
          />
        </div>

        {/* Reply length. Its own block rather than a number in the grid above, because it
            is not a token count: the choice is about shape, and the description under the
            control is what tells the reader what they are picking. */}
        <div className="space-y-1">
          <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">Reply length</span>
          <select
            className="field"
            value={config.responseLength ?? 'auto'}
            onChange={(event) =>
              setConfig({ ...config, responseLength: event.target.value as ResponseLength })
            }
          >
            {RESPONSE_LENGTHS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="block text-[var(--text-xs)] text-[var(--ink-faint)]">
            {RESPONSE_LENGTHS.find((option) => option.value === (config.responseLength ?? 'auto'))
              ?.description}
          </span>
        </div>

        {config.responseLength === 'custom' && (
          <ConfigText
            label="Your length instruction"
            hint="Sent to the model as written. A sentence or two works better than a word count."
            value={config.responseLengthCustom ?? ''}
            onChange={(value) => setConfig({ ...config, responseLengthCustom: value })}
            rows={2}
          />
        )}

        <div className="space-y-2">
          <ConfigFlag
            label="Prefix history lines with speaker names"
            checked={config.includeNames === true}
            onChange={(value) => setConfig({ ...config, includeNames: value })}
          />
          <ConfigFlag
            label="Ban emojis"
            checked={config.banEmojis === true}
            onChange={(value) => setConfig({ ...config, banEmojis: value })}
          />
          <ConfigFlag
            label="Trim an unfinished final sentence"
            checked={config.trimIncompleteSentences === true}
            onChange={(value) => setConfig({ ...config, trimIncompleteSentences: value })}
          />
          <ConfigFlag
            label="Let a matched lore entry trigger further entries"
            checked={config.loreRecursive === true}
            onChange={(value) => setConfig({ ...config, loreRecursive: value })}
          />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn primary min-h-10"
          onClick={() => void save()}
          disabled={busy || name.trim().length === 0}
        >
          {busy ? 'Saving…' : 'Save preset'}
        </button>
        <button type="button" className="btn min-h-10" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {status && <span className="text-[var(--text-sm)] text-[var(--danger)]">{status}</span>}
      </div>
    </section>
  );
}

/** The numeric subset, which is the part KnobEditor can express. */
function numericKnobs(knobs: Record<string, number | string | string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(knobs)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function splitStops(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function ConfigText({
  label,
  hint,
  value,
  onChange,
  rows,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  rows: number;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">{label}</span>
      <textarea
        className="field"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="block text-[var(--text-xs)] text-[var(--ink-faint)]">{hint}</span>
    </label>
  );
}

/**
 * A bounded number.
 *
 * The draft is held as text so a field can be emptied while it is being retyped; an
 * empty or unparseable draft is sent as no value at all, which the Worker turns into the
 * default. The bound itself lives in `presetConfig.ts` and is applied on the server, so
 * the client and the stored row can never disagree about it.
 */
function ConfigNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));

  return (
    <label className="block space-y-1">
      <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">{label}</span>
      <input
        className="field"
        inputMode="numeric"
        value={draft}
        placeholder="default"
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const numeric = Number(raw);
          onChange(raw.trim() !== '' && Number.isFinite(numeric) ? numeric : undefined);
        }}
      />
    </label>
  );
}

function ConfigFlag({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5 shrink-0 accent-[var(--brass)]"
      />
      <span className="text-[var(--text-sm)]">{label}</span>
    </label>
  );
}
