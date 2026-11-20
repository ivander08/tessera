/**
 * Every gateway this app can talk to.
 *
 * One list, because the same options are rendered in the preset editor, in the settings
 * screen's key rows, and (from `/api/keys`) in the consultant picker. Three copies drifted
 * the moment a provider was added: `opencode-go` existed in the worker and in settings
 * while the preset editor still offered only the other two, so the preset could not select
 * the gateway the consultant was already using.
 *
 * Order is the display order. A provider without a stored key still appears — the option
 * is how the reader discovers it, and the worker answers with a clear "no key" message.
 */
export const PROVIDERS = ['openrouter', 'kenari', 'opencode-go'] as const;

export type ProviderName = (typeof PROVIDERS)[number];
