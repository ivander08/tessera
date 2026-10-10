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
  events: RecallHit[];
  recalled: RecallHit[];
}

/**
 * A memory line, with the in-world date it happened or became true.
 *
 * The date leads, because the question this answers is "when" and a date buried at the end
 * of a long summary is one the narrator has to hunt for. A hit with no recorded date renders
 * as the bare text rather than as "(no date)": absence of a date is not a fact about the
 * world, and writing it out would put a second, negative claim in the prompt.
 */
function withDate(hit: RecallHit): string {
  const at = (hit.at ?? '').trim();
  const text = hit.text.trim();
  return at.length > 0 ? `[${at}] ${text}` : text;
}

export function renderMemoryBlock(
  input: MemoryBlockInput,
  maxTokens: number,
  count: (text: string) => number,
): string {
  const sections: Array<{ heading: string; lines: string[] }> = [];

  const summaryLines = input.summaries.map((hit) => `- ${withDate(hit)}`);
  if (summaryLines.length > 0) sections.push({ heading: 'Story so far', lines: summaryLines });

  const factLines = input.facts.map((hit) => `- ${withDate(hit)}`);
  if (factLines.length > 0) sections.push({ heading: 'Established facts', lines: factLines });

  // Events lead the recalled material rather than trailing it. A reader asking "when did I
  // first meet Sydney" is asking for an event, and events are the only hits that carry a
  // date the narrator can quote back. They sit after the facts because facts are the
  // standing state of the world and events are its history.
  const eventLines = input.events.map((hit) => `- ${withDate(hit)}`);
  if (eventLines.length > 0) sections.push({ heading: 'What happened', lines: eventLines });

  const recallLines = input.recalled.map((hit) => `- ${hit.text.trim()}`);
  if (recallLines.length > 0) sections.push({ heading: 'Relevant earlier moments', lines: recallLines });

  if (sections.length === 0) return '';

  // Drop whole lines from the least critical section until the block fits. Truncating
  // mid-sentence would hand the model a half-fact, which is worse than omitting it.
  //
  // "Least critical" is NOT the reverse of compose order — compose order alone gets it
  // backwards: summaries are first in the block but they are re-derivable from the
  // original messages any time, and a recalled message is raw transcript the reader can
  // scroll to — while a fact is a distilled statement that exists only here. Sacrificing
  // by position evicted every fact whenever the summaries alone filled the budget, and
  // the model then answered questions about remembered specifics with confident
  // inventions (measured on a 240-message soak chat: recall returned the fact top-ranked,
  // the rendered block contained no facts at all, and the narrator denied remembering).
  // So the sacrifice order is explicit, independent of compose order: summary lines
  // first, recalled messages second, events third, facts last. Within a section the END of
  // the list goes first, which is also correct: summaries arrive newest-first, so the oldest
  // scene dies first, and bm25-ranked hits arrive best-first, so the weakest match dies
  // first.
  //
  // Events go before facts because a fact is standing state that the narrator writes
  // against, while an event is history the narrator can often reconstruct from the
  // transcript it can still see — the same argument that puts recalled messages above
  // facts, applied one step further out.
  const byHeading = new Map(sections.map((section) => [section.heading, section]));
  const sacrificeOrder = [
    'Story so far',
    'Relevant earlier moments',
    'What happened',
    'Established facts',
  ];

  let text = compose(sections);
  while (count(text) > maxTokens) {
    const section = sacrificeOrder
      .map((heading) => byHeading.get(heading))
      .find((candidate) => candidate !== undefined && candidate.lines.length > 0);
    if (!section) break;
    section.lines.pop();
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
