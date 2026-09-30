import type { ModelInfo } from '../lib/apiTypes';
import { buildSupportMap, knobSupport } from '../lib/presets/knobSupport';

/**
 * Sampler knobs, with support read from the provider.
 *
 * A knob the selected model cannot honour is disabled with a reason rather than silently
 * dropped by the provider — that is the honest-knobs rule, and it is why the reason is
 * rendered inline instead of hidden in a tooltip. Silently ignoring a setting is how you
 * end up unable to tell why a control had no effect.
 *
 * No heading of its own: the caller places it in a section, because Settings and the
 * preset editor group it differently.
 */
const KNOBS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'temperature', label: 'Temperature', hint: '0.7–1.2 is the usual roleplay range.' },
  { key: 'top_p', label: 'Top P', hint: 'Nucleus sampling. Leave at 1 to use top_k instead.' },
  { key: 'top_k', label: 'Top K', hint: 'llama.cpp only.' },
  { key: 'min_p', label: 'Min P', hint: 'llama.cpp only.' },
  { key: 'repetition_penalty', label: 'Repetition penalty', hint: '1.0 is neutral.' },
  { key: 'frequency_penalty', label: 'Frequency penalty', hint: 'OpenAI-style.' },
  { key: 'presence_penalty', label: 'Presence penalty', hint: 'OpenAI-style.' },
  { key: 'dry_multiplier', label: 'DRY multiplier', hint: 'Needs a DRY-capable backend.' },
  { key: 'xtc_probability', label: 'XTC probability', hint: 'Needs an XTC-capable backend.' },
  { key: 'seed', label: 'Seed', hint: 'Blank means provider-chosen.' },
];

export function KnobEditor({
  provider,
  model,
  models,
  value,
  onChange,
}: {
  provider: string;
  model: string;
  models: ModelInfo[];
  value: string;
  onChange: (next: string) => void;
}) {
  const knobs = parseKnobs(value);
  const supportMap = buildSupportMap(models);

  function support(key: string): { enabled: boolean; reason: string } {
    if (!provider || !model) {
      return { enabled: false, reason: 'Choose a provider and model first.' };
    }
    const { supported, reason } = knobSupport(supportMap, model, key, provider);
    return { enabled: supported, reason };
  }

  function update(key: string, raw: string) {
    const next = { ...knobs };
    if (raw.trim().length === 0) delete next[key];
    else next[key] = Number(raw);
    onChange(JSON.stringify(next));
  }

  const enabledCount = KNOBS.filter((knob) => support(knob.key).enabled).length;

  return (
    <div className="section">
      <p className="form-hint" style={{ marginBottom: 14 }}>
        {provider && model
          ? `${enabledCount} of ${KNOBS.length} apply to ${model}.`
          : 'Choose a provider and model to see which knobs apply.'}
      </p>

      <div className="field-list two">
        {KNOBS.map((knob) => {
          const { enabled, reason } = support(knob.key);
          const current = knobs[knob.key];

          return (
            <label key={knob.key} className="block">
              <span className="form-label">
                <span style={{ color: enabled ? 'var(--ink)' : 'var(--ink-faint)' }}>
                  {knob.label}
                </span>
                {!enabled && <span className="form-hint">does not apply</span>}
              </span>
              <input
                className="field"
                value={current === undefined ? '' : String(current)}
                onChange={(event) => update(knob.key, event.target.value)}
                disabled={!enabled}
                inputMode="decimal"
                placeholder={enabled ? 'default' : ''}
                title={enabled ? knob.hint : reason}
                aria-describedby={!enabled ? `knob-${knob.key}-why` : undefined}
              />
              {/* The reason is rendered, not tooltipped. A disabled control with no
                  visible explanation is the exact complaint this rule exists to answer. */}
              {!enabled && (
                <span
                  id={`knob-${knob.key}-why`}
                  className="form-hint"
                  style={{ display: 'block', marginTop: 5 }}
                >
                  {reason}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function parseKnobs(value: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}
