import type { CharacterCardJson } from './types';

/**
 * Copies a card under a new name.
 *
 * A structural clone rather than a spread, and that is the whole point of the function:
 * `characterBook` is an arbitrary nested object and `alternateGreetings`/`tags` are
 * arrays, so a shallow copy would leave the fork sharing them with its source. Both rows
 * would then serialise the same object, and editing the fork's world info would silently
 * edit the original's — a bug that only surfaces after the next save, long after the
 * cause is out of sight.
 *
 * The input is never mutated: the caller still holds it, and a rename that leaked back
 * would rename the character the user was forking *from*.
 */
export function forkCard(card: CharacterCardJson, options: { name: string }): CharacterCardJson {
  const copy = structuredClone(card);
  copy.name = options.name;
  return copy;
}
