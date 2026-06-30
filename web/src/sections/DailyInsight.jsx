import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Markdown, Icon } from '../ui';
import { shortDate } from '../format';

// Daily coach brief — a slim 2-3 sentence glance at the top of the dashboard.
// One card per calendar day (latest brief wins if regenerated), newest first,
// up to the last 7 days. Regenerate fires POST /api/coach/daily (Sonnet, cheap).
// The deeper Recovery/Training/Mileage report is on-demand below (Opus), via
// POST /api/coach/report — stateless, generated only when the button is clicked.

// Collapse notes to one-per-day (newest id wins, already DESC-ordered) and keep
// the most recent 7 days.
function oneCardPerDay(notes) {
  const byDay = new Map();
  for (const n of notes) {
    const day = (n.created_at || '').slice(0, 10);
    if (day && !byDay.has(day)) byDay.set(day, n);
  }
  return [...byDay.values()].slice(0, 7);
}

export default function DailyInsight() {
  const { data, loading, error, reload } = useFetch(() =>
    api.coachNotes({ note_type: 'daily', limit: 30 })
  );
  const [idx, setIdx] = useState(0);
  const [gen, setGen] = useState('idle'); // 'idle' | 'running' | 'error'
  // On-demand detailed report. Cached in component once fetched; the button
  // then toggles visibility without re-spending.
  const [report, setReport] = useState({ status: 'idle', content: '', model: null, error: null });
  const [showReport, setShowReport] = useState(false);

  const cards = data ? oneCardPerDay(data) : [];
  const safeIdx = Math.min(idx, Math.max(0, cards.length - 1));
  const card = cards[safeIdx];

  const regenerate = async () => {
    if (gen === 'running') return;
    setGen('running');
    try {
      await api.generateDaily();
      setIdx(0); // newest (today) becomes the primary card
      reload();
      setGen('idle');
    } catch {
      setGen('error');
      setTimeout(() => setGen('idle'), 5000);
    }
  };

  const toggleReport = async () => {
    if (report.status === 'done') return setShowReport((s) => !s);
    if (report.status === 'loading') return;
    setShowReport(true);
    setReport({ status: 'loading', content: '', model: null, error: null });
    try {
      const r = await api.coachReport();
      setReport({ status: 'done', content: r.content, model: r.model, error: null });
    } catch (e) {
      setReport({ status: 'error', content: '', model: null, error: e.message });
    }
  };

  const genBtn =
    'inline-flex items-center gap-1.5 font-body text-label font-bold uppercase tracking-[0.14em] text-acc transition hover:opacity-80 disabled:opacity-50';
  const navBtn =
    'flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-secondary transition hover:bg-surface-2 disabled:opacity-30';
  const reportBtn =
    'inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-body text-micro font-semibold uppercase tracking-[0.1em] text-ink-secondary transition hover:bg-surface-2 disabled:opacity-60';

  const reportLabel =
    report.status === 'loading'
      ? 'Generating…'
      : report.status === 'done'
        ? (showReport ? 'Hide detailed report' : 'Show detailed report')
        : 'Detailed report';

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface-1">
      <header className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
        <div>
          <h2 className="font-body text-label font-bold uppercase tracking-[0.16em] text-acc">
            Coach's Daily Brief
          </h2>
          <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
            {card ? shortDate(card.created_at) : 'A quick read on your training'}
          </p>
        </div>
        <button
          onClick={regenerate}
          disabled={gen === 'running'}
          className={genBtn}
          aria-label="Generate today's brief"
        >
          <Icon name="refresh" className={gen === 'running' ? 'animate-spin' : ''} />
          {gen === 'running' ? 'Thinking…' : card ? 'Regenerate' : "Generate today's brief"}
        </button>
      </header>

      <div className="px-6 pb-6">
        {loading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : error ? (
          <p className="text-sm text-sem-red">Couldn't load: {error.message}</p>
        ) : card ? (
          <>
            <Markdown className="font-body text-[17px] leading-relaxed text-ink [&_strong]:font-semibold [&_strong]:text-acc">
              {card.content}
            </Markdown>

            {/* On-demand detailed report — only on the most recent brief, since
                the report always reflects current training context. */}
            {safeIdx === 0 && (
              <div className="mt-5">
                <button onClick={toggleReport} disabled={report.status === 'loading'} className={reportBtn}>
                  <Icon name={report.status === 'loading' ? 'refresh' : 'file-text'} className={report.status === 'loading' ? 'animate-spin' : ''} />
                  {reportLabel}
                </button>

                {showReport && report.status !== 'idle' && (
                  <div className="mt-4 rounded-xl border border-line bg-surface-2 p-5">
                    {report.status === 'loading' ? (
                      <p className="text-sm text-ink-muted">Analysing your recent training…</p>
                    ) : report.status === 'error' ? (
                      <p className="text-sm text-sem-red">Couldn't generate: {report.error}</p>
                    ) : (
                      <>
                        <Markdown className="font-body text-[15px] leading-relaxed text-ink-secondary">
                          {report.content}
                        </Markdown>
                        {report.model && (
                          <p className="mt-4 font-mono text-micro text-ink-muted">{report.model}</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="font-body text-[15px] leading-relaxed text-ink-secondary">
            No brief yet. Generate today's for a quick read on your recent training.
          </p>
        )}
        {gen === 'error' && (
          <p className="mt-3 text-xs text-sem-red">Couldn't generate, check the server logs.</p>
        )}
      </div>

      {cards.length > 1 && (
        <footer className="flex items-center justify-between border-t border-line px-6 py-3">
          <button
            onClick={() => setIdx((i) => i + 1)}
            disabled={safeIdx >= cards.length - 1}
            className={navBtn}
            aria-label="Older brief"
          >
            ‹
          </button>
          <span className="font-body text-micro uppercase tracking-[0.12em] text-ink-muted">
            {safeIdx === 0 ? 'Most recent' : `${safeIdx + 1} of ${cards.length}`}
          </span>
          <button
            onClick={() => setIdx((i) => i - 1)}
            disabled={safeIdx <= 0}
            className={navBtn}
            aria-label="Newer brief"
          >
            ›
          </button>
        </footer>
      )}
    </section>
  );
}
