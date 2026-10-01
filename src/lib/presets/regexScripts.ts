import type { RegexScript } from './types';

/**
 * SillyTavern's regex scripts, applied to text.
 *
 * A preset's prompt half tells the model what to write; its regex half cleans up what the
 * model wrote. Both are part of the preset, and shipping only the first is why an imported
 * Frankenstein preset leaks its own chain-of-thought to the reader: `RF2.2D CoT 1 · Done
 * trim` exists purely to strip the `Scene: … Done` block the preset asked for, and with
 * nothing running it, that block is the reply.
 *
 * ## The two axes
 *
 * ST's scripts carry three independent pieces of targeting, and conflating them is how a
 * cleanup script ends up mangling the prompt:
 *
 *  - `placement` — which text the script applies to. `1` is the reader's own message, `2`
 *    is the model's output. A script is in scope when its list contains the value for the
 *    side being rendered.
 *  - `promptOnly` — apply to the text SENT TO THE MODEL but not to what the reader sees.
 *    This is how a preset strips its own scaffolding before it poisons the next turn's
 *    context while still letting the reader inspect the raw reply.
 *  - `markdownOnly` — apply to what the READER SEES but not to the prompt. The mirror
 *    case: a cosmetic colouriser that must not spend prompt tokens.
 *
 * Neither flag set means both sides. That is the rule this module implements, and it is
 * why `side` is a parameter rather than two separate lists of scripts.
 *
 * ## Failure behaviour
 *
 * One broken script must never cost the reader a reply. A pattern that does not compile,
 * or one that throws at match time, is skipped and the rest still run. The alternative —
 * throwing — turns a preset author's typo into a chat that cannot answer.
 */

/** Which rendering of the text is being produced. */
export type RegexSide = 'prompt' | 'display';

/** ST's `placement` values. */
export const PLACEMENT_USER = 1;
export const PLACEMENT_AI = 2;

/**
 * Which placement applies to a row.
 *
 * ST targets the reader's own input and the model's output separately, and a preset uses
 * the distinction: a script that strips `Scene: … Done` from a reply must not also run
 * over the reader's message, where the same words might be exactly what they typed.
 */
export function placementForRole(role: string): number {
  return role === 'user' ? PLACEMENT_USER : PLACEMENT_AI;
}

/**
 * The longest text a single script will be run against.
 *
 * A regex is a program, and a preset is a file from the internet: a pattern with nested
 * quantifiers can take exponential time, and this runs inside a request that has a CPU
 * budget. The cap bounds the worst case without affecting a real reply — a 200 KB message
 * is already far past any provider's output limit.
 */
const MAX_INPUT = 200_000;

/** A script that is in scope for one side, pre-parsed. */
interface Compiled {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Parse ST's `/pattern/flags` form.
 *
 * ST stores the delimiters, so the string is not a bare pattern: `/a\/b/gi` is a pattern
 * `a\/b` with flags `gi`. Taking the last unescaped `/` is what makes an escaped slash
 * inside the pattern work — splitting on the first `/` would truncate every script that
 * matches a URL or a closing tag.
 *
 * A string without delimiters is accepted as a bare pattern, because that is what a
 * hand-written script looks like and refusing it would be pedantry.
 */
export function parsePattern(raw: string): RegExp | null {
  const source = raw.trim();
  if (source.length === 0) return null;

  let body = source;
  let flags = '';

  if (source.startsWith('/')) {
    // Walk back from the end for a `/` that is not escaped. An escaped slash is preceded
    // by an ODD number of backslashes, so the count is what decides — checking only the
    // character immediately before it gets `\\/` wrong.
    let split = -1;
    for (let index = source.length - 1; index > 0; index -= 1) {
      if (source[index] !== '/') continue;
      let backslashes = 0;
      for (let back = index - 1; back >= 0 && source[back] === '\\'; back -= 1) backslashes += 1;
      if (backslashes % 2 === 0) {
        split = index;
        break;
      }
    }
    if (split > 0) {
      body = source.slice(1, split);
      flags = source.slice(split + 1);
    }
  }

  // Only the flags JavaScript actually accepts, and never `y`: sticky matching changes
  // `replace` into a single-position operation, which is not what the preset author
  // meant. An unknown flag is dropped rather than failing the whole pattern.
  const safe = [...flags].filter((flag) => 'gimsu'.includes(flag)).join('');
  const withGlobal = safe.includes('g') ? safe : `${safe}g`;

  try {
    return new RegExp(body, withGlobal);
  } catch {
    return null;
  }
}

/**
 * The scripts in scope for one side and one placement.
 *
 * `minDepth`/`maxDepth` bound a script to messages at a given distance from the end of
 * the conversation, where 0 is the newest. A preset uses this to leave the newest reply
 * alone while still cleaning up the history behind it. Omitted bounds are open.
 */
export function scriptsFor(
  scripts: RegexScript[],
  side: RegexSide,
  placement: number,
  depth: number | null,
): Compiled[] {
  const out: Compiled[] = [];

  for (const script of scripts) {
    if (script.disabled === true) continue;

    // Absent `placement` means AI output: every script in the wild that predates the
    // field targets the reply, and treating absent as "neither" would silently disable
    // half of an older preset.
    const placements = script.placement ?? [PLACEMENT_AI];
    if (!placements.includes(placement)) continue;

    // The axis rule. `promptOnly` excludes the display, `markdownOnly` excludes the
    // prompt, and neither includes both.
    if (side === 'prompt' && script.markdownOnly === true) continue;
    if (side === 'display' && script.promptOnly === true) continue;

    if (depth !== null) {
      if (typeof script.minDepth === 'number' && depth < script.minDepth) continue;
      if (typeof script.maxDepth === 'number' && depth > script.maxDepth) continue;
    }

    const pattern = parsePattern(script.findRegex);
    if (!pattern) continue;
    out.push({
      name: script.scriptName,
      pattern,
      // `{{match}}` is kept as-is here and expanded per match at apply time. Translating
      // it to `$&` eagerly does NOT work: `String.replace` does not re-scan the
      // replacement, so `'x'.replace(/x/, '$&')` is `'$&'` and a preset that wraps a match
      // in markup would emit the literal placeholder.
      replacement: script.replaceString,
    });
  }

  return out;
}

/**
 * Run the scripts in scope over `text`.
 *
 * Sequential, in the preset's own order: ST applies them in list order, and a preset's
 * scripts are written as a pipeline — one strips a wrapper, the next colourises what was
 * inside it. Reordering changes the result.
 */
export function applyScripts(
  text: string,
  scripts: RegexScript[],
  side: RegexSide,
  options: { placement?: number; depth?: number | null } = {},
): string {
  if (text.length === 0 || text.length > MAX_INPUT || scripts.length === 0) return text;

  const compiled = scriptsFor(
    scripts,
    side,
    options.placement ?? PLACEMENT_AI,
    options.depth ?? null,
  );

  let out = text;
  for (const script of compiled) {
    try {
      // `{{match}}` is ST's name for the whole match. It is expanded with a function
      // rather than a replacement string because only a function sees the match, and
      // because a `$` in the preset's own replacement text must stay literal.
      if (script.replacement.includes('{{match}}')) {
        out = out.replace(script.pattern, (match) =>
          script.replacement.replace(/\{\{match\}\}/g, () => match),
        );
      } else {
        out = out.replace(script.pattern, script.replacement);
      }
    } catch {
      // A pattern that compiles can still throw at match time (an invalid replacement
      // reference, a stack limit on a pathological input). Skipping it keeps the rest of
      // the pipeline — and the reply — alive.
      continue;
    }
  }
  return out;
}
