import { badRequest, json, readJson } from '../http';
import { asRecord, asString, asStringArray } from '../../../src/lib/json';
import { estimateTokens } from '../../../src/lib/tokenEstimate';
import { analyzeTokenCost } from '../../../src/lib/forge/tokenCost';
import { draftCard } from './draft';
import { critiqueCard, findSmuggledInstructions } from './critique';
import { suggestField, type SuggestField } from './tokens';
import type { ParsedCard } from '../../../src/lib/cards/types';

/**
 * The M6 forge tools, over HTTP.
 *
 * Every handler here is a translation of a request body into the argument list of a
 * function that already exists and is already tested. No prompt, no validation rule and
 * no card mapping lives in this file — a second copy of any of those is the copy that
 * drifts away from the one the tests cover.
 *
 * Two of the five need no model at all. `forgeTokens` is arithmetic and `forgeSmuggle`
 * is the deterministic half of the critique, so both work on a fresh install with no
 * provider key and no cheap model configured — which is the point of separating them
 * from the calls that cost money.
 */

/** The four card formats `characters.source_format` can hold. */
const FORMATS: Record<string, ParsedCard['sourceFormat']> = {
  ccv2: 'ccv2',
  ccv3: 'ccv3',
  charx: 'charx',
  byaf: 'byaf',
};

const SUGGEST_FIELDS: SuggestField[] = ['tags', 'alternate_greetings', 'first_mes'];

function isSuggestField(value: string): value is SuggestField {
  return (SUGGEST_FIELDS as string[]).includes(value);
}

/**
 * Coerces a card that crossed the wire into the shape the forge functions take.
 *
 * A card arrives either from `characters.card_json` (camelCase, no `raw`) or from the
 * browser's editor (a `ParsedCard`, with `raw`). Both are the same card; the difference
 * is provenance. Fields are defaulted rather than asserted because `analyzeTokenCost`
 * hands every value to a token counter, and `undefined.length` is a 500 rather than a
 * message about the card.
 */
function asCard(value: unknown): ParsedCard | null {
  const record = asRecord(value);
  if (!record) return null;

  const name = asString(record.name).trim();
  if (name.length === 0) return null;

  return {
    name,
    description: asString(record.description),
    personality: asString(record.personality),
    scenario: asString(record.scenario),
    firstMes: asString(record.firstMes),
    mesExample: asString(record.mesExample),
    systemPrompt: asString(record.systemPrompt),
    postHistoryInstructions: asString(record.postHistoryInstructions),
    alternateGreetings: asStringArray(record.alternateGreetings),
    creatorNotes: asString(record.creatorNotes),
    tags: asStringArray(record.tags),
    characterBook: record.characterBook ?? null,
    sourceFormat: FORMATS[asString(record.sourceFormat)] ?? 'ccv2',
    avatarHint: asString(record.avatarHint) || null,
    raw: record.raw ?? null,
  };
}

/**
 * Every model-backed tool fails the same way when nothing is configured: `complete()`
 * throws with a message naming the setting to fix. That is a client-side configuration
 * problem, so it is reported as a 400 with the underlying message intact rather than as
 * a 500 the user cannot act on.
 */
function failed(error: unknown): Response {
  return badRequest(error instanceof Error ? error.message : String(error));
}

/** `POST /api/forge/draft` — `{ description }` → the drafted card. */
export async function forgeDraft(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ description?: unknown }>(req);
  const description = asString(body?.description).trim();
  if (description.length === 0) return badRequest('description required');

  try {
    return json(await draftCard(env, description));
  } catch (error) {
    return failed(error);
  }
}

/**
 * `POST /api/forge/critique` — `{ card }` → `{ critique, smuggledInstructions }`.
 *
 * The returned list is the deterministic scan first, then whatever the model adds:
 * `critiqueCard` merges them in that order so the reproducible findings survive a model
 * that overlooks them.
 */
export async function forgeCritique(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ card?: unknown }>(req);
  const card = asCard(body?.card);
  if (!card) return badRequest('card with a name required');

  try {
    return json(await critiqueCard(env, card));
  } catch (error) {
    return failed(error);
  }
}

/**
 * `POST /api/forge/smuggle` — `{ card }` → `{ smuggledInstructions }`.
 *
 * The deterministic half of the critique on its own, with no model and no cost. It is
 * separate because it is the headline finding and the only part of the critique that is
 * reproducible: the same card always yields the same list, so it can be read before
 * anything is spent, and it still works when nothing is configured.
 */
export async function forgeSmuggle(_env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ card?: unknown }>(req);
  const card = asCard(body?.card);
  if (!card) return badRequest('card with a name required');

  return json({ smuggledInstructions: findSmuggledInstructions(card) });
}

/**
 * `POST /api/forge/tokens` — `{ card }` → the `TokenCostReport`.
 *
 * Pure arithmetic on the Worker's estimator, so there is no model call and nothing to
 * configure. The estimator is the approximate one (`src/lib/tokenEstimate.ts`) because
 * `js-tiktoken` cannot load in a Worker; the browser's exact count is a few percent
 * different, which is why the UI says which one produced a number.
 */
export async function forgeTokens(_env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ card?: unknown }>(req);
  const card = asCard(body?.card);
  if (!card) return badRequest('card with a name required');

  return json(analyzeTokenCost(card, estimateTokens));
}

/** `POST /api/forge/suggest` — `{ card, field }` → `{ suggestions }`. */
export async function forgeSuggest(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ card?: unknown; field?: unknown }>(req);
  const card = asCard(body?.card);
  if (!card) return badRequest('card with a name required');

  const field = asString(body?.field);
  if (!isSuggestField(field)) {
    return badRequest(`field must be one of ${SUGGEST_FIELDS.join(', ')}`);
  }

  try {
    return json({ suggestions: await suggestField(env, card, field) });
  } catch (error) {
    return failed(error);
  }
}

/**
 * `GET /api/forge/cards` — the stored cards, whole.
 *
 * The critique and token tools act on a card that already exists, and nothing else
 * returns `card_json`: the character list carries summaries only. Rows whose card
 * cannot be read are dropped rather than sent half-formed, because a card with no name
 * cannot be critiqued and a broken one would only fail later, further from the cause.
 */
export async function forgeCards(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, card_json, source_format FROM characters ORDER BY created_at DESC',
  ).all<{ id: string; name: string; card_json: string; source_format: string }>();

  const cards: Array<{ id: string; name: string; card: ParsedCard }> = [];

  for (const row of results) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.card_json);
    } catch {
      continue;
    }

    const card = asCard(parsed);
    if (!card) continue;

    // The format lives in its own column, so a card imported as CharX still reports it.
    cards.push({
      id: row.id,
      name: row.name,
      card: { ...card, sourceFormat: FORMATS[row.source_format] ?? 'ccv2' },
    });
  }

  return json(cards);
}
