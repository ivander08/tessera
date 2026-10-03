import { describe, expect, test } from 'bun:test';
import { renderMemoryBlock } from './memoryBlock';
import type { RecallHit } from '../memoryTypes';

const count = (text: string): number => text.length; // 1 char ≈ 1 token keeps budgets legible

function hit(kind: RecallHit['kind'], text: string, score = 0): RecallHit {
  return { kind, refId: `${kind}:${text}`, text, score };
}

describe('renderMemoryBlock', () => {
  test('renders nothing when there is nothing to render', () => {
    expect(renderMemoryBlock({ summaries: [], facts: [], recalled: [] }, 800, count)).toBe('');
  });

  test('renders everything when it fits', () => {
    const block = renderMemoryBlock(
      {
        summaries: [hit('summary', 'Scene one happened.')],
        facts: [hit('fact', 'Ivan owns the brass key.')],
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
        recalled: [],
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
        recalled: [],
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
        recalled: [],
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
        recalled: [hit('message', 'A long earlier moment line.')],
      },
      55,
      count,
    );
    expect(block).not.toContain('A long summary line');
    expect(block).toContain('- A long earlier moment line.');
  });
});
