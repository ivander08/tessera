import { kenari } from './kenari';
import { opencodeGo } from './opencodeGo';
import { openrouter } from './openrouter';
import type { Provider, ProviderId } from './types';

const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter,
  kenari,
  'opencode-go': opencodeGo,
};

export function getProvider(id: string): Provider | null {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id)
    ? PROVIDERS[id as ProviderId]
    : null;
}

export { kenari, opencodeGo, openrouter };
export type { ChatRequest, NormalizedUsage, ParsedFrame, Provider, ProviderId } from './types';
