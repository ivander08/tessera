import { asArray, asRecord, asString, asStringArray } from '../json';

export interface LorebookEntry {
  id: string;
  content: string;
  keys: string[];
  constant: boolean;
  enabled: boolean;
  insertionOrder: number;
}

/**
 * World-info / character-book entries.
 *
 * Only entries marked `constant` (and not disabled) are always-on, and those go in
 * the immutable head. Keyword-triggered entries are recall-driven and belong in the
 * tail (M4): a keyword firing on turn 12 must not rewrite the prefix that turns 1-11
 * already cached.
 */
export function parseLorebook(characterBook: unknown): LorebookEntry[] {
  const root = asRecord(characterBook);
  if (!root) return [];

  const out: LorebookEntry[] = [];
  const entries = asArray(root.entries);
  for (let i = 0; i < entries.length; i++) {
    const entry = asRecord(entries[i]);
    if (!entry) continue;
    const content = asString(entry.content);
    if (content.length === 0) continue;

    const rawId = entry.id ?? entry.uid ?? i;
    out.push({
      id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : String(i),
      content,
      keys: asStringArray(entry.keys),
      constant: entry.constant === true,
      enabled: entry.enabled !== false,
      insertionOrder: typeof entry.insertion_order === 'number' ? entry.insertion_order : i,
    });
  }
  return out;
}

/**
 * Always-on entries only, in a fixed order that does not depend on file order.
 *
 * Two entries sharing an id would make `assemble`'s sort unstable between turns,
 * which is exactly the silent prefix mutation this project exists to avoid — so
 * ids are made unique here, deterministically.
 */
export function alwaysOnLore(entries: LorebookEntry[]): Array<{ id: string; content: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.constant || !entry.enabled) continue;
    let id = entry.id;
    let suffix = 1;
    while (seen.has(id)) id = `${entry.id}#${suffix++}`;
    seen.add(id);
    out.push({ id, content: entry.content });
  }
  return out;
}
