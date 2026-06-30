import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { StateWrap, PageMore, Icon, AXIS, GRID } from '../ui';
import { useAccentHex } from '../accent';
import { shortDate } from '../format';

// The two trend metrics shown as inline sparklines, each expandable to a modal.
// Drawn in the accent — they're the recovery signature, so they follow the picker.
const METRICS = {
  hrv: { label: 'HRV', dataKey: 'hrv_last_night' },
  readiness: { label: 'Readiness', dataKey: 'readiness_score' },
};

const sleepHours = (s) => (s == null ? '—' : `${(s / 3600).toFixed(1)} h`);

// One latest-value entry in the compact number strip. Label in Hanken (uppercase
// eyebrow), value in mono — the design-system data readout.
function StripStat({ label, value }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-body text-micro font-semibold uppercase tracking-[0.14em] text-ink-muted">
        {label}
      </span>
      <span className="font-mono text-body font-medium tabular-nums text-ink">{value}</span>
    </span>
  );
}

// Compact sparkline for a single recovery metric, oldest → newest. Small + fixed
// width so two sit side by side in the horizontal recovery band. Clicking opens
// the full-history MetricModal — hover surfaces an expand cue.
function Spark({ rows, dataKey, color, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Expand ${label} history`}
      className="group w-[84px] cursor-pointer rounded-md text-left transition hover:bg-surface-2"
    >
      <div className="mb-1 flex items-center gap-1 font-body text-micro font-semibold uppercase tracking-[0.14em] text-ink-muted transition group-hover:text-ink-secondary">
        {label}
        <Icon name="arrows-diagonal" className="text-[11px] opacity-0 transition group-hover:opacity-100" />
      </div>
      <ResponsiveContainer width="100%" height={34}>
        <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Tooltip
            contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }}
            labelFormatter={(_, p) => (p && p[0] ? p[0].payload.date : '')}
            formatter={(v) => [v, label]}
          />
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </button>
  );
}

// Large, readable history chart for one recovery metric, opened from a clicked
// sparkline. Reuses the shared modal shell (overlay + card + Escape-to-close).
// Plots the full fetched history oldest → newest with axes, gridlines + dates.
function MetricModal({ metric, rows, onClose }) {
  const accentHex = useAccentHex();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-[0.9375rem] font-bold uppercase tracking-[0.1em] text-ink">
              {metric.label}
            </h2>
            <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
              Last {rows.length} days
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-sm text-ink-secondary transition hover:bg-surface-2"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-5">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis domain={['dataMin', 'dataMax']} width={40} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }} formatter={(v) => [v, metric.label]} />
              <Line type="monotone" dataKey={metric.dataKey} stroke={accentHex} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// Recovery: a slim full-width band — title + HRV/readiness sparklines on the
// left, latest-values strip + Full-history toggle on the right. The day-by-day
// table (7 by default, "Show more" paginates the rest 7 at a time) expands
// inline below the band on click.
export default function Recovery() {
  const accentHex = useAccentHex();
  const { data, loading, error } = useFetch(() => api.recovery({ limit: 30 }));
  const [visible, setVisible] = useState(7);
  const [showHistory, setShowHistory] = useState(false);
  const [metric, setMetric] = useState(null); // expanded sparkline, or null
  const latest = data && data[0];
  // Sparklines stay at the last 14 days, oldest → newest.
  const rows =
    data && [...data.slice(0, 14)].reverse().map((r) => ({ ...r, date: shortDate(r.calendar_date) }));
  // The modal plots the full fetched history (same source as the table below).
  const fullRows =
    data && [...data].reverse().map((r) => ({ ...r, date: shortDate(r.calendar_date) }));
  const shown = data ? data.slice(0, visible) : [];

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface-1">
      <div className="p-5">
        <StateWrap loading={loading} error={error} empty={!data || !data.length}>
          {data && (
            <div className="flex flex-col gap-x-6 gap-y-4 lg:flex-row lg:items-center lg:justify-between">
              {/* Left: title + the two trend sparklines side by side. */}
              <div className="flex items-center gap-5">
                <div className="shrink-0">
                  <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-ink">
                    Recovery trends
                  </h2>
                  <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
                    Last 14 days
                  </p>
                </div>
                <div className="flex items-end gap-4">
                  <Spark rows={rows} dataKey="hrv_last_night" color={accentHex} label="HRV" onClick={() => setMetric(METRICS.hrv)} />
                  <Spark rows={rows} dataKey="readiness_score" color={accentHex} label="Readiness" onClick={() => setMetric(METRICS.readiness)} />
                </div>
              </div>

              {/* Right: latest-values strip + Full-history toggle. The big
                  headline stats now live in the hero metric row, so the strip
                  stays a single compact line here. */}
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-5 lg:justify-end">
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                  <StripStat label="HRV" value={latest.hrv_last_night ?? '—'} />
                  <StripStat label="RHR" value={latest.resting_hr != null ? Math.round(latest.resting_hr) : '—'} />
                  <StripStat label="Sleep" value={sleepHours(latest.sleep_seconds)} />
                  <StripStat label="Readiness" value={latest.readiness_score ?? '—'} />
                </div>
                <button
                  onClick={() => setShowHistory((s) => !s)}
                  className="flex shrink-0 items-center gap-1 font-body text-micro font-semibold uppercase tracking-[0.12em] text-ink-muted transition hover:text-ink-secondary"
                >
                  <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} className="text-sm" />
                  Full history
                </button>
              </div>
            </div>
          )}
        </StateWrap>
      </div>

      {/* Full day-by-day history — collapsed by default, unfolds below the band. */}
      {data && showHistory && (
        <div className="overflow-x-auto border-t border-line px-5 py-4">
          <table className="w-full min-w-[28rem]">
            <thead>
              <tr className="text-left">
                {['Date', 'HRV', 'Rest HR', 'Sleep', 'Readiness'].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-2 font-body text-micro font-semibold uppercase tracking-[0.12em] text-ink-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-body tabular-nums text-ink-secondary">
              {shown.map((r) => (
                <tr key={r.calendar_date} className="border-t border-line">
                  <td className="px-2 py-1.5 whitespace-nowrap">{shortDate(r.calendar_date)}</td>
                  <td className="px-2 py-1.5">{r.hrv_last_night ?? '—'}</td>
                  <td className="px-2 py-1.5">{r.resting_hr != null ? Math.round(r.resting_hr) : '—'}</td>
                  <td className="px-2 py-1.5">{r.sleep_score ?? '—'}</td>
                  <td className="px-2 py-1.5">{r.readiness_score ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <PageMore visible={visible} total={data.length} base={7} step={7} set={setVisible} />
        </div>
      )}

      {metric && fullRows && (
        <MetricModal metric={metric} rows={fullRows} onClose={() => setMetric(null)} />
      )}
    </section>
  );
}
