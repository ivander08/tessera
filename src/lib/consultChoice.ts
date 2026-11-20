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

/** One gateway's selectable model ids, as the picker knows them. */
export interface CatalogueGroup {
  provider: string;
  ids: string[];
}

/**
 * Resolves a value saved before the picker named providers.
 *
 * A bare model id was enough when there was one gateway in the picture. It is not enough
 * now: the same id can exist on two of them, and — measured on prod — a stale Kenari id
 * (`glm-5-3-flash`) was resolved against the preset's new provider (opencode-go, where the
 * id is `glm-5.3-flash`) and failed with a 400 that looked like a server bug.
 *
 * The rule: a bare id keeps working only where it actually exists. Prefer the provider the
 * preset names; otherwise use the one gateway that carries it. If no catalogue contains it,
 * return null so the caller falls back to the preset default instead of sending a doomed
 * override.
 *
 * A provider-qualified value is returned untouched — it already says where it belongs, and
 * validating it here would make the picker flicker while a catalogue is still loading.
 */
export function resolveStoredChoice(
  value: string | null,
  groups: CatalogueGroup[],
  preferredProvider: string,
): string | null {
  if (!value) return null;
  if (value.includes('|')) return value;

  const has = (group: CatalogueGroup) => group.ids.includes(value);
  const match =
    groups.find((group) => group.provider === preferredProvider && has(group)) ??
    groups.find(has);

  return match ? encodeConsultChoice({ provider: match.provider, model: value }) : null;
}
