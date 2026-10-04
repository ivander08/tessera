import { describe, expect, test } from 'bun:test';
import { resolveAttachment, stateAdvancesOn } from './turn';

/**
 * Where a turn's rows attach.
 *
 * This is the decision that destroyed a real chat. An impersonated line was parented to the
 * target's parent instead of to the end of the path, so it became an alternative OPENING —
 * `parent_id = NULL` — and the path walk stopped at it, leaving a reader looking at one
 * message where their whole scene had been.
 *
 * Pure, so the rules are asserted without a provider, a database or a stream.
 */

const OPENING = { id: 'opening', parent_id: null, role: 'assistant' as const };
const REPLY = { id: 'reply', parent_id: 'opening', role: 'assistant' as const };
const MINE = { id: 'mine', parent_id: 'reply', role: 'user' as const };

describe('resolveAttachment', () => {
  test('send answers the end of the path, not the target it was given', () => {
    // The client sends no target for `send`, but the rule must hold regardless: a step
    // forward attaches to the tail.
    const { parentId, replyParentId } = resolveAttachment('send', null, 'reply');
    expect(parentId).toBe('reply');
    // The reply is the reader's message's child, filled in by the caller once it exists.
    expect(replyParentId).toBe('reply');
  });

  test('impersonate is a STEP FORWARD — the bug that wiped the scene', () => {
    // The old code produced `target.parent_id` here, which for the tail is the row the tail
    // answers. An impersonated line landed as a sibling of the last message instead of its
    // child; at the opening that means `parent_id = NULL`, an alternative greeting.
    const { parentId, replyParentId } = resolveAttachment('impersonate', REPLY, 'reply');
    expect(parentId).toBe('reply');
    expect(replyParentId).toBe('reply');
    expect(parentId).not.toBe(REPLY.parent_id);
  });

  test('impersonate at the opening still attaches AFTER it, never beside it', () => {
    const { parentId, replyParentId } = resolveAttachment('impersonate', OPENING, 'opening');
    expect(parentId).toBe('opening');
    expect(replyParentId).toBe('opening');
    // The specific failure: this must never be null, which would make it an opening variant.
    expect(parentId).not.toBeNull();
  });

  test('regenerate is a VARIANT — it shares the target position', () => {
    const { parentId, replyParentId } = resolveAttachment('regenerate', REPLY, null);
    expect(parentId).toBe('opening');
    expect(replyParentId).toBe('opening');
  });

  test('regenerate on an opening produces another opening variant', () => {
    const { parentId } = resolveAttachment('regenerate', OPENING, null);
    expect(parentId).toBeNull();
  });

  test('continue is a CHILD of the message it continues', () => {
    // Reusing the target's parent here made a continuation a variant of the reply it was
    // continuing: the reader asked for more and watched the previous paragraph turn into a
    // swipe.
    const { parentId, replyParentId } = resolveAttachment('continue', REPLY, null);
    expect(parentId).toBe('reply');
    expect(replyParentId).toBe('reply');
    expect(replyParentId).not.toBe(REPLY.parent_id);
  });

  test('a recovery continue answers the reader row that is waiting', () => {
    // Stop left the reader's own message as the tail with no reply. Continue there means
    // "answer it", so the output hangs off that row.
    const { replyParentId } = resolveAttachment('continue', MINE, null);
    expect(replyParentId).toBe('mine');
  });

  test('an empty chat resolves to the root for every mode that can reach it', () => {
    expect(resolveAttachment('send', null, null).parentId).toBeNull();
    expect(resolveAttachment('impersonate', null, null).parentId).toBeNull();
  });
});

/**
 * Which completed turns move the world state.
 *
 * The reported bug: a regenerated reply carried no snapshot, so its scene line showed the
 * PREVIOUS turn's clock. On the chat under test the reader wrote "On Thursday evening" and
 * one of the swipe variants still read "Friday, April 11, 22:38" — the version had replaced
 * the scene, but the state had not moved with it.
 */
describe('stateAdvancesOn', () => {
  test('a send and a recovery continue are the turns that complete', () => {
    expect(stateAdvancesOn('send', false)).toBe(true);
    expect(stateAdvancesOn('continue', true)).toBe(true);
  });

  test('a regenerate is a completed turn and advances state with it', () => {
    expect(stateAdvancesOn('regenerate', false)).toBe(true);
  });

  test('a plain continue extends the same reply and does not re-run the engine', () => {
    // The scene has not moved on; the new row inherits the target's snapshot.
    expect(stateAdvancesOn('continue', false)).toBe(false);
  });

  test('impersonate writes the reader line and does not advance state', () => {
    // Nothing in the world has happened yet; the reply to it is the turn that moves.
    expect(stateAdvancesOn('impersonate', false)).toBe(false);
  });
});
