import { kenari } from './kenari';
import { openrouter } from './openrouter';
import type { Provider } from './types';

export type ProviderId = 'openrouter' | 'kenari';

const PROVIDERS: Record<ProviderId, Provider> = { openrouter, kenari };

export function getProvider(id: string): Provider | null {
  return id === 'openrouter' || id === 'kenari' ? PROVIDERS[id] : null;
}

export { kenari, openrouter };
export type { ChatRequest, NormalizedUsage, ParsedFrame, Provider } from './types';
