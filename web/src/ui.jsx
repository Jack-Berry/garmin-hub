// Shared presentational primitives + chart theme constants.

export const ACCENT = '#6366f1'; // indigo-500, reads well on light + dark
export const ACCENT_2 = '#10b981'; // emerald-500
export const AXIS = '#94a3b8'; // slate-400
export const GRID = 'rgba(148,163,184,0.18)';

export function Section({ title, subtitle, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        )}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

// Handles the loading / error / empty states uniformly.
export function StateWrap({ loading, error, empty, children }) {
  if (loading) return <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>;
  if (error)
    return <p className="text-sm text-rose-500">Couldn’t load: {error.message}</p>;
  if (empty) return <p className="text-sm text-slate-400 dark:text-slate-500">No data yet.</p>;
  return children;
}

export function Stat({ label, value, sub }) {
  return (
    <div>
      <div className="text-2xl font-bold tabular-nums tracking-tight text-slate-900 dark:text-slate-100">
        {value}
      </div>
      <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      {sub && <div className="text-xs text-slate-400 dark:text-slate-500">{sub}</div>}
    </div>
  );
}

// "Show more / Show less" pager. Owns nothing — parent holds the visible count.
export function PageMore({ visible, total, base, step, set }) {
  if (total <= base) return null;
  const btn =
    'rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
      <span>
        Showing {Math.min(visible, total)} of {total}
      </span>
      <div className="flex gap-2">
        {visible > base && (
          <button className={btn} onClick={() => set(base)}>
            Show less
          </button>
        )}
        {visible < total && (
          <button className={btn} onClick={() => set(visible + step)}>
            Show more
          </button>
        )}
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
    indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
