import { describe, expect, test } from 'bun:test';
import { forkCard } from './fork';
import type { CharacterCardJson } from './types';

function card(overrides: Partial<CharacterCardJson> = {}): CharacterCardJson {
  return {
    name: 'Ada',
    description: 'A cartographer.',
    personality: 'Dry.',
    scenario: 'A tavern.',
    firstMes: 'You are late.',
    mesExample: '<START>\n{{user}}: hi\n{{char}}: hello',
    systemPrompt: 'Stay in character.',
    postHistoryInstructions: 'Never break character.',
    alternateGreetings: ['A second opening.', 'A third opening.'],
    creatorNotes: 'Made for a test.',
    tags: ['cartographer', 'tavern'],
    characterBook: {
      entries: [
        { id: 0, keys: ['tavern'], content: 'The Compass Rose.', extensions: { depth: 4 } },
      ],
    },
    ...overrides,
  };
}

describe('forkCard', () => {
  test('renames the copy and leaves the source name alone', () => {
    const original = card();
    const forked = forkCard(original, { name: 'Ada II' });
    expect(forked.name).toBe('Ada II');
    expect(original.name).toBe('Ada');
  });

  test('keeps every other field, so a fork is the same character under a new name', () => {
    const original = card();
    const forked = forkCard(original, { name: 'Ada II' });
    const { name: _forkName, ...forkRest } = forked;
    const { name: _srcName, ...sourceRest } = original;
    expect(forkRest).toEqual(sourceRest);
  });

  test('does not mutate the input', () => {
    const original = card();
    const snapshot = structuredClone(original);
    forkCard(original, { name: 'Ada II' });
    expect(original).toEqual(snapshot);
  });

  test('shares no nested object with the source: editing the fork cannot edit the original', () => {
    const original = card();
    const forked = forkCard(original, { name: 'Ada II' });

    const sourceBook = original.characterBook as { entries: Array<{ content: string }> };
    const forkBook = forked.characterBook as { entries: Array<{ content: string }> };
    forkBook.entries[0].content = 'The Rusty Anchor.';

    expect(sourceBook.entries[0].content).toBe('The Compass Rose.');
  });

  test('shares no array with the source either', () => {
    const original = card();
    const forked = forkCard(original, { name: 'Ada II' });

    forked.alternateGreetings.push('A fourth opening.');
    forked.tags[0] = 'changed';

    expect(original.alternateGreetings).toEqual(['A second opening.', 'A third opening.']);
    expect(original.tags).toEqual(['cartographer', 'tavern']);
  });

  test('survives a card with no character book', () => {
    const original = card({ characterBook: null });
    const forked = forkCard(original, { name: 'Ada II' });
    expect(forked.characterBook).toBeNull();
    expect(forked.name).toBe('Ada II');
  });
});
