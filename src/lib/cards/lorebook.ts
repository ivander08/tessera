import { asArray, asRecord, asString, asStringArray } from '../json';

export interface LorebookEntry {
  id: string;
  content: string;
  keys: string[];
  constant: boolean;
  enabled: boolean;
  insertionOrder: number;
  /** 0–100. A fired entry is skipped this percentage of the time. Absent means always. */
  probability?: number;
  /** Secondary keys, combined with `keys` according to `selectiveLogic`. */
  secondaryKeys?: string[];
  /**
   * How secondary keys combine: 0 AND_ANY (any secondary), 1 NOT_ALL, 2 NOT_ANY,
   * 3 AND_ALL. The SillyTavern numbering, kept as-is so an imported card round-trips.
   */
  selectiveLogic?: number;
  /** Whether matching is case sensitive. Default false, matching ST. */
  caseSensitive?: boolean;
  /** Only match when the whole word is present. */
  matchWholeWords?: boolean;
}

/**
 * World-info / character-book entries.
 *
 * Two classes with different destinations, and the split is the whole point:
 *
 *  - `constant` entries are always-on and go in the immutable HEAD. They never change,
 *    so they never disturb the cached prefix.
 *  - keyword-triggered entries are matched per turn and go in the TAIL. A keyword firing
 *    on turn 12 must not rewrite the prefix that turns 1-11 already cached — putting
 *    these in the head is the exact failure this project exists to prevent.
 *
 * Before this was implemented, keyword entries were parsed, stored, and then dropped:
 * the only way to get a card's world knowledge into the prompt was to mark every entry
 * constant, which pays for all of them on every turn forever to serve the handful that
 * are relevant.
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
    const probability = asNumberOrUndefined(entry.probability ?? entry.prob);

    out.push({
      id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : String(i),
      content,
      keys: asStringArray(entry.keys),
      constant: entry.constant === true,
      enabled: entry.enabled !== false,
      insertionOrder: typeof entry.insertion_order === 'number' ? entry.insertion_order : i,
      ...(probability !== undefined ? { probability } : {}),
      ...(entry.secondary_keys !== undefined
        ? { secondaryKeys: asStringArray(entry.secondary_keys) }
        : {}),
      ...(typeof entry.selectiveLogic === 'number' ? { selectiveLogic: entry.selectiveLogic } : {}),
      ...(entry.case_sensitive !== undefined ? { caseSensitive: entry.case_sensitive === true } : {}),
      ...(entry.match_whole_words !== undefined
        ? { matchWholeWords: entry.match_whole_words === true }
        : {}),
    });
  }
  return out;
}

function asNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

export interface LoreMatch {
  id: string;
  content: string;
}

export interface MatchOptions {
  /** How many messages back from the end to scan. ST calls this scan depth. */
  scanDepth: number;
  /** Maximum tokens of matched content to return. */
  tokenBudget: number;
  /** Let a matched entry's own text trigger further entries. */
  recursive: boolean;
  count: (text: string) => number;
  /** Injected for determinism in tests; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Selects the keyword entries that fire for this turn.
 *
 * Matched against the LAST `scanDepth` messages, not the whole history. Scanning
 * everything means a keyword mentioned once at message 5 stays active forever, so the
 * tail grows monotonically and the reader ends up paying for the entire lorebook every
 * turn — which is the cost that makes keyword entries worth having in the first place.
 *
 * Output is ordered by `insertionOrder` then id, so the same input always produces the
 * same tail. Two entries with equal order would otherwise be able to swap between turns
 * and change the tail's bytes for no reason.
 */
export function matchLore(
  entries: LorebookEntry[],
  recentText: string[],
  options: MatchOptions,
): LoreMatch[] {
  const random = options.random ?? Math.random;
  const depth = Math.max(1, options.scanDepth);
  const scanned = recentText.slice(-depth).join('\n');

  // Only non-constant entries: constants are already in the head, and matching them here
  // would send the same text twice and pay for it twice.
  const candidates = entries.filter(
    (entry) => entry.enabled && !entry.constant && entry.keys.length > 0,
  );

  const fired: LorebookEntry[] = [];
  for (const entry of candidates) {
    if (!matches(entry, scanned)) continue;
    // Probability is checked after matching, so a low-probability entry still costs
    // nothing when its keyword is absent.
    if (entry.probability !== undefined && entry.probability < 100) {
      if (random() * 100 >= entry.probability) continue;
    }
    fired.push(entry);
  }

  // Recursive: a fired entry's own text can trigger others, which is how cards chain
  // related facts. Bounded by a single pass so a cycle cannot loop.
  if (options.recursive && fired.length > 0) {
    const firedIds = new Set(fired.map((entry) => entry.id));
    const expanded = fired.map((entry) => entry.content).join('\n');
    for (const entry of candidates) {
      if (firedIds.has(entry.id)) continue;
      if (!matches(entry, expanded)) continue;
      fired.push(entry);
      firedIds.add(entry.id);
    }
  }

  fired.sort((a, b) => (a.insertionOrder - b.insertionOrder) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Budget is enforced on the sorted list, so which entries survive is deterministic.
  const out: LoreMatch[] = [];
  let used = 0;
  for (const entry of fired) {
    const cost = options.count(entry.content);
    if (used + cost > options.tokenBudget) break;
    used += cost;
    out.push({ id: entry.id, content: entry.content });
  }
  return out;
}

function matches(entry: LorebookEntry, haystack: string): boolean {
  if (haystack.length === 0) return false;

  const primary = entry.keys.some((key) => keyMatches(key, haystack, entry));
  if (!primary) return false;

  const secondary = entry.secondaryKeys ?? [];
  if (secondary.length === 0) return true;

  const hits = secondary.filter((key) => keyMatches(key, haystack, entry));
  switch (entry.selectiveLogic ?? 0) {
    case 1: // NOT_ALL — at least one secondary missing
      return hits.length < secondary.length;
    case 2: // NOT_ANY — no secondary present
      return hits.length === 0;
    case 3: // AND_ALL — every secondary present
      return hits.length === secondary.length;
    case 0: // AND_ANY — the default
    default:
      return hits.length > 0;
  }
}

function keyMatches(key: string, haystack: string, entry: LorebookEntry): boolean {
  if (key.length === 0) return false;

  const caseSensitive = entry.caseSensitive === true;
  const needle = caseSensitive ? key : key.toLowerCase();
  const text = caseSensitive ? haystack : haystack.toLowerCase();

  if (!entry.matchWholeWords) return text.includes(needle);

  // Word-boundary match without a regex: a regex built from card content is both slow
  // and a place for a crafted key to do something surprising.
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + needle.length] ?? '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

function isWordChar(char: string): boolean {
  return char.length > 0 && /[\p{L}\p{N}_]/u.test(char);
}
