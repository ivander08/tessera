/**
 * A written sound, whatever the word.
 *
 * The check this replaces was a closed vocabulary of 25 tokens lifted from the craft
 * block's own example list. That list is explicitly a set of EXAMPLES — a model is meant to
 * write sounds that are not in it — so the check only passed on the words the prompt
 * happened to print. It measured the prompt's vocabulary, not the model's behaviour.
 * Measured against the sounds the block documents plus the ones a real run produced, the
 * closed pattern missed 15 of 18: `Aaaahh!`, `Hrh!`, `Grr...`, `Schluup~!`, `Ehehe...`,
 * `WOO!`, `Owie!`, `Nghh~!` and more.
 *
 * So this tests the SHAPE of a sound, not its spelling. A written sound is distinguishable
 * from a written word in a small number of ways, and each is a pattern here:
 *
 *   - a held letter        `Aaaahh`, `Nnngh`, `Haaah`, `Schluup`
 *   - a broken word        `T-The`, `A-Ah`, `sssorry`, `d-don't`
 *   - the coaxing tilde    `Mmm~`, `Nghh~`, `Chu~`
 *   - an italicised noise  `*pop*`, `*gulp*`, `*there*`
 *   - a vowelless burst    `Hmm`, `Tsk`, `Pfft`, `Ngh`, `Hrh`, `Grr`
 *   - a shout              `WOO`, `YEAHH`, `BWAHAHA`
 *   - a standalone burst   a short quoted or italicised token — `"Nn—"`, `"Mmnh."`
 *
 * `[A-Z]{2,}` is case-SENSITIVE on purpose: under the `i` flag it matches every capitalised
 * word, which is the first word of every sentence. Every other pattern is case-insensitive,
 * because `Mmm~` and `mmm~` are the same sound.
 *
 * ## Why the last shape is separate
 *
 * A held letter or a vowelless burst inside ordinary prose is usually a false positive:
 * measured on the real `vocalisation-off` transcript, an em-dash-heavy narration produced
 * `careful—`, `everything—`, `close—` and `hips—` as "sounds". A sound written as a
 * STANDALONE quoted or italicised burst is what the block actually asks for, and it
 * separates cleanly: the same measurement gives 6 and 9 sound bursts with the block on
 * against 1 and 0 with it off.
 *
 * This is a LOWER BOUND. A sound with no repeated letter, no break, no tilde and a normal
 * spelling (`Blrrgh` — two r's) is missed. That is the right trade for a pass/fail gate.
 * `scripts/eval/sound.test.ts` pins both directions: recall on the documented and
 * undocumented sounds, and precision on plain prose and on the real off-transcript lines.
 */

/** The commonest English words, so a shape test cannot fire on an ordinary short word. */
const COMMON = new Set(
  (
    'the a an and or but if then than that this these those i you he she it we they me him ' +
    'her us them my your his its our their is are was were be been being am do does did done ' +
    'have has had having will would can could shall should may might must not no nor so as at ' +
    'by for from in into of on onto out over to up with within without about after before ' +
    'between during under above below off again further once here there when where why how ' +
    'all any both each few more most other some such only own same too very just now also ' +
    'still even ever never always often sometimes really quite rather almost much many lot ' +
    'back down away out through toward towards behind beside across around along go oh ah ' +
    'already ill im ive dont cant wont thats its yous'
  ).split(' '),
);

/**
 * A short burst a body makes: a held letter, a tilde, a broken word, or a vowelless noise.
 *
 * Asterisked italics are NOT here. Matching an asterisked word as a sound scored `walked`,
 * `tired`, `shit` and `lie` — emphasis on an ordinary word, which a real run used
 * constantly. A standalone italicised burst is caught by the span rule instead, which
 * requires it to be short, standalone and not an ordinary word.
 */
const BURST_SHAPES: RegExp[] = [
  /([A-Za-z])\1\1/, // Aaaahh, Nnngh, Haaah, Schluup
  /([A-Za-z]{2,3})\1+/, // Hahaha, Hehehe, Waha — a syllable repeated
  /[A-Za-z]~/, // Mmm~, Nghh~, Chu~
  /\b([A-Za-z]{1,3})-\1[A-Za-z]/, // T-The, A-Ah
  /\b[b-df-hj-np-tv-z]{2,}\b/, // Hmm, Tsk, Pfft, Ngh, Hrh, Grr
];

/**
 * Vowelless English words, which the vowelless-burst shape would otherwise accept.
 *
 * `dry`, `rhythm`, `myth` and `lynx` have no vowel letter at all, so they fit the shape that
 * catches `Hmm`, `Tsk`, `Pfft` and `Ngh`. They are prose, and measured on the real
 * `vocalisation-off` transcript they were the shape's only false positives.
 */
const VOWELLESS_WORDS = new Set(
  (
    'by my why shy sky fly try cry dry fry ply sly spy sty thy gym hymn lynx myth sync cyst ' +
    'gypsy lymph nymph crypt glyph rhythm sylph tryst lynx pyx myrrh'
  ).split(' '),
);

/**
 * Short ordinary English words, which a single-token span would otherwise accept.
 *
 * A sound written as `"Eep!"` or `"Ow!"` has no held letter, no tilde and a normal
 * spelling, so the shapes cannot catch it — the only thing that separates it from a word is
 * that it is not a word. These are the short words a real `vocalisation-off` transcript
 * produced inside quotes: `"Sit,"`, `"Two,"`, `"Lock it,"`, `"Not yet."`.
 */
const SHORT_WORDS = new Set(
  (
    'sit two not yet lie back come here lock work six hour hours wait stop yes okay ok now ' +
    'then when what that they them her him his hers one out off let put get got give take ' +
    'make made look see saw say said tell told know knew think thought want need keep kept ' +
    'turn hold move pull push stand walk talk hear feel felt left right good bad well just ' +
    'still even much many more less most best last next first long short high low near far ' +
    'open shut close closed door room hand head face eyes hair coat table chair floor light ' +
    'dark warm cold soft hard slow quick fast true false sure fine done gone here there'
  ).split(' '),
);

/** A quoted or italicised span, which is where a standalone sound is written. */
const SPAN = /\*([^*\n]{1,60})\*|"([^"\n]{1,60})"/g;

/**
 * A bare sound: a short non-word shut by sound punctuation — `Haa`, `Eep!`, `Ow!`, `Che!`,
 * `Huhh?!`, `Sniff...`, `Umm..`, `Uhh…`.
 *
 * These are the sounds with no held letter, no break and no tilde, written without quotes.
 * Measured on the real `vocalisation-off` transcript, this shape added no false positives
 * at all, which is what makes it safe to run over the prose — unlike the vowelless and
 * single-token shapes, which fired on `dry`, `hips—` and `"Sit,"`.
 */
const BARE_SOUND = /\b([A-Za-z]{2,7})(?:[!~]|\.\.|\?!)|\b([A-Za-z]{2,7})(?=…)/g;

/**
 * Whether one span is a sound rather than a line of dialogue.
 *
 * Two ways in. The burst shapes, which are self-evidently a noise. And — for a SINGLE short
 * token only — a non-word: `"Eep!"`, `"Ow!"`, `"Che!"`, `"Haa"`, `"Mwah!!"` have no held
 * letter, no tilde and a normal spelling, so no shape catches them, but one short non-word
 * alone between quotes is a sound.
 *
 * Both restrictions are load-bearing. A single token, because a real off-transcript wrote
 * `"Lock it,"`, `"Not yet."` and `"Come here."` — dialogue, not sounds. A non-word, because
 * `"Sit,"` and `"Two,"` are one short token each and are ordinary English.
 */
function isSoundSpan(span: string): boolean {
  const text = span.trim();
  if (text.length === 0 || text.length > 24) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;

  // Strong evidence first, BEFORE the common-word rejection. `Ah` and `Oh` are ordinary
  // words, but `"Ah—"` is a sound, so a cut-off burst has to be judged on its shape rather
  // than on its spelling.
  if (BURST_SHAPES.some((shape) => shape.test(text))) return true;
  if (/^[A-Za-z]{1,4}\s*[—–]$/.test(text)) return true;

  const bare = text.replace(/[^A-Za-z]/g, '').toLowerCase();
  if (bare.length === 0 || COMMON.has(bare) || VOWELLESS_WORDS.has(bare)) return false;

  return (
    words.length === 1 &&
    bare.length <= 5 &&
    !SHORT_WORDS.has(bare) &&
    !COMMON.has(bare)
  );
}

/**
 * Every written sound in `text`, as the matched text. Duplicates are collapsed by their
 * LETTERS, so `"Ngh—"` written three times — and matched once as the vowelless shape and
 * once as the quoted span — counts as the one sound it is. The count is about variety as
 * much as volume.
 */
export function soundDevices(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (match: string): void => {
    const key = match.replace(/[^A-Za-z]/g, '').toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(match);
  };

  // A standalone quoted or italicised burst. Checked BEFORE the prose shapes below, because
  // a whole burst like `"BBBWAAHHAHAAA!!"` otherwise matches three of them separately and
  // scores as three sounds. One quoted burst is one sound.
  for (const match of text.matchAll(SPAN)) {
    const span = (match[1] ?? match[2] ?? '').trim();
    if (isSoundSpan(span)) add(span);
  }

  // The distinctive shapes, anywhere in the prose.
  for (const shape of BURST_SHAPES) {
    for (const match of text.matchAll(new RegExp(shape.source, 'gi'))) {
      const bare = match[0].replace(/[^A-Za-z]/g, '').toLowerCase();
      if (bare.length >= 2 && !COMMON.has(bare) && !VOWELLESS_WORDS.has(bare)) add(match[0]);
    }
  }

  // A shout is NOT matched on capitals alone. `"OVER HERE"` and `"THE STEPS. LEFT OF THE
  // PUMP."` are shouted WORDS, and the first version of this counted each as a sound —
  // three devices for one line of dialogue. A shout only counts when it is also shut by
  // sound punctuation, which the bare-sound pass below already requires (`"WHAT?!"`,
  // `"BWAHAHA!"`, `"YEAHH!"`), so there is no separate capitals rule.

  // A bare sound — a short non-word shut by sound punctuation.
  for (const match of text.matchAll(new RegExp(BARE_SOUND.source, 'g'))) {
    const bare = (match[1] ?? match[2] ?? '').toLowerCase();
    if (bare.length >= 2 && !COMMON.has(bare) && !SHORT_WORDS.has(bare) && !VOWELLESS_WORDS.has(bare)) {
      add(match[0]);
    }
  }

  return out;
}

/** How many distinct sounds the text wrote. */
export function soundCount(text: string): number {
  return soundDevices(text).length;
}
