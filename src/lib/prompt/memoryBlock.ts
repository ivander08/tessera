import type { RecallHit } from '../memoryTypes';

/**
 * Renders recalled memory into a prompt block.
 *
 * This block goes in the TAIL, never the head. Recalled content changes as the
 * conversation moves — a keyword firing on turn 12 must not rewrite the prefix that
 * turns 1-11 already cached. The whole point of `assemble`'s tail is that volatile
 * segments live after `tailStart`.
 */
export interface MemoryBlockInput {
  summaries: RecallHit[];
  facts: RecallHit[];
  recalled: RecallHit[];
}

export function renderMemoryBlock(
  input: MemoryBlockInput,
  maxTokens: number,
  count: (text: string) => number,
): string {
  const sections: Array<{ heading: string; lines: string[] }> = [];

  const summaryLines = input.summaries.map((hit) => `- ${hit.text.trim()}`);
  if (summaryLines.length > 0) sections.push({ heading: 'Story so far', lines: summaryLines });

  const factLines = input.facts.map((hit) => `- ${hit.text.trim()}`);
  if (factLines.length > 0) sections.push({ heading: 'Established facts', lines: factLines });

  const recallLines = input.recalled.map((hit) => `- ${hit.text.trim()}`);
  if (recallLines.length > 0) sections.push({ heading: 'Relevant earlier moments', lines: recallLines });

  if (sections.length === 0) return '';

  // Drop whole lines from the end of the least critical section until the block fits.
  // Truncating mid-sentence would hand the model a half-fact, which is worse than
  // omitting it.
  let text = compose(sections);
  while (count(text) > maxTokens) {
    const section = sections[sections.length - 1];
    if (section.lines.length > 1) {
      section.lines.pop();
    } else if (sections.length > 1) {
      sections.pop();
    } else {
      sections[0].lines = [];
      break;
    }
    text = compose(sections);
  }

  return compose(sections.filter((section) => section.lines.length > 0));
}

function compose(sections: Array<{ heading: string; lines: string[] }>): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section.lines.length === 0) continue;
    parts.push(`${section.heading}:\n${section.lines.join('\n')}`);
  }
  return parts.join('\n\n');
}
