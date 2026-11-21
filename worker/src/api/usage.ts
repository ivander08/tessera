import { json, notFound } from '../http';

/**
 * `GET /api/usage` — the cache meter and the money, aggregated from stored turns.
 *
 * Every number here is a sum over `messages` rows, not an estimate and not a price
 * table: `prompt_tokens`, `cached_tokens` and `cost_usd` are the provider's own report
 * for the turn that wrote the row, and the turn's `cost_usd` already carries whatever
 * markup the provider applied. That is why this screen can be honest where an
 * estimate would drift the moment a model changed.
 *
 * The window is anchored to UTC midnight rather than a sliding 30×24h: `byDay` is a
 * calendar list, and a rolling window would make the first and last buckets partial,
 * so their totals would contradict the period figure printed above them.
 */

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
/** A leaderboard, not a report: past ten scenes the tail stops being a comparison. */
const TOP_CHATS = 10;

/** A "turn" is an assistant row the provider actually billed. Greetings and hand-written
 *  replies carry no usage, and counting them would inflate turns while leaving spend
 *  behind — the exact mismatch this dashboard exists to avoid. */
const USAGE_ROW = `role = 'assistant' AND deleted = 0
  AND (prompt_tokens IS NOT NULL OR cached_tokens IS NOT NULL OR cost_usd IS NOT NULL)`;

interface TotalsRow {
  turns: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  spendUsd: number | null;
}

interface DayRow extends TotalsRow {
  day: string;
}

interface ChatRow extends TotalsRow {
  chatId: string;
  title: string | null;
  characterName: string | null;
}

interface UsageTotals {
  turns: number;
  promptTokens: number;
  cachedTokens: number;
  /** Fraction, not percent: the client decides how it is written. */
  hitRate: number;
  spendUsd: number;
}

function totals(row: TotalsRow | undefined): UsageTotals {
  const promptTokens = row?.promptTokens ?? 0;
  const cachedTokens = row?.cachedTokens ?? 0;
  return {
    turns: row?.turns ?? 0,
    promptTokens,
    cachedTokens,
    // Zero rather than NaN when a turn reported a cost but no prompt tokens. Rounded to
    // four decimals: a turn can cost a fraction of a cent, and cents would report a
    // month of cheap turns as free.
    hitRate: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 10_000) / 10_000 : 0,
    spendUsd: Math.round((row?.spendUsd ?? 0) * 10_000) / 10_000,
  };
}

export async function usageRoute(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return usageSummary(env);
}

async function usageSummary(env: Env): Promise<Response> {
  const now = Date.now();
  // Inclusive of today, so a quiet morning still gets its own bucket rather than
  // shifting the table a day.
  const windowStart = Math.floor(now / DAY_MS) * DAY_MS - (WINDOW_DAYS - 1) * DAY_MS;

  // One grouped query per section. The all-time total has no window by definition; the
  // other two are filtered on `created_at` so a long-lived database does not get fully
  // scanned to answer "what did the last month cost".
  const [allTime, period, days, chats] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS turns,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(cost_usd), 0) AS spendUsd
         FROM messages
        WHERE ${USAGE_ROW}`,
    ).all<TotalsRow>(),

    env.DB.prepare(
      `SELECT COUNT(*) AS turns,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(cost_usd), 0) AS spendUsd
         FROM messages
        WHERE ${USAGE_ROW} AND created_at >= ?1`,
    )
      .bind(windowStart)
      .all<TotalsRow>(),

    // `created_at` is milliseconds; SQLite's unixepoch wants seconds. Integer division
    // is exact here because both operands are integers.
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS turns,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(cost_usd), 0) AS spendUsd
         FROM messages
        WHERE ${USAGE_ROW} AND created_at >= ?1
        GROUP BY day
        ORDER BY day`,
    )
      .bind(windowStart)
      .all<DayRow>(),

    env.DB.prepare(
      `SELECT m.chat_id AS chatId,
              c.title AS title,
              ch.name AS characterName,
              COUNT(*) AS turns,
              COALESCE(SUM(m.prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(m.cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(m.cost_usd), 0) AS spendUsd
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         LEFT JOIN characters ch ON ch.id = c.character_id
        WHERE m.role = 'assistant' AND m.deleted = 0
          AND (m.prompt_tokens IS NOT NULL OR m.cached_tokens IS NOT NULL OR m.cost_usd IS NOT NULL)
        GROUP BY m.chat_id
        ORDER BY spendUsd DESC
        LIMIT ?1`,
    )
      .bind(TOP_CHATS)
      .all<ChatRow>(),
  ]);

  // Zero-filled because a gap in the table reads as missing data, not as a day without
  // turns. The window is walked from the same anchor the SQL used, so every bucket the
  // query can return has a home and no day is silently dropped.
  const byDay = new Map(days.results.map((row) => [row.day, row]));
  const series = Array.from({ length: WINDOW_DAYS }, (_, index) => {
    // UTC is the bucket the SQL grouped on, so the key must not be built from local time.
    const day = new Date(windowStart + index * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(day);
    const summed = totals(row);
    return { day, spendUsd: summed.spendUsd, hitRate: summed.hitRate, turns: summed.turns };
  });

  return json({
    totals: totals(allTime.results[0]),
    period: totals(period.results[0]),
    byDay: series,
    topChats: chats.results.map((row) => {
      const summed = totals(row);
      return {
        chatId: row.chatId,
        title: row.title,
        characterName: row.characterName,
        turns: summed.turns,
        spendUsd: summed.spendUsd,
        hitRate: summed.hitRate,
      };
    }),
  });
}
