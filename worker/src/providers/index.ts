import { kenari } from './kenari';
import { opencodeGo } from './opencodeGo';
import { openrouter } from './openrouter';
import type { Provider, ProviderId } from './types';

const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter,
  kenari,
  'opencode-go': opencodeGo,
};

/**
 * Every registered gateway, for callers that must offer the same set the transport accepts
 * (the preset editor and the settings key rows). Exported rather than duplicated: a third
 * hand-maintained list is how `opencode-go` ended up selectable in the consultant and not in
 * the preset editor.
 */
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function getProvider(id: string): Provider | null {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id)
    ? PROVIDERS[id as ProviderId]
    : null;
}

export { kenari, opencodeGo, openrouter };
export type { ChatRequest, NormalizedUsage, ParsedFrame, Provider, ProviderId } from './types';
