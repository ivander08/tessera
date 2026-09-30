import type { AssembleInput } from './input';
import { sha256Hex } from './sha256';
import { stableStringify } from './stable';
import type { AssembledPrompt, WireMessage } from './types';

/**
 * Token counting is injected rather than imported. The exact tokenizer carries a
 * 2.3 MB vocabulary that cannot ship to a Worker (it exceeds the startup CPU budget
 * and fails deployment), while the browser wants the exact count. Passing the counter
 * in keeps `assemble` free of either choice and keeps the vocabulary out of the
 * Worker bundle entirely.
 */
export type TokenCounter = (messages: WireMessage[]) => number;

/**
 * The head is emitted once and never changes for the life of a chat.
 *
 * Emission order is fixed and MUST NOT vary:
 *   1. system      — systemPrompt
 *   2. system      — character block (name, description, personality, scenario)
 *   3. system      — mesExample, if non-empty
 *   4. system      — persona block, if present
 *   5. system...   — one per lorebook entry, sorted by id
 *   6. history     — verbatim, oldest first
 *   ---- tailStart ----
 *   7. system      — memoryBlock, if present      (M4)
 *   8. system      — stateBlock, if present       (M5)
 *   9. system      — loreBlock, if present        (keyword lorebook)
 *   9. system      — authorsNote, if present
 *  10. user        — userMessage
 *
 * Everything before `tailStart` is the cacheable prefix. Providers cache from
 * position 0 only, so the prefix must be byte-identical between turns N and N+1.
 */
export function assemble(input: AssembleInput, countChatTokens: TokenCounter): AssembledPrompt {
  const head: WireMessage[] = [];

  pushIfNonEmpty(head, 'system', input.systemPrompt);
  pushIfNonEmpty(head, 'system', renderCharacter(input.character));
  pushIfNonEmpty(head, 'system', input.character.mesExample);
  if (input.persona) pushIfNonEmpty(head, 'system', renderPersona(input.persona));

  // Sorted by id, never by insertion order: lorebook loading order must not be able
  // to perturb the prefix.
  const lorebook = [...input.lorebook].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const entry of lorebook) pushIfNonEmpty(head, 'system', entry.content);

  const body: WireMessage[] = input.history.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const tail: WireMessage[] = [];
  pushIfNonEmpty(tail, 'system', input.tail.memoryBlock);
  pushIfNonEmpty(tail, 'system', input.tail.stateBlock);
  // Before the lore block: who is in the scene is the more immediate fact, and the cast
  // is what the script form is written against.
  pushIfNonEmpty(tail, 'system', input.tail.castBlock);
  pushIfNonEmpty(tail, 'system', input.tail.loreBlock);
  pushIfNonEmpty(tail, 'system', input.tail.authorsNote);
  pushIfNonEmpty(tail, 'system', input.tail.postHistoryInstructions);
  // The mode's instruction, when the turn is not an ordinary reply. A system line rather
  // than a user one: it is the operator telling the model what this call is, not the
  // reader saying something.
  pushIfNonEmpty(tail, 'system', input.tail.instruction);
  // Omitted rather than pushed empty. `continue` has no user text — the last thing in
  // the conversation is the assistant turn being carried forward — and an empty user
  // message is rejected outright by some providers and read as a blank prompt by others.
  pushIfNonEmpty(tail, 'user', input.tail.userMessage);

  const messages = [...head, ...body, ...tail];
  const tailStart = head.length + body.length;

  return {
    messages,
    tailStart,
    prefixHash: sha256Hex(stableStringify(messages.slice(0, tailStart))),
    headTokens: countChatTokens(head),
    bodyTokens: countChatTokens(body),
    tailTokens: countChatTokens(tail),
  };
}

/** Empty segments are omitted rather than emitted as bare labels: cheaper, and still deterministic. */
function pushIfNonEmpty(
  target: WireMessage[],
  role: WireMessage['role'],
  content: string | undefined,
): void {
  if (!content) return;
  target.push({ role, content });
}

function renderCharacter(character: AssembleInput['character']): string {
  const lines: string[] = [];
  if (character.name.length > 0) lines.push(`Name: ${character.name}`);
  if (character.description.length > 0) lines.push(`Description: ${character.description}`);
  if (character.personality.length > 0) lines.push(`Personality: ${character.personality}`);
  if (character.scenario.length > 0) lines.push(`Scenario: ${character.scenario}`);
  return lines.join('\n');
}

function renderPersona(persona: { name: string; description: string }): string {
  const lines: string[] = [];
  if (persona.name.length > 0) lines.push(`Name: ${persona.name}`);
  if (persona.description.length > 0) lines.push(`Description: ${persona.description}`);
  return lines.join('\n');
}
