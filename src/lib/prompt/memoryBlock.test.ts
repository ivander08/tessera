import { describe, expect, test } from 'bun:test';
import { renderMemoryBlock } from './memoryBlock';
import type { RecallHit } from '../memoryTypes';

const count = (text: string): number => text.length; // 1 char ≈ 1 token keeps budgets legible

function hit(kind: RecallHit['kind'], text: string, score = 0, at?: string | null): RecallHit {
  return { kind, refId: `${kind}:${text}`, text, score, at };
}

describe('renderMemoryBlock — in-world dates', () => {
  test('a dated fact and event carry their date, and an undated one does not invent one', () => {
    // The date leads, because "when" is the question this answers. An absent date renders
    // as the bare text rather than as "(no date)": writing it out would put a second,
    // negative claim in the prompt.
    const block = renderMemoryBlock(
      {
        summaries: [],
        facts: [hit('fact', 'Ivan owns the brass key.', 0, 'Tuesday, 14 April 2026, 20:00')],
        events: [
          hit('event', 'They met at the docks.', 0, 'Tuesday, 14 April 2026, 20:00'),
          hit('event', 'Nobody remembers this one.', 0, null),
        ],
        recalled: [],
      },
      4000,
      count,
    );

    expect(block).toContain('- [Tuesday, 14 April 2026, 20:00] Ivan owns the brass key.');
    expect(block).toContain('What happened:');
    expect(block).toContain('- [Tuesday, 14 April 2026, 20:00] They met at the docks.');
    expect(block).toContain('- Nobody remembers this one.');
    expect(block).not.toContain('no date');
  });

  test('a dated summary carries its span', () => {
    const block = renderMemoryBlock(
      {
        summaries: [hit('summary', 'They argued about the maps.', 0, '14 April 2026 – 15 April 2026')],
        facts: [],
        events: [],
        recalled: [],
      },
      4000,
      count,
    );

    expect(block).toContain('- [14 April 2026 – 15 April 2026] They argued about the maps.');
  });

  test('events are sacrificed before facts when the budget is tight', () => {
    // A fact is standing state the narrator writes against; an event is history it can often
    // reconstruct from the transcript still in front of it. So the fact survives.
    const block = renderMemoryBlock(
      {
        summaries: [],
        facts: [hit('fact', 'FACT-KEEP')],
        events: [hit('event', 'EVENT-DROP')],
        recalled: [],
      },
      // Exactly the length of the facts section, so the events section cannot fit.
      'Established facts:\n- FACT-KEEP'.length,
      count,
    );

    expect(block).toContain('FACT-KEEP');
    expect(block).not.toContain('EVENT-DROP');
  });
});

describe('renderMemoryBlock', () => {
  test('renders nothing when there is nothing to render', () => {
    expect(renderMemoryBlock({ summaries: [], facts: [], events: [], recalled: [] }, 800, count)).toBe('');
  });

  test('renders everything when it fits', () => {
    const block = renderMemoryBlock(
      {
        summaries: [hit('summary', 'Scene one happened.')],
        facts: [hit('fact', 'Ivan owns the brass key.')],
        events: [],
        recalled: [hit('message', 'I found the key under the floorboard.')],
      },
      800,
      count,
    );
    expect(block).toContain('Story so far:');
    expect(block).toContain('- Scene one happened.');
    expect(block).toContain('Established facts:');
    expect(block).toContain('- Ivan owns the brass key.');
    expect(block).toContain('Relevant earlier moments:');
    expect(block).toContain('- I found the key under the floorboard.');
  });

  test('over budget: summaries sacrifice before facts', () => {
    const block = renderMemoryBlock(
      {
        summaries: [hit('summary', 'A very long summary line that should be dropped first.')],
        facts: [hit('fact', 'Ivan owns the brass key.')],
        events: [], recalled: [],
      },
      80,
      count,
    );
    expect(block).not.toContain('A very long summary line');
    expect(block).toContain('- Ivan owns the brass key.');
  });

  test('over budget: recalled messages sacrifice before facts', () => {
    const block = renderMemoryBlock(
      {
        summaries: [],
        facts: [hit('fact', 'Ivan owns the brass key.')],
        events: [],
        recalled: [hit('message', 'A very long earlier moment that should be dropped first.')],
      },
      80,
      count,
    );
    expect(block).not.toContain('A very long earlier moment');
    expect(block).toContain('- Ivan owns the brass key.');
  });

  test('over budget: facts survive to the last line the budget allows, best first', () => {
    const block = renderMemoryBlock(
      {
        summaries: [],
        facts: [
          hit('fact', 'Ivan owns the brass key.'),
          hit('fact', 'The clasp is broken.'),
        ],
        events: [], recalled: [],
      },
      60,
      count,
    );
    expect(block).toContain('- Ivan owns the brass key.');
    expect(block).not.toContain('The clasp is broken.');
  });

  test('over budget: the oldest summary line dies first, the newest survives', () => {
    // Newest-first input order is what the caller guarantees (`ORDER BY covers_to DESC`).
    const block = renderMemoryBlock(
      {
        summaries: [hit('summary', 'Newest scene, survives.'), hit('summary', 'Oldest scene, dies first.')],
        facts: [],
        events: [], recalled: [],
      },
      55,
      count,
    );
    expect(block).not.toContain('Oldest scene, dies first.');
    expect(block).toContain('- Newest scene, survives.');
  });

  test('over budget: summaries sacrifice before recalled messages', () => {
    const block = renderMemoryBlock(
      {
        summaries: [hit('summary', 'A long summary line that goes before any recall.')],
        facts: [],
        events: [],
        recalled: [hit('message', 'A long earlier moment line.')],
      },
      55,
      count,
    );
    expect(block).not.toContain('A long summary line');
    expect(block).toContain('- A long earlier moment line.');
  });
});
