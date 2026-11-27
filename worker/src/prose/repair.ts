import { complete } from '../cheap';
import { loadEffectiveSettings } from '../effective';
import { loadSceneSetup } from '../scene';
import { addProseAlternative } from '../messages';
import {
  detectViolations,
  preservesDialogue,
  type GuardViolation,
} from '../../../src/lib/prose/guard';
import type { Craft, SceneSetup } from '../../../src/lib/scene/setup';
import { claimProse, clearProseStatus, setProseStatus } from './state';

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
 * Paragraph ceilings by length setting.
 *
 * This is the setting's own stated maximum, matching `LENGTH_LINE` in `craftBlock` and the
 * panel's description — not a slackened one. The old table allowed three paragraphs under
 * "at most two" and six under "three to five", so a reply could be visibly over the setting
 * and still report clean. The adaptive modes use their climax maximum.
 */
const PARAGRAPH_CEILING: Record<Craft['responseLength'], number | null> = {
  off: null,
  reallyShort: 2,
  short: 5,
  medium: 9,
  long: 15,
  noLimit: null,
  adaptiveShort: 8,
  adaptiveMedium: 12,
  adaptiveLong: 18,
};

export interface RepairOptions {
  /** The button asks for the corrected version, so it becomes the visible one. */
  activate: boolean;
  /**
   * A manual rewrite of a reply the detector found nothing wrong with. The reader marked
   * it flat; the repair aims at the voice instead of at a violation list.
   */
  polish?: boolean;
}

export interface RepairResult {
  violations: GuardViolation[];
  /** The new swipe row, when one was written. */
  id?: string;
  repaired?: string;
  /**
   * The reply changed while the repair was running, so the result was thrown away. Not a
   * failure of the reader's text and not a fixed version: the status is cleared instead.
   */
  discarded?: boolean;
}

interface TargetRow {
  id: string;
  seq: number;
  role: string;
  content: string;
}

/**
 * Everything the repair needs to know about the reply before it writes a prompt.
 *
 * Split out of `repairReply` so the turn can inspect a reply ONCE — before `done`, to
 * persist `clean`/`issues`/`queued` — and hand the same answer to the repair. Re-running
 * detection inside the repair would read the same rows twice and could disagree with the
 * status the reader was just shown.
 */
export interface Inspection {
  setup: SceneSetup;
  target: TargetRow;
  previous: string[];
  violations: GuardViolation[];
}

export async function inspectReply(
  env: Env,
  chatId: string,
  messageId: string,
): Promise<Inspection> {
  const setup = await loadSceneSetup(env, chatId);

  const target = await env.DB.prepare(
    `SELECT id, seq, role, content FROM messages
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

  return { setup, target, previous, violations };
}

/** Whether the reply still holds the text the inspection was made against. */
async function stillHasContent(
  env: Env,
  chatId: string,
  messageId: string,
  content: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT content FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0`,
  )
    .bind(messageId, chatId)
    .first<{ content: string }>();
  return row !== null && row.content.trim() === content.trim();
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

function systemPrompt(voice: string, violations: GuardViolation[], polish: boolean): string {
  const list = violations.map((violation) => `- ${violation.detail}`).join('\n');
  const problem = polish
    ? `The reader marked this reply as flat. No specific tic was named: make the narration more concrete, more specific, and more clearly in this voice without changing what happens.`
    : `The detector found these problems in the reply:\n${list}`;
  return `You are correcting the prose of one roleplay reply. Rewrite ONLY the narration.

The voice this chat is written in:
${voice}

${problem}

Rules:
- Preserve every quoted line of dialogue exactly, in the same order. Preserve every phone message and every backticked line. They are not yours to edit.
- Preserve every event, action, and fact. Do not add plot, do not remove plot, do not invent a new beat.
- Change only the narration: the sentences between and around the dialogue.
- ${
    polish
      ? 'Do not add new events or description for its own sake. Replace generic summary and camera-report sentences with observed, specific detail.'
      : 'Fix the listed problems. Do not replace one stock beat with another from the same family.'
  }
- Preserve every markdown emphasis span and every paragraph break. Do not flatten a styled paragraph into plain text.
- Do not open on the previous reply's opening. Vary the first sentence.
- Keep the paragraph count within one of the original unless a violation is the paragraph count itself.
- Output only the corrected reply. No preamble, no notes, no code fence, no explanation.`;
}

/**
 * Drops excess paragraph breaks until the text has at most `max` paragraphs.
 *
 * Paragraph count is the one setting that can be satisfied without a model: joining two
 * paragraphs with a space changes no word, no line of dialogue, and no event — only the
 * break. Returns null when the text already fits.
 */
function mergeToCeiling(content: string, max: number): string | null {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length <= max) return null;

  while (paragraphs.length > max) {
    const last = paragraphs.pop();
    if (last === undefined) break;
    const index = paragraphs.length - 1;
    paragraphs[index] = `${paragraphs[index]} ${last}`;
  }
  return paragraphs.join('\n\n');
}

/**
 * Repairs one assistant reply.
 *
 * Returns the violations even when no repair was written, so the button can say "nothing
 * found" instead of failing silently. A repair that would change the dialogue, come back
 * empty, or fix nothing is rejected and reported as an error — the original is the only
 * thing on screen, and a second bad version is worse than the first.
 *
 * `inspection` is the caller's answer from `inspectReply`, when it has one. Passing it in
 * is what lets a turn detect once, persist the status, and hand the same violations to the
 * repair instead of reading the same rows twice.
 */
export async function repairReply(
  env: Env,
  chatId: string,
  messageId: string,
  options: RepairOptions,
  inspection?: Inspection,
): Promise<RepairResult> {
  const inspected = inspection ?? (await inspectReply(env, chatId, messageId));
  const { setup, target, previous, violations } = inspected;
  const polish = options.polish === true;

  if (setup.proseGuard === 'off') {
    throw new Error('prose guard is off for this chat');
  }
  if (violations.length === 0 && !polish) return { violations: [] };

  // The reply may have been edited, regenerated, or swiped while this was queued. A
  // correction of text that is no longer there belongs to no position on screen.
  if (!(await stillHasContent(env, chatId, messageId, target.content))) {
    await clearProseStatus(env, messageId);
    return { violations, discarded: true };
  }

  const ceiling = PARAGRAPH_CEILING[setup.craft.responseLength] ?? null;
  const lengthOnly =
    violations.length > 0 && violations.every((violation) => violation.kind === 'length');

  let repaired: string;
  if (lengthOnly && ceiling != null) {
    // The count is formatting, not prose. No model call: joining the surplus paragraphs
    // preserves every word and always lands on the ceiling, where the cheap model kept
    // coming back with the same number of paragraphs it was asked to remove.
    const merged = mergeToCeiling(target.content, ceiling);
    if (!merged) return { violations };
    repaired = merged;
  } else {
    const chat = await env.DB.prepare('SELECT preset_id FROM chats WHERE id = ?')
      .bind(chatId)
      .first<{ preset_id: string | null }>();
    const settings = await loadEffectiveSettings(env, chat?.preset_id ?? null);
    const voice = voiceOf(settings.presetPostHistory, setup.proseSample);
    const user = `Previous reply, for voice and to avoid its opening:\n${
      previous[0]?.trim().slice(0, 1600) ?? '(none)'
    }\n\nReply to correct:\n${target.content}`;

    const result = await complete(env, {
      system: systemPrompt(voice, violations, polish),
      user,
      // A reply is ~300-900 tokens; 3500 leaves room for the correction plus the
      // side-channel's own thinking without inviting a rewrite of the whole scene.
      maxTokens: 3500,
      settings,
    });

    repaired = result.text
      .trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    // A rewrite that fixed everything except the count still gets the deterministic
    // merge; its other fixes survive, and the count is guaranteed instead of rejected.
    if (ceiling != null) {
      const merged = mergeToCeiling(repaired, ceiling);
      if (merged) repaired = merged;
    }
  }

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
  if (polish) {
    // There was nothing to fix, so there is no violation count to improve. The only
    // failure mode a polish can introduce is a new tic of its own.
    if (after.length > 0) {
      throw new Error(
        `the rewrite introduced ${after.length} problem${after.length === 1 ? '' : 's'}; it was not applied`,
      );
    }
  } else if (after.length >= violations.length) {
    throw new Error(
      `the repair left ${after.length} of ${violations.length} problems; it was not applied`,
    );
  }

  // Re-read immediately before writing. The model call above is the long part; an edit
  // that landed during it must win, not the correction of the old text.
  if (!(await stillHasContent(env, chatId, messageId, target.content))) {
    await clearProseStatus(env, messageId);
    return { violations, discarded: true };
  }

  const id = await addProseAlternative(env, chatId, messageId, repaired, options.activate);
  return { violations, id, repaired };
}

/**
 * The auto pass. Runs after a turn, behind `waitUntil`.
 *
 * A correction that arrives after the reader has started replying is a version they did
 * not ask for; it is added inactive, so the transcript's swipe count changes and the text
 * on screen does not. The client polls the status endpoint while the row is on screen and
 * reloads once when the claim settles, which is how it learns that `queued` became
 * `done` or `failed` without a blind fixed delay.
 */
export async function maybeGuardProse(
  env: Env,
  chatId: string,
  messageId: string,
  inspection?: Inspection,
): Promise<void> {
  const inspected = inspection ?? (await inspectReply(env, chatId, messageId));
  if (inspected.setup.proseGuard !== 'auto') return;
  if (inspected.violations.length === 0) return;

  // The claim is the lock. Auto and a Fix click can both arrive for the same reply; only
  // the one that moves the row out of `queued` gets to spend a model call.
  if (!(await claimProse(env, messageId, ['queued']))) return;

  // A length-only repair removes paragraph breaks and changes no word. Showing it
  // immediately is the point: the reader set a paragraph count and the reply broke it.
  // Any prose rewrite stays inactive so the original can be compared.
  const lengthOnly = inspected.violations.every((violation) => violation.kind === 'length');

  try {
    const result = await repairReply(
      env,
      chatId,
      messageId,
      { activate: lengthOnly },
      inspected,
    );
    if (result.discarded) {
      await clearProseStatus(env, messageId);
    } else {
      await setProseStatus(env, messageId, 'done', result.violations);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The status is the reader's only evidence that a repair was attempted, so a write
    // failure here must not mask the repair's own failure.
    await setProseStatus(env, messageId, 'failed', inspected.violations, reason).catch(() => {});
    console.warn(`[prose] auto repair failed for chat=${chatId}: ${reason}`);
  }
}
