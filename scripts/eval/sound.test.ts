import { describe, expect, test } from 'bun:test';

import { soundDevices, soundCount } from './sound';

/**
 * The sound detector, in both directions.
 *
 * The check this replaced was a closed vocabulary lifted from the craft block's example
 * list, and that list is explicitly examples — a model is meant to write sounds that are
 * not in it. Measured against the sounds the block documents plus the ones a real run
 * produced, the closed pattern missed 15 of 18. Both halves below matter: recall is why the
 * detector is open, and precision is why it is not simply "any short word".
 */

/** The sounds the craft block documents as its own examples. */
const DOCUMENTED = [
  'Mmm~',
  'Mmmh',
  'Ah—',
  'Nnn',
  'Haa',
  'Haaah… haa…',
  'Ahhn!',
  'Aaaahh!',
  'Nnngh!',
  'Haaah—',
  'Nngh—',
  'Hnng!',
  'Ughh!',
  'Grhh!',
  'Khh~',
  'Huhh?!',
  'Eh?!',
  'Haaah-!',
  'Hiee?!',
  'Eep!',
  'Kya!',
  'A-Ah...',
  'Ow!',
  'Ahh—!',
  'Nngghh...!',
  'P-Please..!',
  'Hh-Hey..!',
  'Nnnnh~!',
  'Ehhhn~!',
  'Hic...!',
  'Hwahh...!',
  'Sniff...',
  'Hah',
  'Hehe…',
  'Pfft…!',
  'Hahah!',
  'BWAHAHA!',
  'Huff… huff…',
  'Mwah!!',
  'Chu~',
  'Mmmch!',
  'Mmmph!',
  'Glk—glk—glk—',
  'Slurp… slurrrp!',
  'Gulp…!',
  '*pop*!',
  'Mm-Mm!',
  'Crunch crunch!',
  'Slurp!',
  'Ahhh~',
  'Mmmf!',
  'Tsk!',
  'Che!',
  'Hmph.',
  'Zzz...',
];

/**
 * Sounds the block does NOT print, which is the whole point.
 *
 * Every one of these was missed by the closed vocabulary, and a model that wrote them was
 * scored as having written no sound at all — the instrument reporting the opposite of what
 * happened.
 */
const UNDOCUMENTED = [
  'Aaaahh!',
  'Hrh!',
  'Grr...',
  'Grrh!',
  'Khhh~',
  'Schluup~!',
  'Ehehe...',
  'Umm..',
  'Uhh…',
  'WOO!',
  'YEAHH!',
  'Oi!',
  'HUH?',
  'Owie!',
  'Hnn!',
  'Nghh~!',
  'Haa… haa…',
];

describe('soundDevices — recall', () => {
  /**
   * A sound in the form prose actually writes it: a standalone quoted or italicised burst.
   *
   * Bare tokens are asserted in context rather than alone, because that is the only form
   * the detector claims. A bare `Ah—` mid-sentence is indistinguishable from an em-dash
   * clause (`careful—`, `everything—`), which a real block-off transcript produced in
   * quantity — so the shapes are deliberately restricted to where a sound is written.
   */
  const inContext = (sound: string): string => `She says it. "${sound}" Then nothing.`;

  test('every sound the craft block documents is found', () => {
    const missed = DOCUMENTED.filter((sound) => soundDevices(inContext(sound)).length === 0);
    expect(missed).toEqual([]);
  });

  test('a sound the block never prints is still found — the vocabulary is not closed', () => {
    const missed = UNDOCUMENTED.filter((sound) => soundDevices(inContext(sound)).length === 0);
    expect(missed).toEqual([]);
  });

  test('a sound inside a sentence is found, not just a sound on its own', () => {
    expect(soundDevices('She drags air in. "Nngh—" Her shoulders heave.').length).toBeGreaterThan(0);
    expect(soundDevices('"Mmm~," she says, and the lamp rocks.').length).toBeGreaterThan(0);
    expect(soundDevices('*Haaah… haa…* She cannot speak yet.').length).toBeGreaterThan(0);
  });
});

describe('soundDevices — precision', () => {
  test('plain prose reports no sound', () => {
    // Every one of these is a sentence a real run produced. A false positive here would
    // make the block look like it worked when it did not.
    const prose = [
      'She crosses the room and her hands find the lapels over your coat.',
      'The latch drops. Ink is drying on the charts — the coastline of some place you have never been to.',
      'Ada looks up from the bench and waits for an answer.',
      'He is tall, careful, and slow to trust. He sets the glass down on the table.',
      'The rain keeps on the window. Somewhere below the floorboards the tavern keeper banks the fire.',
      'She does not come in. She asks whether I read the letter she left under the door.',
      'The lamp sits at her back, so her face is a shadow until she leans in and it is not.',
      'The dividers hit the floorboards, then the brass rule, a roll of tracing paper.',
      'She is three sentences into a funeral and she loses the thread of it.',
      'He looks at nothing, at the inkwell, at the middle distance where the rain is coming down.',
    ];
    for (const sentence of prose) {
      expect(soundDevices(sentence)).toEqual([]);
    }
  });

  test('a capitalised word is not a shout — the shout rule needs sound punctuation', () => {
    // Matching capitals alone made every sentence-initial word a sound, and counted a line
    // of shouted dialogue as three of them: a real run wrote `"THE STEPS. LEFT OF THE
    // PUMP."` and the detector scored `STEPS`, `LEFT` and `PUMP`.
    expect(soundDevices('The rain keeps on.')).toEqual([]);
    expect(soundDevices('Ada Vance, 31. A restorer of old books.')).toEqual([]);
    expect(soundDevices('"OVER HERE," she calls.')).toEqual([]);
    expect(soundDevices('"THE STEPS. LEFT OF THE PUMP."')).toEqual([]);
    // A shout that IS a body sound still counts.
    expect(soundDevices('"BWAHAHA!"')).not.toEqual([]);
    expect(soundDevices('"YEAHH!"')).not.toEqual([]);
  });

  /**
   * The real `vocalisation-off` transcript, which is the ground truth for precision.
   *
   * Every line here was produced by the same model with the vocalisation block switched
   * OFF, and each was a false positive of an earlier version of this detector: an em-dash
   * narration read as `careful—` and `everything—`, a vowelless shape read `dry` and
   * `rhythm`, and a single-token span rule read `"Sit,"` and `"Two,"`. A detector that
   * fires on any of these scores a scene with no sounds at all as a success.
   */
  test('the real block-off transcript produces no sounds', () => {
    const offTranscript = [
      'The ink is dry, and the rhythm of the rain on the glass has not changed.',
      '"Sit," she says. "Two," she adds, and waits.',
      'Everything— all of it — sits in the careful line of her hips—',
      'The door was shut. He did not look up!',
      '"Lock it," she says. "Not yet. Come here."',
    ];
    for (const line of offTranscript) {
      expect(soundDevices(line)).toEqual([]);
    }
  });

  test('the same sound twice is one device, so the count is about variety', () => {
    expect(soundCount('"Ngh—" ... "Ngh—" ... "Ngh—"')).toBe(1);
  });
});
