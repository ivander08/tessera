import { describe, expect, test } from 'bun:test';
import { walkPath, type BranchRow } from './branch';

/**
 * The transcript walk.
 *
 * This is the rule that makes regenerating an old message behave the way a reader
 * expects, so it is tested directly rather than through a chat: given a set of rows, the
 * walk must return exactly the scene on screen.
 *
 * The scenario throughout is the one the reader described:
 *
 *     assistant A1   user U1   assistant A2   user U2
 *
 * Regenerating A1 must hide U1, A2 and U2 — they were written after a version of A1 that
 * is no longer showing. Swiping back to A1 must bring all three back, unchanged, because
 * nothing was ever deleted.
 */

let seq = 0;

/** A row with sensible defaults; `parent` names the row it answers. */
function row(
  id: string,
  parent: string | null,
  role: BranchRow['role'],
  active = 1,
): BranchRow {
  return {
    seq: ++seq,
    id,
    parent_id: parent,
    role,
    content: `${role}:${id}`,
    content_tokens: 1,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    cost_usd: null,
    active,
    swipe_group: null,
    created_at: 0,
  };
}

const ids = (rows: BranchRow[]) => rows.map((r) => r.id);

describe('walkPath', () => {
  test('an empty chat has an empty transcript', () => {
    expect(walkPath([])).toEqual([]);
  });

  test('follows a linear chain in order', () => {
    const rows = [row('a1', null, 'assistant'), row('u1', 'a1', 'user'), row('a2', 'u1', 'assistant')];
    expect(ids(walkPath(rows))).toEqual(['a1', 'u1', 'a2']);
  });

  test('regenerating the first reply hides everything that followed it', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
      // The regenerate: another version of the opening, now the active one.
      row('a1b', null, 'assistant'),
    ];
    expect(ids(walkPath(rows))).toEqual(['a1b']);
  });

  test('swiping back restores the whole continuation, unchanged', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
      row('a1b', null, 'assistant'),
    ];
    // The regenerate above left a1b active. Swiping back flips which version is active —
    // the rows themselves are never rewritten.
    const afterSwipe = rows.map((r) =>
      r.id === 'a1' ? { ...r, active: 1 } : r.id === 'a1b' ? { ...r, active: 0 } : r,
    );
    expect(ids(walkPath(afterSwipe))).toEqual(['a1', 'u1', 'a2', 'u2']);
  });

  test('two versions of a middle turn each keep their own continuation', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
      // Regenerated u1's reply: same parent, so it replaces a2 in the path.
      row('a2b', 'u1', 'assistant'),
      // A new turn written on top of the new version.
      row('u2b', 'a2b', 'user'),
    ];
    expect(ids(walkPath(rows))).toEqual(['a1', 'u1', 'a2b', 'u2b']);
  });

  test('a deleted position takes its continuation out of the transcript', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('u1', 'a1', 'user'),
      row('a2', 'u1', 'assistant'),
      row('u2', 'a2', 'user'),
    ];
    // Delete the user turn: the row is deactivated, not removed.
    const afterDelete = rows.map((r) => (r.id === 'u1' ? { ...r, active: 0 } : r));
    expect(ids(walkPath(afterDelete))).toEqual(['a1']);
  });

  test('stops at a position with no active version', () => {
    const rows = [row('a1', null, 'assistant'), row('u1', 'a1', 'user', 0)];
    expect(ids(walkPath(rows))).toEqual(['a1']);
  });

  test('ignores an inactive version even when it is newer', () => {
    const rows = [
      row('a1', null, 'assistant'),
      row('a1b', null, 'assistant', 0),
    ];
    expect(ids(walkPath(rows))).toEqual(['a1']);
  });

  test('takes the newest active version when the data is ambiguous', () => {
    // The invariant is one active child; a bad write could break it. The walk must still
    // return a single transcript rather than both versions spliced together.
    const rows = [row('a1', null, 'assistant'), row('a1b', null, 'assistant')];
    expect(ids(walkPath(rows))).toEqual(['a1b']);
  });

  test('terminates on a cycle instead of spinning', () => {
    const rows = [row('a', 'b', 'assistant'), row('b', 'a', 'assistant')];
    // Neither is reachable from the root, so the transcript is empty — the point is that
    // this returns at all.
    expect(walkPath(rows)).toEqual([]);
  });
});
