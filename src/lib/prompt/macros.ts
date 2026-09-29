/**
 * Macro substitution.
 *
 * Two tiers, and the split is load-bearing:
 *
 *  - **Fixed macros** (`{{char}}`, `{{user}}`, `{{persona}}`) resolve to the same string
 *    for the life of a chat, so substituting them anywhere — including the cached head —
 *    leaves the prefix byte-identical between turns. Safe everywhere.
 *
 *  - **Dynamic macros** (`{{time}}`, `{{date}}`, `{{weekday}}`, `{{idle}}`) change per
 *    turn. Substituting one into the head rewrites the cached prefix every single turn,
 *    which is the exact anti-pattern this project exists to prevent — a card whose
 *    description contains `{{time}}` would silently destroy caching. These are applied
 *    to the tail only, and `substituteHead` deliberately does NOT apply them.
 *
 * A card that puts `{{time}}` in its description therefore renders the literal text
 * there rather than a timestamp. That is the correct trade: a visible placeholder is a
 * bug someone can report, while a silently dead cache is one nobody notices.
 */

export interface MacroContext {
  char: string;
  /**
   * Null when no persona is set. `{{user}}` is then left as a literal placeholder rather
   * than filled with a pronoun — see the module comment.
   */
  user: string | null;
  /** The persona's own name, when one is set. */
  persona?: string | null;
  /** Set only for tail substitution; absent in the head. */
  now?: Date;
}

/** Matches `{{ name }}` with optional inner whitespace, case-insensitively. */
const MACRO = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitutes the fixed tier. Safe to call on the head.
 *
 * Unknown macros are left untouched rather than blanked: a card using a macro Tessera
 * does not implement should show `{{roll:2d6}}` so the reader knows something is
 * missing, not silently lose a sentence.
 */
export function substituteHead(text: string, context: MacroContext): string {
  return replace(text, (name) => fixedValue(name, context));
}

/**
 * Substitutes the fixed tier AND the dynamic tier. For the tail only — see the module
 * comment for why.
 */
export function substituteTail(text: string, context: MacroContext): string {
  return replace(text, (name) => fixedValue(name, context) ?? dynamicValue(name, context));
}

function replace(text: string, resolve: (name: string) => string | null): string {
  if (text.indexOf('{{') === -1) return text;
  return text.replace(MACRO, (whole, name: string) => resolve(name.toLowerCase()) ?? whole);
}

function fixedValue(name: string, context: MacroContext): string | null {
  switch (name) {
    case 'char':
      return context.char;
    case 'user':
      // Null means "no persona set", which is a reason to leave the placeholder visible
      // rather than a reason to invent a name for the reader.
      return context.user;
    case 'persona':
      return context.persona ?? context.user;
    default:
      return null;
  }
}

function dynamicValue(name: string, context: MacroContext): string | null {
  const now = context.now ?? new Date();
  switch (name) {
    case 'time':
      return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    case 'date':
      return now.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    case 'weekday':
      return now.toLocaleDateString([], { weekday: 'long' });
    case 'isotime':
      return now.toISOString();
    default:
      return null;
  }
}

/** True when the text contains a macro that changes per turn. */
export function hasDynamicMacro(text: string): boolean {
  let found = false;
  replace(text, (name) => {
    if (['time', 'date', 'weekday', 'isotime'].includes(name)) found = true;
    return null;
  });
  return found;
}

/**
 * Reports dynamic macros found in the parts of a prompt that must stay stable.
 *
 * Called by the prefix guard so a card with `{{time}}` in its description produces a
 * named warning instead of a mystery cache collapse.
 */
export function dynamicMacrosIn(text: string): string[] {
  const out: string[] = [];
  replace(text, (name) => {
    if (['time', 'date', 'weekday', 'isotime'].includes(name) && !out.includes(name)) out.push(name);
    return null;
  });
  return out;
}
