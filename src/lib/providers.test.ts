import { describe, expect, test } from 'bun:test';
import { PROVIDER_IDS, getProvider } from '../../worker/src/providers';
import { PROVIDERS } from './providers';

describe('the offered provider list', () => {
  // The UI list and the transport registry must be the same set. They were not: opencode-go
  // was registered, keyed and listed in settings, while the preset editor still offered only
  // kenari and openrouter — so the gateway the consultant used could not be chosen for a
  // preset at all. A missing option is invisible until someone tries to select it.
  test('matches the worker registry exactly', () => {
    expect([...PROVIDERS].sort()).toEqual([...PROVIDER_IDS].sort());
  });

  test('every offered provider has an adapter', () => {
    for (const id of PROVIDERS) expect(getProvider(id)).not.toBeNull();
  });
});
