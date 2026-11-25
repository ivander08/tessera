import { learnFromEdit } from '../../../src/lib/prose/guard';
import { addProseBans, loadSceneSetup } from '../scene';

/**
 * Turns a hand edit into a rule.
 *
 * This is the loop the feature exists for: the reader fixes a reply, and the fix teaches
 * the guard what to catch next time. It only runs when the guard is on, and the extractor
 * is deliberately conservative — a known stock beat, or a phrase that repeated inside the
 * deleted narration. A reader deleting a paragraph for story reasons must not ban the plot.
 */
export async function learnProseBans(
  env: Env,
  chatId: string,
  before: string,
  after: string,
): Promise<string[]> {
  const setup = await loadSceneSetup(env, chatId);
  if (setup.proseGuard === 'off') return [];

  const learned = learnFromEdit(before, after);
  if (learned.length === 0) return [];
  return await addProseBans(env, chatId, learned);
}
