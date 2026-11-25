import { describe, expect, test } from 'bun:test';
import {
  detectViolations,
  firstSentence,
  learnFromEdit,
  preservesDialogue,
  splitDialogue,
} from './guard';

describe('splitDialogue', () => {
  test('separates narration, speech and a phone message', () => {
    const reply = 'She frowns. "You asked."\n\n**syd**: i am not answering that';
    const { narration, dialogue } = splitDialogue(reply);
    expect(dialogue).toEqual(['You asked.', 'i am not answering that']);
    expect(narration).not.toContain('You asked');
    expect(narration).not.toContain('not answering');
    expect(narration).toContain('She frowns.');
  });

  test('does not split on an apostrophe or an unclosed quote', () => {
    const { dialogue } = splitDialogue(`She doesn't move. "Then the door opened.`);
    expect(dialogue).toEqual([]);
  });
});

describe('firstSentence', () => {
  test('stops at the first sentence boundary', () => {
    expect(firstSentence('She sets the mug down. Then she leaves.')).toBe('She sets the mug down.');
  });

  test('returns empty for a dialogue or thought opening', () => {
    expect(firstSentence('"Fine." She leaves.')).toBe('');
    expect(firstSentence('*He is not answering.* She waits.')).toBe('');
  });
});

describe('detectViolations', () => {
  test('flags a stocked beat in narration', () => {
    const found = detectViolations('Her jaw works. "Okay."');
    expect(found.map((entry) => entry.kind)).toContain('banned');
  });

  test('does not flag the same phrase inside dialogue', () => {
    const found = detectViolations('She shrugs. "My jaw works just fine."');
    expect(found.map((entry) => entry.kind)).not.toContain('banned');
  });

  test('flags an opening that repeats the previous reply as a 4-gram', () => {
    const previous = 'Her hips slam down, ass hitting his thighs. The wings creak.';
    const reply = 'Her hips slam down, ass hitting his thighs again.';
    const found = detectViolations(reply, { previous: [previous] });
    expect(found.some((entry) => entry.kind === 'opening')).toBe(true);
  });

  test('does not flag a fresh opening', () => {
    const previous = 'Her hips slam down, ass hitting his thighs. The wings creak.';
    const reply = 'The mattress has given up pretending. She does not slow down.';
    const found = detectViolations(reply, { previous: [previous] });
    expect(found.some((entry) => entry.kind === 'opening')).toBe(false);
  });

  test('flags three ands in one narration sentence, not in dialogue', () => {
    const narration = detectViolations(
      'She crosses the room and locks the door and sets the mug down and turns around.',
    );
    expect(narration.some((entry) => entry.kind === 'andChain')).toBe(true);
    const dialogue = detectViolations(
      'She shrugs. "I came in and locked the door and set the mug down and turned around."',
    );
    expect(dialogue.some((entry) => entry.kind === 'andChain')).toBe(false);
  });

  test('flags a reply over its paragraph ceiling', () => {
    const reply = Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
    expect(detectViolations(reply, { maxParagraphs: 6 }).some((e) => e.kind === 'length')).toBe(
      true,
    );
    expect(detectViolations(reply, { maxParagraphs: 9 }).some((e) => e.kind === 'length')).toBe(
      false,
    );
  });
});

describe('preservesDialogue', () => {
  test('accepts a repair that leaves the lines intact', () => {
    const before = 'Her jaw works. "You asked." She waits. "Say it."';
    const after = 'She does not move. "You asked." The room is quiet. "Say it."';
    expect(preservesDialogue(before, after)).toBe(true);
  });

  test('rejects a paraphrased line', () => {
    const before = 'She waits. "You asked for this."';
    const after = 'She waits. "You wanted this."';
    expect(preservesDialogue(before, after)).toBe(false);
  });

  test('rejects a merged line', () => {
    const before = '"You asked." "Say it."';
    const after = '"You asked. Say it."';
    expect(preservesDialogue(before, after)).toBe(false);
  });
});

describe('learnFromEdit', () => {
  test('learns a repeated phrase that the edit removed', () => {
    const before =
      'Her hips slam down on the mattress. Later, her hips slam down again.';
    const after = 'Her hips find the mattress. Later, she slows.';
    expect(learnFromEdit(before, after)).toContain('her hips slam down');
  });

  test('learns a stocked beat the edit removed', () => {
    const before = 'Her jaw works. "Okay."';
    const after = 'She looks at the door. "Okay."';
    expect(learnFromEdit(before, after)).toContain('jaw works');
  });

  test('does not learn a one-off story detail', () => {
    const before = 'The fishing line holds the cracked hinge together.';
    const after = 'The hinge holds.';
    expect(learnFromEdit(before, after)).toEqual([]);
  });
});
