import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Markdown } from '../ui';
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
    'rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-600 disabled:opacity-60';
  const navBtn =
    'flex h-9 w-9 items-center justify-center rounded-full border border-slate-300 text-lg text-slate-600 transition hover:bg-slate-100 disabled:opacity-30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';
  const reportBtn =
    'rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';

  const reportLabel =
    report.status === 'loading'
      ? 'Generating…'
      : report.status === 'done'
        ? (showReport ? 'Hide detailed report' : 'Show detailed report')
        : '📋 Detailed report';

  return (
    <section className="overflow-hidden rounded-2xl border border-l-4 border-slate-200 border-l-indigo-500 bg-white shadow-sm dark:border-slate-800 dark:border-l-indigo-500 dark:bg-slate-900">
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-4 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
            Coach's Daily Brief
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {card ? shortDate(card.created_at) : 'A quick read on your training'}
          </p>
        </div>
        <button
          onClick={regenerate}
          disabled={gen === 'running'}
          className={genBtn}
          aria-label="Generate today's brief"
        >
          <span className={gen === 'running' ? 'mr-1 inline-block animate-spin' : 'hidden'}>⟳</span>
          {gen === 'running' ? 'Thinking…' : card ? '⟳ Regenerate' : "Generate today's brief"}
        </button>
      </header>

      <div className="px-6 py-6">
        {loading ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
        ) : error ? (
          <p className="text-sm text-rose-500">Couldn't load: {error.message}</p>
        ) : card ? (
          <>
            <Markdown className="text-[17px] leading-relaxed text-slate-800 dark:text-slate-200">
              {card.content}
            </Markdown>

            {/* On-demand detailed report — only on the most recent brief, since
                the report always reflects current training context. */}
            {safeIdx === 0 && (
              <div className="mt-5">
                <button onClick={toggleReport} disabled={report.status === 'loading'} className={reportBtn}>
                  <span className={report.status === 'loading' ? 'mr-1 inline-block animate-spin' : 'hidden'}>⟳</span>
                  {reportLabel}
                </button>

                {showReport && report.status !== 'idle' && (
                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-5 dark:border-slate-800 dark:bg-slate-950/40">
                    {report.status === 'loading' ? (
                      <p className="text-sm text-slate-400 dark:text-slate-500">Analysing your recent training…</p>
                    ) : report.status === 'error' ? (
                      <p className="text-sm text-rose-500">Couldn't generate: {report.error}</p>
                    ) : (
                      <>
                        <Markdown className="text-[15px] leading-relaxed text-slate-700 dark:text-slate-300">
                          {report.content}
                        </Markdown>
                        {report.model && (
                          <p className="mt-4 text-[11px] text-slate-400 dark:text-slate-500">{report.model}</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-[15px] leading-relaxed text-slate-600 dark:text-slate-300">
            No brief yet. Generate today's for a quick read on your recent training.
          </p>
        )}
        {gen === 'error' && (
          <p className="mt-3 text-xs text-rose-500">Couldn't generate, check the server logs.</p>
        )}
      </div>

      {cards.length > 1 && (
        <footer className="flex items-center justify-between border-t border-slate-100 px-6 py-3 dark:border-slate-800">
          <button
            onClick={() => setIdx((i) => i + 1)}
            disabled={safeIdx >= cards.length - 1}
            className={navBtn}
            aria-label="Older brief"
          >
            ‹
          </button>
          <span className="text-xs text-slate-500 dark:text-slate-400">
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
