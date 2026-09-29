import type { ModelInfo } from '../lib/apiTypes';
import { buildSupportMap, knobSupport } from '../lib/presets/knobSupport';

/**
 * Knobs are honest: a control the selected model cannot honour is disabled with a
 * reason rather than silently dropped by the provider. Support data comes from
 * `knobSupport.ts`, which is the single implementation of that rule — OpenRouter
 * publishes `supported_parameters` per model, Kenari publishes none so its documented
 * field set is the allowlist.
 */
const KNOBS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'temperature', label: 'Temperature', hint: '0.7–1.2 is the usual roleplay range.' },
  { key: 'top_p', label: 'Top P', hint: 'Nucleus sampling. Leave at 1 to use top_k instead.' },
  { key: 'top_k', label: 'Top K', hint: 'llama.cpp only.' },
  { key: 'min_p', label: 'Min P', hint: 'llama.cpp only.' },
  { key: 'repetition_penalty', label: 'Repetition penalty', hint: '1.0 is neutral.' },
  { key: 'frequency_penalty', label: 'Frequency penalty', hint: 'OpenAI-style.' },
  { key: 'presence_penalty', label: 'Presence penalty', hint: 'OpenAI-style.' },
  { key: 'dry_multiplier', label: 'DRY multiplier', hint: 'Needs DRY-capable backends.' },
  { key: 'xtc_probability', label: 'XTC probability', hint: 'Needs XTC-capable backends.' },
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
    if (!provider || !model) return { enabled: false, reason: 'Choose a provider and model first.' };
    const { supported, reason } = knobSupport(supportMap, model, key, provider);
    return { enabled: supported, reason };
  }

  function update(key: string, raw: string) {
    const next = { ...knobs };
    if (raw.trim().length === 0) delete next[key];
    else next[key] = Number(raw);
    onChange(JSON.stringify(next));
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-dim">Sampler</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {KNOBS.map((knob) => {
          const { enabled, reason } = support(knob.key);
          const current = knobs[knob.key];
          return (
            <label key={knob.key} className="block space-y-1" title={enabled ? knob.hint : reason}>
              <span className={`text-xs ${enabled ? 'text-ink-dim' : 'text-ink-dim/50'}`}>
                {knob.label}
                {!enabled && <span className="ml-2 text-amber-500/70">unsupported</span>}
              </span>
              <input
                value={current === undefined ? '' : String(current)}
                onChange={(event) => update(knob.key, event.target.value)}
                disabled={!enabled}
                inputMode="decimal"
                placeholder={enabled ? 'default' : reason}
                className="w-full rounded border border-white/15 bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-40"
              />
            </label>
          );
        })}
      </div>
    </section>
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
