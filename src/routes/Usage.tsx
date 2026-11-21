import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';

/**
 * Usage.
 *
 * The one screen that shows what caching is worth. Every figure is the provider's own
 * report summed out of the transcript — `cached_tokens / prompt_tokens` per turn — so
 * the percentage here is the same one the chat menu shows for the latest reply, only
 * over every reply in the range. Nothing is estimated and no price is assumed: a turn
 * the provider did not bill for simply has no `cost_usd`, and is absent from the money.
 */

interface Bucket {
  turns: number;
  promptTokens: number;
  cachedTokens: number;
  /** Fraction, not percent. */
  hitRate: number;
  spendUsd: number;
}

interface DayPoint {
  day: string;
  spendUsd: number;
  hitRate: number;
  turns: number;
}

interface ChatTotals {
  chatId: string;
  title: string | null;
  characterName: string | null;
  turns: number;
  spendUsd: number;
  hitRate: number;
}

interface UsagePayload {
  totals: Bucket;
  /** The last 30 days, UTC calendar days. */
  period: Bucket;
  byDay: DayPoint[];
  topChats: ChatTotals[];
}

// `maximumFractionDigits: 4` because a turn can cost a fraction of a cent; two is the
// floor so a whole-dollar figure does not read as an integer.
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });
const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** 12.4k rather than 12403: the exact token count is not something a reader acts on. */
function compactTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <div className="data" style={{ fontSize: 'var(--text-xl)', marginTop: 6 }}>
        {value}
      </div>
      {note && (
        <p className="form-hint" style={{ margin: '2px 0 0' }}>
          {note}
        </p>
      )}
    </div>
  );
}

export default function Usage() {
  const { data, error, loading } = useAsync(() => apiJson<UsagePayload>('/api/usage'), []);

  return (
    <>
      <AppBar title={<span className="bar-title">Usage</span>} />

      <main className="sheet">
        <div className="sheet-head">
          <div>
            <h1 className="title">Usage</h1>
            <p className="sheet-sub">What your turns cost, and how much the cache saved.</p>
          </div>
        </div>

        {loading && !data && (
          <p className="form-hint" role="status">
            Loading…
          </p>
        )}
        {error && <div className="note danger">{error}</div>}

        {data && data.totals.turns === 0 && (
          <div className="empty">
            <span className="eyebrow" style={{ display: 'block' }}>
              No turns yet
            </span>
            <p style={{ margin: '12px auto 0', maxWidth: '46ch' }}>
              Usage appears after your first reply.
            </p>
          </div>
        )}

        {data && data.totals.turns > 0 && (
          <>
            <div
              className="panel panel-pad"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 18,
              }}
            >
              <Figure
                label="Last 30 days"
                value={money.format(data.period.spendUsd)}
                note={`${data.period.turns} ${data.period.turns === 1 ? 'turn' : 'turns'}`}
              />
              <Figure
                label="Cache hit rate"
                value={percent.format(data.totals.hitRate)}
                note={`${compactTokens(data.totals.cachedTokens)} of ${compactTokens(
                  data.totals.promptTokens,
                )} prompt tokens`}
              />
              <Figure
                label="Turns"
                value={compactTokens(data.totals.turns)}
                note={`${money.format(data.totals.spendUsd)} all time`}
              />
            </div>

            <section className="section">
              <span className="eyebrow">Last 30 days</span>

              <div
                className="grid items-center gap-3"
                style={{
                  gridTemplateColumns: '4.5rem 3rem 1fr 5.5rem',
                  padding: '0 12px 6px',
                }}
              >
                <span className="eyebrow">Day</span>
                <span className="eyebrow" style={{ textAlign: 'right' }}>
                  Turns
                </span>
                <span className="eyebrow">Cache</span>
                <span className="eyebrow" style={{ textAlign: 'right' }}>
                  Spend
                </span>
              </div>

              <div className="panel">
                {data.byDay.map((point) => (
                  <div
                    key={point.day}
                    className="grid items-center gap-3"
                    style={{
                      gridTemplateColumns: '4.5rem 3rem 1fr 5.5rem',
                      padding: '8px 12px',
                      borderTop: '1px solid var(--line)',
                    }}
                  >
                    <span className="data" style={{ color: 'var(--ink-dim)' }}>
                      {dayLabel.format(new Date(`${point.day}T00:00:00Z`))}
                    </span>
                    <span className="data" style={{ textAlign: 'right', color: 'var(--ink-dim)' }}>
                      {point.turns}
                    </span>
                    {/* A bar needs no library: the width IS the number. The strip behind
                        it marks the full track, so a low day still reads as low rather
                        than as a short row. */}
                    <span className="flex items-center gap-2">
                      <span className="data" style={{ minWidth: '2.5rem' }}>
                        {percent.format(point.hitRate)}
                      </span>
                      <span
                        aria-hidden="true"
                        className="flex-1"
                        style={{ height: 5, borderRadius: 999, background: 'var(--line)' }}
                      >
                        <span
                          style={{
                            display: 'block',
                            width: `${Math.min(100, point.hitRate * 100)}%`,
                            height: '100%',
                            borderRadius: 999,
                            background: 'var(--verdigris)',
                          }}
                        />
                      </span>
                    </span>
                    <span className="data" style={{ textAlign: 'right' }}>
                      {money.format(point.spendUsd)}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="section">
              <span className="eyebrow">Busiest scenes</span>

              {data.topChats.map((chat) => {
                const title = chat.title ?? chat.characterName ?? 'Untitled scene';
                return (
                  <Link key={chat.chatId} to={`/chat/${chat.chatId}`} className="pick-row">
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate"
                        style={{ fontWeight: 600 }}
                        title={title}
                      >
                        {title}
                      </span>
                      <span
                        className="data mt-0.5 block"
                        style={{ color: 'var(--ink-dim)' }}
                      >
                        {chat.turns} {chat.turns === 1 ? 'turn' : 'turns'} ·{' '}
                        {percent.format(chat.hitRate)} cached
                      </span>
                    </span>
                    <span className="data" style={{ color: 'var(--ink-dim)' }}>
                      {money.format(chat.spendUsd)}
                    </span>
                  </Link>
                );
              })}
            </section>
          </>
        )}
      </main>
    </>
  );
}
