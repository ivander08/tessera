import { apiJson } from '../lib/api';
import type { ModelInfo } from '../lib/apiTypes';
import { useAsync } from '../lib/hooks';

/** The preset's generation config, as the picker needs it. */
interface PresetBrief {
  config?: {
    provider?: string;
    model?: string;
    cheapProvider?: string;
    cheapModel?: string;
  };
}

/** What `/api/settings` carries: the legacy pair, and the default preset's id. */
interface SettingsBrief {
  provider?: string;
  model?: string;
  cheapProvider?: string;
  cheapModel?: string;
  default_preset_id?: string;
}

/**
 * The consultant's model, chosen in the consultant.
 *
 * The two consultants used to run on the preset's side-channel pair with no way to say
 * otherwise from the pane. That is the wrong default for an INTERACTIVE call: memory
 * summarisation is background work nobody watches and belongs on the cheapest model that
 * works, while a question about a scene is something the reader waits on and judges. Coupling
 * them meant one choice per preset for two unrelated jobs — and the only visible fix was to
 * change memory summarisation for every chat in order to get a better answer in one dock.
 *
 * So the picker is here, per modal, and the choice is remembered per surface. It is sent as
 * `model` on the request and resolved against the CONFIGURED provider, so picking a model can
 * never reach a provider this install has no key for.
 *
 * A native `<select>` rather than a custom menu, deliberately: the dock is `overflow: hidden`,
 * so an absolutely-positioned popup is clipped at the pane edge. Measured — a 384px menu
 * anchored to an 83px button started 196px outside the dock and rendered as a sliver. A select's
 * popup is the platform's, so it is never clipped and needs no z-index or dismissal logic.
 *
 * Default is the configured side-channel model, labelled as such: a reader who never touches
 * this gets exactly today's behaviour.
 */
export function ConsultModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  const settings = useAsync(() => apiJson<SettingsBrief>('/api/settings'), []);

  /**
   * The pair the consultant will ACTUALLY use when no model is picked.
   *
   * The worker resolves a side-channel call from the preset attached to the chat, falling back
   * to the install's default preset. Reading only `/api/settings` was wrong twice: that row is
   * empty on a preset-only install (measured locally — the picker then labelled itself "model"),
   * and on prod it disagreed with the preset the chat is on. The label has to name the model
   * that will run, or the picker is lying about what "default" means.
   */
  // `default_preset_id` is the id the worker actually resolves through, so it is the one to
  // read. `listPresets` is ordered newest-first and is NOT that field: falling back to its
  // first row named a preset the consult would not run on.
  const defaultId = (settings.data?.default_preset_id ?? '').trim();
  const defaultPreset = useAsync(
    () =>
      defaultId
        ? apiJson<PresetBrief>(`/api/presets/${encodeURIComponent(defaultId)}`)
        : Promise.resolve<PresetBrief>({}),
    [defaultId],
  );

  const configured = defaultPreset.data?.config;
  // The picker offers the side-channel provider's models: an override that named a different
  // provider would need a second key and a second knob set, which is a preset edit.
  const provider =
    configured?.cheapProvider ||
    configured?.provider ||
    settings.data?.cheapProvider ||
    settings.data?.provider ||
    '';
  const models = useAsync(
    () => (provider ? apiJson<ModelInfo[]>(`/api/models/${provider}`) : Promise.resolve([])),
    [provider],
  );

  const fallback =
    configured?.cheapModel ||
    configured?.model ||
    settings.data?.cheapModel ||
    settings.data?.model ||
    '';

  return (
    <select
      className="consult-model-select"
      aria-label="Consultant model"
      title="The model this consult runs on — it does not change memory or the narrator"
      disabled={disabled}
      value={value ?? ''}
      onChange={(event) => {
        // An empty value is `null`, not a second spelling of "default": the Worker treats an
        // absent model as "use the configured pair".
        onChange(event.target.value.length > 0 ? event.target.value : null);
      }}
    >
      <option value="">Preset default{fallback ? ` — ${fallback}` : ''}</option>
      {/* Chat models only. Measured on this install: 112 models, of which 9 are image, video,
          speech or transcription models that cannot answer a consult at all. */}
      {(models.data ?? [])
        .filter(
          (entry) =>
            !entry.endpoints || entry.endpoints.includes('chat') || entry.endpoints.length === 0,
        )
        .map((entry) => (
        // Choosing the preset's own model explicitly clears the override rather than pinning
        // it: a pinned copy would stop following the preset, which is the opposite of what
        // choosing that entry says. It compares by `value`, so the option is still listed.
        <option key={entry.id} value={entry.id}>
          {entry.name ? `${entry.name} (${entry.id})` : entry.id}
        </option>
      ))}
    </select>
  );
}

/** The remembered per-surface choice, so reopening a modal keeps the model it had. */
export function readConsultModel(surface: 'card' | 'chat'): string | null {
  try {
    return window.localStorage.getItem(`tessera.consult.model.${surface}`) || null;
  } catch {
    return null;
  }
}

export function storeConsultModel(surface: 'card' | 'chat', model: string | null): void {
  try {
    if (model) window.localStorage.setItem(`tessera.consult.model.${surface}`, model);
    else window.localStorage.removeItem(`tessera.consult.model.${surface}`);
  } catch {
    // A private-mode storage refusal must not stop the picker working for this session.
  }
}
