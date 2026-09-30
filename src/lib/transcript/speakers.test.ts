import { describe, expect, test } from 'bun:test';
import { SPEAKER_LINE, splitSpeakers, speakersIn } from './speakers';

/**
 * Reading a script.
 *
 * These two functions are one design: the worker uses `speakersIn` to learn who the
 * narrator introduced, and the transcript uses `splitSpeakers` to give each of them a name
 * and colour. A rule that holds on one side and not the other shows up as a speaker the
 * cast panel lists and the transcript does not render, so the pairs are tested together.
 *
 * The pattern is shared by construction — both import it from here — so what is really
 * under test is the SHAPE of a script, and the two properties that make it usable: it is
 * conservative about what counts as a name, and it is lossless.
 */

describe('speakersIn: what counts as a name', () => {
  test('a labelled line is a speaker', () => {
    expect(speakersIn('Sydney: "You\'re late again."', [])).toEqual(['Sydney']);
    expect(speakersIn('Quill: *sets the book down*', [])).toEqual(['Quill']);
  });

  test('two speakers are both found, in order of first appearance', () => {
    expect(speakersIn('Sydney: "You\'re late."\n\nOlivia: "I brought coffee."', [])).toEqual([
      'Sydney',
      'Olivia',
    ]);
  });

  test('a name is found once however often it speaks', () => {
    expect(speakersIn('Ada: one\nAda: two\nBram: three\nAda: four', [])).toEqual(['Ada', 'Bram']);
  });

  test('accented, apostrophe and hyphenated names all match', () => {
    // These are the three that fail if the pattern uses `[A-Z]` instead of `\p{Lu}`:
    // `A-Z` is ASCII-only, so `À` and `Ø` never match.
    expect(speakersIn('Àmélie: bonjour', [])).toEqual(['Àmélie']);
    expect(speakersIn("O'Brien: hello", [])).toEqual(["O'Brien"]);
    expect(speakersIn('Mary-Jane: hi', [])).toEqual(['Mary-Jane']);
    expect(speakersIn('Øyvind: hei', [])).toEqual(['Øyvind']);
  });

  test('a multi-word name matches, including one whose first word is all caps', () => {
    // The case that exposed the original single-word pattern: a scene's own character is
    // routinely named like a designation, and failing to match them renders a group reply
    // as one undifferentiated block with the labels left in the prose.
    expect(speakersIn('WS-G Probe: *sets the lantern down*', [])).toEqual(['WS-G Probe']);
    expect(speakersIn('Mary Jane: hello', [])).toEqual(['Mary Jane']);
    expect(speakersIn('Doctor Strange: *nods*', [])).toEqual(['Doctor Strange']);
    // Three words, because there is no reason to stop at two.
    expect(speakersIn('The Old Man: *grunts*', [])).toEqual(['The Old Man']);
  });

  test('a bare all-caps designation is not a name', () => {
    // `WS-G` alone has no lowercase letter and only one word, so it is a heading rather
    // than a speaker. That is the rule that keeps `NARRATION` out.
    expect(speakersIn('WS-G: a designation', [])).toEqual([]);
    expect(speakersIn('NARRATION\n"Quoted line"', [])).toEqual([]);
  });

  test('a multi-word name is found once however often it speaks', () => {
    expect(speakersIn('WS-G Probe: one\nWS-G Probe: two\nOlivia: three', [])).toEqual([
      'WS-G Probe',
      'Olivia',
    ]);
  });

  test('a known multi-word name is excluded case-insensitively', () => {
    expect(speakersIn('WS-G Probe: one\nOlivia: two', ['ws-g probe'])).toEqual(['Olivia']);
  });

  test('a colon mid-line is not a speaker', () => {
    // `He said: "no"` is narration containing a colon, not a script line. The name must be
    // the first thing on the line.
    expect(speakersIn('He said: "no"', [])).toEqual([]);
    expect(speakersIn('And then Ada said: "fine"', [])).toEqual([]);
  });

  test('a sentence-opening capital is not a name', () => {
    // `The lantern room: a description` is a heading. `The` is followed by a lowercase
    // letter, so it cannot match the pattern's single-token name class.
    expect(speakersIn('The lantern room: a description', [])).toEqual([]);
    expect(speakersIn('A description follows: nothing', [])).toEqual([]);
  });

  test('a lowercase name does not match', () => {
    expect(speakersIn('sydney: hi', [])).toEqual([]);
  });

  test('a one-letter name does not match', () => {
    expect(speakersIn('A: x', [])).toEqual([]);
  });

  test('an indented name does not match', () => {
    // A script line starts at the first character. An indented one is a quotation of a
    // script inside prose.
    expect(speakersIn('  Sydney: indented', [])).toEqual([]);
  });

  test('a label with no text after the colon does not match', () => {
    expect(speakersIn('Sydney:', [])).toEqual([]);
  });

  test('a name alone on a line needs dialogue or an action beat after it', () => {
    expect(speakersIn('Sydney\n"You\'re late."', [])).toEqual(['Sydney']);
    expect(speakersIn('Quill\n*looks up*', [])).toEqual(['Quill']);
    expect(speakersIn('Sydney\n— "You\'re late."', [])).toEqual(['Sydney']);
    // No colon and no dialogue: a capitalised word alone on a line is a heading or a
    // signature, not a speaker.
    expect(speakersIn('Sydney\nwas late.', [])).toEqual([]);
  });

  test('a quoted line after narration does not invent a speaker', () => {
    // The line before the quote is narration, and the quote itself has no name attached.
    expect(speakersIn('NARRATION\n\n"Quoted line"', [])).toEqual([]);
  });

  test('pronouns are never names', () => {
    // The narrator writing `You: hello` is overstepping, and a pronoun in the cast is the
    // same mistake as `present: ["me"]`.
    expect(speakersIn('You: hello\nMe: hi\nSomeone: hey', [])).toEqual([]);
  });

  test('a known name is not returned again', () => {
    const reply = 'Quill: one\nOlivia: two';
    expect(speakersIn(reply, ['Quill'])).toEqual(['Olivia']);
    // Case-insensitively, because the narrator writes `olivia` and `Olivia` and they are
    // the same person.
    expect(speakersIn(reply, ['quill'])).toEqual(['Olivia']);
    expect(speakersIn(reply, ['Quill', 'Olivia'])).toEqual([]);
  });

  test('the persona and the primary character are never returned', () => {
    // Passed in as `known` by the caller, which is how the worker excludes them.
    const reply = 'Quill: *looks up*\nYou: hello\nAda: "late again"';
    expect(speakersIn(reply, ['Quill', 'You'])).toEqual(['Ada']);
  });

  test('prose with no script lines yields nothing', () => {
    // A correct degradation, not a failure: the reply renders as a single-speaker turn.
    expect(speakersIn('Quill looks up. You are late.', [])).toEqual([]);
    expect(speakersIn('', [])).toEqual([]);
  });
});

describe('splitSpeakers: the lossless property', () => {
  const roundTrip = (content: string): string =>
    splitSpeakers(content)
      .map((segment) => segment.text)
      .join('\n');

  test('a four-paragraph reply is reproduced exactly', () => {
    // The case that fails on the naive implementation: a stripper that removes the `Name:`
    // labels loses text, because a speaker who continues after narration keeps going in
    // the same segment.
    const reply = [
      'Quill: *sets the book down*',
      '',
      'The room is quiet for a moment.',
      '',
      'Olivia: "You were gone a long time."',
      '',
      'Quill: "I was."',
      '',
      'Olivia: *does not look up*',
    ].join('\n');

    expect(roundTrip(reply)).toBe(reply);
  });

  test('every segment carries its own label verbatim', () => {
    const reply = 'Ada: one\nBram: two';
    const segments = splitSpeakers(reply);
    expect(segments).toEqual([
      { speaker: 'Ada', text: 'Ada: one' },
      { speaker: 'Bram', text: 'Bram: two' },
    ]);
  });

  test('narration before the first speaker is its own segment', () => {
    const reply = 'The lamp guttered.\n\nAda: "Did you hear that?"';
    const segments = splitSpeakers(reply);
    expect(segments[0]).toEqual({ speaker: null, text: 'The lamp guttered.\n' });
    expect(segments[1].speaker).toBe('Ada');
    expect(roundTrip(reply)).toBe(reply);
  });

  test('a speaker who continues after narration keeps the trailing lines', () => {
    // The mis-assignment the naive version produced: the lines after the narration belong
    // to Ada, not to nobody and not to the next speaker.
    const reply = 'Ada: "Did you hear that?"\n\n*Silence.*\n\nAda: "Neither did I."';
    const segments = splitSpeakers(reply);
    expect(segments.filter((s) => s.speaker === 'Ada')).toHaveLength(2);
    // And the narration between them is inside the first Ada segment, not lost.
    expect(segments[0].text).toContain('*Silence.*');
    expect(roundTrip(reply)).toBe(reply);
  });

  test('a single-voice reply is one unnamed segment', () => {
    // The ordinary case: nothing to split, and no special path anywhere.
    const reply = 'Quill looks up. "You are late."';
    expect(splitSpeakers(reply)).toEqual([{ speaker: null, text: reply }]);
  });

  test('stripping the label leaves non-empty prose for every named segment', () => {
    // The renderer strips the label for display. If stripping emptied a segment, the
    // reader would see a name with nothing under it that was not written that way.
    const reply = 'Ada: "one"\n\nBram: "two"\n\n*the door closes*';
    for (const segment of splitSpeakers(reply)) {
      if (segment.speaker === null) continue;
      const stripped = segment.text.replace(SPEAKER_LINE, '').trimStart();
      expect(stripped.length).toBeGreaterThan(0);
    }
  });

  test('an empty reply is one unnamed segment rather than no segments', () => {
    expect(splitSpeakers('')).toEqual([{ speaker: null, text: '' }]);
  });

  test('round-trips every shape, including indented and unmatched lines', () => {
    const cases = [
      '',
      'no script at all',
      '  indented: still not a speaker',
      'Ada: one\n\n\nBram: two',
      'A: x\nAda: real',
      'Ada: one\nno label here\nBram: two',
      'trailing narration\n\nAda: one\n\ntrailing again',
    ];
    for (const content of cases) expect(roundTrip(content)).toBe(content);
  });
});
