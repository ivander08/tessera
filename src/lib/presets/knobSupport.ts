/**
 * Honest knobs.
 *
 * A knob the selected model cannot honour is disabled with a reason rather than sent and
 * silently ignored — which is what SillyTavern does today, and the reason its users
 * cannot tell why a setting had no effect.
 *
 * Note that neither provider documents DRY or XTC: OpenRouter's live
 * `supported_parameters` union over 460 models contains no `dry_*` or `xtc_*` entry, and
 * Kenari documents neither. So those two knobs read as unsupported for every model,
 * which is the truthful answer. `provider.require_parameters: true` is what makes it
 * also the *safe* answer: a provider that cannot honour a parameter is not routed to.
 */

/**
 * Kenari publishes no `supported_parameters`, so support is inferred from the field set
 * in its OpenAPI document (`kenari-openapi.json`, `ChatCompletionRequest.properties`).
 * A parameter absent from that document is not one Kenari has committed to honouring.
 */
const KENARI_SUPPORTED: Record<string, true> = {
  temperature: true,
  top_p: true,
  frequency_penalty: true,
  presence_penalty: true,
  max_tokens: true,
  stop: true,
};

const KENARI_REASON = 'Kenari does not document this parameter.';

/** Model id -> the parameter names that model's provider advertises. */
export function buildSupportMap(
  models: Array<{ id: string; supported_parameters?: string[] }>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const model of models) {
    if (typeof model.id !== 'string' || !Array.isArray(model.supported_parameters)) continue;
    map.set(
      model.id,
      new Set(model.supported_parameters.filter((entry): entry is string => typeof entry === 'string')),
    );
  }
  return map;
}

/**
 * Whether `modelId` on `provider` can honour `knob`, and — when it cannot — why.
 *
 * `reason` is empty when the knob is supported; it exists to justify a refusal, and is
 * meant to be shown to the user next to the disabled control.
 *
 * Missing data never blocks: an OpenRouter model absent from the map is assumed
 * supported, because the map is built from a model list that may be stale, filtered, or
 * simply not fetched yet.
 */
export function knobSupport(
  map: Map<string, Set<string>>,
  modelId: string,
  knob: string,
  provider: string,
): { supported: boolean; reason: string } {
  if (provider === 'kenari') {
    return KENARI_SUPPORTED[knob] === true
      ? { supported: true, reason: '' }
      : { supported: false, reason: KENARI_REASON };
  }

  if (provider === 'openrouter') {
    const supported = map.get(modelId);
    if (!supported) return { supported: true, reason: '' };
    return supported.has(knob)
      ? { supported: true, reason: '' }
      : { supported: false, reason: `OpenRouter does not list "${knob}" for this model.` };
  }

  // An unknown provider has no support data to read, and refusing on that basis would
  // disable every knob for a provider Tessera has not been taught about yet.
  return { supported: true, reason: '' };
}
