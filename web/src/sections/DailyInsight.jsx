import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Markdown } from '../ui';
import { shortDate } from '../format';

// Hero carousel of the AI coach's daily insights — the prominent top-of-page
// element. One card per calendar day (latest insight wins if a day was
// regenerated), newest first, up to the last 7 days. Only days that actually
// have an insight get a card — no fabricated placeholders. A Regenerate button
// fires POST /api/coach/daily (Opus, ~5-10s) and refreshes on success.

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

  const genBtn =
    'rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-600 disabled:opacity-60';
  const navBtn =
    'flex h-9 w-9 items-center justify-center rounded-full border border-slate-300 text-lg text-slate-600 transition hover:bg-slate-100 disabled:opacity-30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';

  // The coach emits a bold one-line TL;DR as the first block; split it off so it
  // can be given its own prominent styling, with the rest rendered below.
  let tldr = null;
  let body = null;
  if (card) {
    const trimmed = card.content.trim();
    const at = trimmed.indexOf('\n\n');
    tldr = at === -1 ? trimmed : trimmed.slice(0, at);
    body = at === -1 ? '' : trimmed.slice(at + 2);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-l-4 border-slate-200 border-l-indigo-500 bg-white shadow-sm dark:border-slate-800 dark:border-l-indigo-500 dark:bg-slate-900">
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-4 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
            Coach's Daily Insight
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {card ? shortDate(card.created_at) : 'AI analysis of your recent training'}
          </p>
        </div>
        <button
          onClick={regenerate}
          disabled={gen === 'running'}
          className={genBtn}
          aria-label="Generate today's insight"
        >
          <span className={gen === 'running' ? 'mr-1 inline-block animate-spin' : 'hidden'}>⟳</span>
          {gen === 'running' ? 'Thinking…' : card ? '⟳ Regenerate' : "Generate today's insight"}
        </button>
      </header>

      <div className="px-6 py-6">
        {loading ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
        ) : error ? (
          <p className="text-sm text-rose-500">Couldn't load: {error.message}</p>
        ) : card ? (
          <>
            <Markdown className="text-lg font-semibold leading-snug text-slate-900 dark:text-slate-100">
              {tldr}
            </Markdown>
            {body && (
              <Markdown className="mt-4 text-[15px] leading-relaxed text-slate-700 dark:text-slate-300">
                {body}
              </Markdown>
            )}
            <p className="mt-5 text-[11px] text-slate-400 dark:text-slate-500">
              {card.model} · context {card.date_range_start} to {card.date_range_end}
            </p>
          </>
        ) : (
          <p className="text-[15px] leading-relaxed text-slate-600 dark:text-slate-300">
            No insights yet. Generate today's to get the coach's read on your recent training.
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
            aria-label="Older insight"
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
            aria-label="Newer insight"
          >
            ›
          </button>
        </footer>
      )}
    </section>
  );
}
