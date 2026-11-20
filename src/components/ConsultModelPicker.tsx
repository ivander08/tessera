import { useEffect } from 'react';
import { apiJson } from '../lib/api';
import { encodeConsultChoice, resolveStoredChoice } from '../lib/consultChoice';
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

/** `GET /api/keys` — which providers have a key stored, never the key itself. */
interface KeyRow {
  provider: string;
}

/** Chat models only. Image, video, speech and transcription models cannot answer a consult. */
function canChat(entry: ModelInfo): boolean {
  if (entry.type && entry.type !== 'chat') return false;
  if (!entry.endpoints || entry.endpoints.length === 0) return true;
  return entry.endpoints.includes('chat');
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
 * So the picker is here, per modal, and the choice is remembered per surface. It offers
 * every provider this install holds a key for, in groups, because a faster gateway is the
 * difference between a consult that answers and one the reader gives up on. The choice is
 * sent as `provider` + `model`, so picking a model can never reach a provider with no key:
 * the worker only accepts a registered adapter.
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
  const provider =
    configured?.cheapProvider ||
    configured?.provider ||
    settings.data?.cheapProvider ||
    settings.data?.provider ||
    '';
  const fallback =
    configured?.cheapModel ||
    configured?.model ||
    settings.data?.cheapModel ||
    settings.data?.model ||
    '';

  // Every gateway with a key, plus the configured one (its catalogue is worth showing even
  // before a key is pasted — that is how the reader learns which models exist).
  const keys = useAsync(() => apiJson<KeyRow[]>('/api/keys'), []);
  const providers = Array.from(
    new Set([...(keys.data ?? []).map((row) => row.provider), provider].filter(Boolean)),
  ).sort();
  const providerKey = providers.join(',');

  const catalogue = useAsync(async () => {
    const lists = await Promise.all(
      providers.map(async (id) => {
        try {
          return { provider: id, models: await apiJson<ModelInfo[]>(`/api/models/${id}`) };
        } catch {
          // A provider whose catalogue fails must not blank the others. The group simply
          // does not appear; the rest of the picker still works.
          return { provider: id, models: [] };
        }
      }),
    );
    return lists.filter((group) => group.models.some(canChat));
  }, [providerKey]);

  const groups = catalogue.data ?? [];

  // A value saved before the picker named providers is a bare model id. Resolve it against
  // the catalogues that actually exist: upgrade it to a qualified choice when some gateway
  // carries it, and drop it when none does — a stale id otherwise overrides the preset with
  // a model the preset's provider has never heard of.
  const chatGroups = groups.map((group) => ({
    provider: group.provider,
    ids: group.models.filter(canChat).map((entry) => entry.id),
  }));
  useEffect(() => {
    // Nothing to validate against yet, or every catalogue failed: leave the value alone
    // rather than clearing a choice that may be perfectly good.
    if (catalogue.loading || chatGroups.length === 0) return;
    const next = resolveStoredChoice(value, chatGroups, provider);
    if (next !== value) onChange(next);
    // `chatGroups` is derived from `catalogue.data`, which changes with `providerKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, catalogue.loading, providerKey, provider]);

  const known = new Set(
    groups.flatMap((group) =>
      group.models.filter(canChat).map((entry) => encodeConsultChoice({ provider: group.provider, model: entry.id })),
    ),
  );

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
      {value && !known.has(value) ? (
        // A value the catalogue has not validated yet (it is still loading, or every
        // gateway failed). Once a catalogue arrives, the effect above either upgrades or
        // drops it; until then, showing it beats a blank select.
        <option value={value}>{value}</option>
      ) : null}
      {groups.map((group) => (
        <optgroup key={group.provider} label={group.provider}>
          {group.models.filter(canChat).map((entry) => (
            <option
              key={`${group.provider}|${entry.id}`}
              value={encodeConsultChoice({ provider: group.provider, model: entry.id })}
            >
              {entry.name ? `${entry.name} (${entry.id})` : entry.id}
            </option>
          ))}
        </optgroup>
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
