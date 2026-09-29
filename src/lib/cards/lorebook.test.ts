import { describe, expect, test } from 'bun:test';
import { alwaysOnLore, matchLore, parseLorebook, type LorebookEntry } from './lorebook';

const entry = (over: Partial<LorebookEntry>): LorebookEntry => ({
  id: '1',
  content: 'content',
  keys: [],
  constant: false,
  enabled: true,
  insertionOrder: 0,
  ...over,
});

const count = (text: string) => text.length;

const base = { scanDepth: 2, tokenBudget: 10_000, recursive: false, count };

describe('parseLorebook', () => {
  test('reads the ST field names, including the selective ones', () => {
    const [parsed] = parseLorebook({
      entries: [
        {
          id: 7,
          keys: ['tavern', 'inn'],
          content: 'The Compass Rose.',
          insertion_order: 3,
          probability: 40,
          secondary_keys: ['rain'],
          selectiveLogic: 3,
          case_sensitive: true,
          match_whole_words: true,
        },
      ],
    });
    expect(parsed.id).toBe('7');
    expect(parsed.keys).toEqual(['tavern', 'inn']);
    expect(parsed.insertionOrder).toBe(3);
    expect(parsed.probability).toBe(40);
    expect(parsed.secondaryKeys).toEqual(['rain']);
    expect(parsed.selectiveLogic).toBe(3);
    expect(parsed.caseSensitive).toBe(true);
    expect(parsed.matchWholeWords).toBe(true);
  });

  test('omits optional fields rather than defaulting them to a value', () => {
    const [parsed] = parseLorebook({ entries: [{ id: 1, keys: ['a'], content: 'x' }] });
    expect(parsed.probability).toBeUndefined();
    expect(parsed.secondaryKeys).toBeUndefined();
  });

  test('still ignores entries with no content', () => {
    expect(parseLorebook({ entries: [{ id: 1, keys: ['a'], content: '' }] })).toHaveLength(0);
  });
});

describe('matchLore', () => {
  test('fires on a keyword present in the scanned text', () => {
    const hits = matchLore([entry({ keys: ['tavern'] })], ['we entered the tavern'], base);
    expect(hits).toHaveLength(1);
  });

  test('does not fire when the keyword is absent', () => {
    expect(matchLore([entry({ keys: ['tavern'] })], ['we walked outside'], base)).toHaveLength(0);
  });

  test('never fires a constant entry — that text is already in the head', () => {
    const hits = matchLore([entry({ keys: ['tavern'], constant: true })], ['the tavern'], base);
    expect(hits).toHaveLength(0);
  });

  test('skips disabled entries', () => {
    const hits = matchLore([entry({ keys: ['tavern'], enabled: false })], ['the tavern'], base);
    expect(hits).toHaveLength(0);
  });

  test('only scans the last `scanDepth` messages', () => {
    const entries = [entry({ keys: ['tavern'] })];
    // Mentioned three messages back; depth 2 means it is out of range.
    expect(matchLore(entries, ['the tavern', 'later', 'now'], { ...base, scanDepth: 2 })).toHaveLength(0);
    expect(matchLore(entries, ['the tavern', 'later', 'now'], { ...base, scanDepth: 3 })).toHaveLength(1);
  });

  test('honours whole-word matching without a regex', () => {
    const entries = [entry({ keys: ['inn'], matchWholeWords: true })];
    // "inn" inside "beginning" must not fire.
    expect(matchLore(entries, ['the beginning of it'], base)).toHaveLength(0);
    expect(matchLore(entries, ['the inn was warm'], base)).toHaveLength(1);
  });

  test('is case-insensitive unless the entry says otherwise', () => {
    const loose = [entry({ keys: ['Tavern'] })];
    expect(matchLore(loose, ['the tavern'], base)).toHaveLength(1);
    const strict = [entry({ keys: ['Tavern'], caseSensitive: true })];
    expect(matchLore(strict, ['the tavern'], base)).toHaveLength(0);
    expect(matchLore(strict, ['the Tavern'], base)).toHaveLength(1);
  });

  test('stops adding entries once the token budget is spent', () => {
    const entries = [
      entry({ id: 'a', keys: ['x'], content: 'aaaa', insertionOrder: 0 }),
      entry({ id: 'b', keys: ['x'], content: 'bbbb', insertionOrder: 1 }),
      entry({ id: 'c', keys: ['x'], content: 'cccc', insertionOrder: 2 }),
    ];
    const hits = matchLore(entries, ['x'], { ...base, tokenBudget: 8 });
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
  });

  test('orders deterministically by insertion order, then id', () => {
    const entries = [
      entry({ id: 'z', keys: ['x'], insertionOrder: 1 }),
      entry({ id: 'a', keys: ['x'], insertionOrder: 1 }),
      entry({ id: 'm', keys: ['x'], insertionOrder: 0 }),
    ];
    const hits = matchLore(entries, ['x'], base);
    expect(hits.map((h) => h.id)).toEqual(['m', 'a', 'z']);
  });
});

describe('matchLore: selective logic', () => {
  const selective = (logic: number) =>
    entry({ keys: ['tavern'], secondaryKeys: ['rain', 'night'], selectiveLogic: logic });

  test('AND_ANY (0) needs one secondary', () => {
    expect(matchLore([selective(0)], ['tavern rain'], base)).toHaveLength(1);
    expect(matchLore([selective(0)], ['tavern'], base)).toHaveLength(0);
  });

  test('NOT_ALL (1) needs at least one secondary missing', () => {
    expect(matchLore([selective(1)], ['tavern rain'], base)).toHaveLength(1);
    expect(matchLore([selective(1)], ['tavern rain night'], base)).toHaveLength(0);
  });

  test('NOT_ANY (2) needs no secondary present', () => {
    expect(matchLore([selective(2)], ['tavern'], base)).toHaveLength(1);
    expect(matchLore([selective(2)], ['tavern rain'], base)).toHaveLength(0);
  });

  test('AND_ALL (3) needs every secondary', () => {
    expect(matchLore([selective(3)], ['tavern rain night'], base)).toHaveLength(1);
    expect(matchLore([selective(3)], ['tavern rain'], base)).toHaveLength(0);
  });

  test('a primary miss beats any secondary', () => {
    expect(matchLore([selective(0)], ['rain'], base)).toHaveLength(0);
  });
});

describe('matchLore: probability and recursion', () => {
  test('probability 100 always fires and 0 never does', () => {
    const always = [entry({ keys: ['x'], probability: 100 })];
    expect(matchLore(always, ['x'], { ...base, random: () => 0.999 })).toHaveLength(1);
    const never = [entry({ keys: ['x'], probability: 0 })];
    expect(matchLore(never, ['x'], { ...base, random: () => 0 })).toHaveLength(0);
  });

  test('an entry with no probability always fires', () => {
    expect(matchLore([entry({ keys: ['x'] })], ['x'], { ...base, random: () => 0.999 })).toHaveLength(1);
  });

  test('recursive scanning lets a fired entry trigger another', () => {
    const entries = [
      entry({ id: 'a', keys: ['tavern'], content: 'The innkeeper is named Bela.' }),
      entry({ id: 'b', keys: ['Bela'], content: 'Bela owes Ada a debt.' }),
    ];
    expect(matchLore(entries, ['the tavern'], { ...base, recursive: false }).map((h) => h.id)).toEqual(['a']);
    expect(matchLore(entries, ['the tavern'], { ...base, recursive: true }).map((h) => h.id)).toEqual(['a', 'b']);
  });

  test('recursion terminates rather than looping on a cycle', () => {
    const entries = [
      entry({ id: 'a', keys: ['one'], content: 'mentions two' }),
      entry({ id: 'b', keys: ['two'], content: 'mentions one' }),
    ];
    const hits = matchLore(entries, ['one'], { ...base, recursive: true });
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b']);
  });
});

describe('alwaysOnLore', () => {
  test('takes constants only, and de-duplicates ids', () => {
    const lore = alwaysOnLore([
      entry({ id: 'x', constant: true, content: 'one' }),
      entry({ id: 'x', constant: true, content: 'two' }),
      entry({ id: 'y', constant: false, content: 'three' }),
    ]);
    expect(lore.map((l) => l.id)).toEqual(['x', 'x#1']);
    expect(lore).toHaveLength(2);
  });
});
