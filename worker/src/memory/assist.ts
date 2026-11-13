import { settingsForChat } from './settings';
import { complete } from '../cheap';
import { loadPathTail } from '../branch';

/**
 * The memory box's AI helper.
 *
 * The box is the reader's own text, and this is the one place the engine touches it: on
 * request, it can tidy, compact, or extend those notes. Nothing here is applied
 * automatically — the caller shows the result in the textarea and the reader decides.
 *
 * That rule is why the function returns text rather than writing anything. The automatic
 * memory engine got its reputation by recording things nobody asked it to record; a helper
 * that edited the box behind the reader would repeat the mistake in a smaller place.
 */

export type AssistAction = 'tidy' | 'compact' | 'expand';

export interface AssistRequest {
  text: string;
  action: AssistAction | 'custom';
  /** The reader's own instruction, when `action` is `custom`. */
  instruction?: string;
}

const SYSTEM = [
  "You maintain a reader's memory notes for a roleplay scene. The notes are given to the",
  'narrator as one block, so they are read literally: every line should be something the',
  'narrator can act on.',
  '',
  'Return ONLY the rewritten notes. No preamble, no explanation, no code fence, no quotes',
  'around the result. Keep the reader\'s voice and their facts; you are editing their notes,',
  'not writing your own.',
].join('\n');

const ACTION_RULES: Record<AssistAction, string> = {
  tidy: [
    'TASK: reorganise the notes so they are easy to read at a glance.',
    '- Short lines. One fact per line. Bullets are fine.',
    '- Group related lines under plain headings when there are enough of them.',
    '- Do NOT add, remove, or change any fact. Same information, better arrangement.',
  ].join('\n'),
  compact: [
    'TASK: shorten the notes without losing anything that still matters.',
    '- Keep names, dates, decisions, promises, injuries, and anything a later scene could contradict.',
    '- Drop repetition, scene-setting prose, and details that no longer apply.',
    '- Aim for noticeably shorter; do not pad to keep length.',
  ].join('\n'),
  expand: [
    'TASK: add what the recent transcript establishes that the notes are missing.',
    '- Only add things the transcript states or clearly implies.',
    '- Keep every existing line that is still true.',
    '- If nothing is missing, return the notes unchanged.',
  ].join('\n'),
};

/**
 * Rewrites the box.
 *
 * The transcript is attached only when the task needs it (`expand`, and any custom
 * instruction — a reader asking "add what happened at the party" is asking about the
 * scene). `tidy` and `compact` are edits of the text itself and must not be able to
 * import new claims from the transcript, which would make "just reformat this" quietly
 * change what the narrator believes.
 */
export async function assistMemory(
  env: Env,
  chatId: string,
  request: AssistRequest,
): Promise<string> {
  const notes = request.text.trim();
  const task =
    request.action === 'custom'
      ? `TASK: ${request.instruction?.trim().slice(0, 600) || 'improve these notes.'}`
      : ACTION_RULES[request.action];

  const parts = [`The notes as they are now:`, notes.length > 0 ? notes : '(empty)', '', task];

  if (request.action !== 'tidy' && request.action !== 'compact') {
    const rows = await loadPathTail(env, chatId, 24);
    if (rows.length > 0) {
      parts.push(
        '',
        'Recent transcript, oldest first:',
        ...rows.map((row) => `${row.role}: ${row.content.trim()}`),
      );
    }
  }

  const reply = await complete(env, {
    settings: await settingsForChat(env, chatId),
    system: SYSTEM,
    user: parts.join('\n'),
    maxTokens: 1400,
  });

  return unwrap(reply.text);
}

/** Strips a fence and surrounding quotes a model adds despite being told not to. */
function unwrap(text: string): string {
  let out = text.trim();
  const fenced = /^```(?:[a-z]*)?\s*\n?([\s\S]*?)\n?```$/i.exec(out);
  if (fenced) out = fenced[1].trim();
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) out = out.slice(1, -1);
  return out;
}
