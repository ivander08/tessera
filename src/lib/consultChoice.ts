/**
 * A consultant picker value names the gateway as well as the model.
 *
 * Two providers can carry the same id — `hy4` exists on both Kenari and Opencode Go — so a
 * bare model id cannot say where to send the call. The separator is `|` because model ids
 * are either bare or `author/model`; neither form contains one.
 */
export interface ConsultChoice {
  provider: string | null;
  model: string;
}

export function encodeConsultChoice(choice: { provider: string; model: string }): string {
  return `${choice.provider}|${choice.model}`;
}

/**
 * Splits a stored picker value.
 *
 * A value with no separator is a model id saved before the picker knew about providers. It
 * keeps working exactly as it did: resolved against the configured side-channel pair.
 */
export function decodeConsultChoice(value: string): ConsultChoice {
  const cut = value.indexOf('|');
  return cut > 0
    ? { provider: value.slice(0, cut), model: value.slice(cut + 1) }
    : { provider: null, model: value };
}
