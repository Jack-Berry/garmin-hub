import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useFetch } from './useFetch';
import { Icon } from './ui';

const age = (value) => {
  if (!value) return 'Never';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 2) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 2160) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};

export default function StatusChip({ refreshKey }) {
  const { data, error, loading, reload } = useFetch(api.status, [refreshKey]);
  const [open, setOpen] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    const timer = setInterval(reload, 3 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const close = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const hasData = Array.isArray(data?.checks);
  const initialLoading = loading && !hasData;
  const checks = data?.checks || [];
  const warning = checks.find((check) => check.state === 'warn');
  const unknown = checks.find((check) => check.state === 'unknown');
  const problem = error || warning;
  const summary = error ? 'Status check failed' : warning?.reason || unknown?.reason || 'All systems healthy';
  const icon = initialLoading ? 'loader-2' : problem ? 'alert-triangle' : unknown ? 'help-circle' : 'circle-check';

  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-9 max-w-[12rem] items-center gap-1.5 rounded-lg border px-2 font-body text-micro font-semibold uppercase tracking-[0.08em] transition md:h-auto md:max-w-[20rem] md:py-1.5 ${problem ? 'border-sem-amber/50 bg-sem-amber/10 text-sem-amber' : 'border-line text-ink-muted hover:bg-surface-2'}`}
        aria-expanded={open}
        aria-label={`System status: ${initialLoading ? 'loading' : summary}`}
        title={summary}
        data-status-chip
      >
        <Icon name={icon} className={initialLoading ? 'animate-spin' : ''} />
        <span className="hidden truncate md:inline">{initialLoading ? 'Checking' : problem ? summary : 'Status'}</span>
      </button>
      {open && (
        <div className="fixed inset-x-3 top-16 z-50 rounded-xl border border-line bg-surface-1 p-4 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80" role="dialog" aria-label="System status details" data-status-sheet>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold uppercase tracking-[0.12em]">System status</h2>
            <button type="button" onClick={() => setOpen(false)} className="text-ink-muted" aria-label="Close status"><Icon name="x" /></button>
          </div>
          {initialLoading && <p className="text-sm text-ink-muted">Checking jobs...</p>}
          {error && <p className="text-sm text-sem-amber">Status endpoint unavailable: {error.message}</p>}
          {hasData && (
            <ul className="divide-y divide-line">
              {checks.map((check) => (
                <li key={check.name} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
                  <span className={`mt-0.5 h-2 w-2 rounded-full ${check.state === 'warn' ? 'bg-sem-amber' : check.state === 'ok' ? 'bg-ink-muted' : 'border border-ink-muted'}`} />
                  <div className="min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-display text-xs font-bold uppercase tracking-[0.1em]">{check.name}</span>
                      <span className="shrink-0 font-mono text-nano text-ink-muted">{age(check.last_success)}</span>
                    </div>
                    <p className={`mt-1 text-xs ${check.state === 'warn' ? 'text-sem-amber' : 'text-ink-muted'}`}>{check.reason}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
