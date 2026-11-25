import { complete } from '../cheap';
import { loadEffectiveSettings } from '../effective';
import { loadSceneSetup } from '../scene';
import { addProseAlternative } from '../messages';
import {
  detectViolations,
  preservesDialogue,
  type GuardViolation,
} from '../../../src/lib/prose/guard';
import type { Craft } from '../../../src/lib/scene/setup';

/**
 * The prose guard's repair pass.
 *
 * The prompt is assembled against the reply, not against the preset's whole instruction
 * stack. The model already read the rules when it wrote the reply; repeating them here
 * gives it a second document to average with the first, which is the failure the tail
 * blocks exist to avoid. What it gets instead is the voice block, the specific violations
 * on THIS reply, and one hard contract: narration changes, dialogue does not.
 */

/**
 * Paragraph ceilings by length setting. Slack on purpose: a compliant five-paragraph
 * reply that runs to six is not the failure the reader is reporting; a twelve-paragraph
 * reply under a "three to five" setting is.
 */
const PARAGRAPH_CEILING: Record<Craft['responseLength'], number | null> = {
  off: null,
  reallyShort: 3,
  short: 6,
  medium: 10,
  long: 16,
  noLimit: null,
  adaptiveShort: 7,
  adaptiveMedium: 10,
  adaptiveLong: 14,
};

export interface RepairOptions {
  /** The button asks for the corrected version, so it becomes the visible one. */
  activate: boolean;
}

export interface RepairResult {
  violations: GuardViolation[];
  /** The new swipe row, when one was written. */
  id?: string;
  repaired?: string;
}

interface TargetRow {
  seq: number;
  role: string;
  content: string;
}

/**
 * The voice the repair is aiming at.
 *
 * The preset's `### NARRATION VOICE` section is the contract, and its `### VOICE SAMPLE`
 * is the shape. If the reader has written a sample for this chat, that one wins: it is the
 * most specific statement of what they want, and it is the only part of the prompt they
 * can change without editing a preset that other chats share.
 */
function voiceOf(postHistory: string, sample: string): string {
  const marker = '### NARRATION VOICE';
  const at = postHistory.indexOf(marker);
  const block = at >= 0 ? postHistory.slice(at) : postHistory;
  const trimmed =
    block.trim().slice(0, 6000) ||
    'A third-person narrator with a distinct voice: concrete, specific, and never a camera.';
  const readerSample = sample.trim().slice(0, 2400);
  if (readerSample.length === 0) return trimmed;
  return `${trimmed}\n\n<reader_sample>\n${readerSample}\n</reader_sample>`;
}

function systemPrompt(voice: string, violations: GuardViolation[]): string {
  const list = violations.map((violation) => `- ${violation.detail}`).join('\n');
  return `You are correcting the prose of one roleplay reply. Rewrite ONLY the narration.

The voice this chat is written in:
${voice}

The detector found these problems in the reply:
${list}

Rules:
- Preserve every quoted line of dialogue exactly, in the same order. Preserve every phone message and every backticked line. They are not yours to edit.
- Preserve every event, action, and fact. Do not add plot, do not remove plot, do not invent a new beat.
- Change only the narration: the sentences between and around the dialogue.
- Fix the listed problems. Do not replace one stock beat with another from the same family.
- Do not open on the previous reply's opening. Vary the first sentence.
- Keep the paragraph count within one of the original unless a violation is the paragraph count itself.
- Output only the corrected reply. No preamble, no notes, no code fence, no explanation.`;
}

/**
 * Repairs one assistant reply.
 *
 * Returns the violations even when no repair was written, so the button can say "nothing
 * found" instead of failing silently. A repair that would change the dialogue, come back
 * empty, or fix nothing is rejected and reported as an error — the original is the only
 * thing on screen, and a second bad version is worse than the first.
 */
export async function repairReply(
  env: Env,
  chatId: string,
  messageId: string,
  options: RepairOptions,
): Promise<RepairResult> {
  const setup = await loadSceneSetup(env, chatId);
  if (setup.proseGuard === 'off') {
    throw new Error('prose guard is off for this chat');
  }

  const target = await env.DB.prepare(
    `SELECT seq, role, content FROM messages
      WHERE id = ? AND chat_id = ? AND deleted = 0`,
  )
    .bind(messageId, chatId)
    .first<TargetRow>();
  if (!target) throw new Error('message not found');
  if (target.role !== 'assistant') throw new Error('only an assistant reply can be corrected');
  if (target.content.trim().length === 0) throw new Error('the reply is empty');

  const { results: previousRows } = await env.DB.prepare(
    `SELECT content FROM messages
      WHERE chat_id = ? AND role = 'assistant' AND deleted = 0 AND active = 1 AND seq < ?
      ORDER BY seq DESC LIMIT 3`,
  )
    .bind(chatId, target.seq)
    .all<{ content: string }>();
  const previous = previousRows.map((row) => row.content);

  const violations = detectViolations(target.content, {
    bans: setup.proseBans,
    previous,
    maxParagraphs: PARAGRAPH_CEILING[setup.craft.responseLength] ?? null,
  });
  if (violations.length === 0) return { violations: [] };

  const chat = await env.DB.prepare('SELECT preset_id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ preset_id: string | null }>();
  const settings = await loadEffectiveSettings(env, chat?.preset_id ?? null);
  const voice = voiceOf(settings.presetPostHistory, setup.proseSample);
  const user = `Previous reply, for voice and to avoid its opening:\n${
    previous[0]?.trim().slice(0, 1600) ?? '(none)'
  }\n\nReply to correct:\n${target.content}`;

  const result = await complete(env, {
    system: systemPrompt(voice, violations),
    user,
    // A reply is ~300-900 tokens; 3500 leaves room for the correction plus the
    // side-channel's own thinking without inviting a rewrite of the whole scene.
    maxTokens: 3500,
    settings,
  });

  const repaired = result.text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (repaired.length === 0) throw new Error('the repair came back empty');
  if (repaired === target.content.trim()) throw new Error('the repair did not change anything');
  // A floor, not only a ratio. A short reply (a line and a beat) legitimately corrects
  // into a paragraph, and a bare 2.5x rule rejected that as expansion. The ratio still
  // catches a model that turns one reply into a scene.
  if (repaired.length > Math.max(target.content.length * 2.5, 600)) {
    throw new Error('the repair expanded the reply too far to be a correction');
  }
  if (!preservesDialogue(target.content, repaired)) {
    throw new Error('the repair changed the dialogue; it was not applied');
  }

  const after = detectViolations(repaired, {
    bans: setup.proseBans,
    previous,
    maxParagraphs: PARAGRAPH_CEILING[setup.craft.responseLength] ?? null,
  });
  if (after.length >= violations.length) {
    throw new Error(
      `the repair left ${after.length} of ${violations.length} problems; it was not applied`,
    );
  }

  const id = await addProseAlternative(env, chatId, messageId, repaired, options.activate);
  return { violations, id, repaired };
}

/**
 * The auto pass. Runs after a turn, behind `waitUntil`.
 *
 * A correction that arrives after the reader has started replying is a version they did
 * not ask for; it is added inactive, so the transcript's swipe count changes and the text
 * on screen does not. The client schedules one delayed refetch for chats in this mode.
 */
export async function maybeGuardProse(
  env: Env,
  chatId: string,
  messageId: string,
): Promise<void> {
  const setup = await loadSceneSetup(env, chatId);
  if (setup.proseGuard !== 'auto') return;
  try {
    await repairReply(env, chatId, messageId, { activate: false });
  } catch (error) {
    // Auto is an enhancement. A failed repair must never look like a failed turn.
    console.warn(
      `[prose] auto repair failed for chat=${chatId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
