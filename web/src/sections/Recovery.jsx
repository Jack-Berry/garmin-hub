import { useState } from 'react';
import { ResponsiveContainer, LineChart, Line, YAxis, Tooltip } from 'recharts';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, Stat, PageMore, ACCENT, ACCENT_2 } from '../ui';
import { shortDate } from '../format';

const sleepHours = (s) => (s == null ? '—' : `${(s / 3600).toFixed(1)} h`);

// Compact sparkline for a single recovery metric, oldest → newest.
function Spark({ rows, dataKey, color, label }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <ResponsiveContainer width="100%" height={48}>
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
    </div>
  );
}

// Recovery: latest-day stats, HRV + readiness trends (14d), day-by-day table
// (7 by default, "Show more" paginates the rest 7 at a time).
export default function Recovery() {
  const { data, loading, error } = useFetch(() => api.recovery({ limit: 30 }));
  const [visible, setVisible] = useState(7);
  const latest = data && data[0];
  // Sparklines stay at the last 14 days, oldest → newest.
  const rows =
    data && [...data.slice(0, 14)].reverse().map((r) => ({ ...r, date: shortDate(r.calendar_date) }));
  const shown = data ? data.slice(0, visible) : [];

  return (
    <Section title="Recovery" subtitle="HRV, resting HR, sleep & readiness">
      <StateWrap loading={loading} error={error} empty={!data || !data.length}>
        {data && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="HRV (last night)" value={latest.hrv_last_night ?? '—'} sub={latest.hrv_status} />
              <Stat label="Resting HR" value={latest.resting_hr != null ? Math.round(latest.resting_hr) : '—'} />
              <Stat label="Sleep score" value={latest.sleep_score ?? '—'} sub={sleepHours(latest.sleep_seconds)} />
              <Stat label="Readiness" value={latest.readiness_score ?? '—'} sub={latest.readiness_level} />
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Spark rows={rows} dataKey="hrv_last_night" color={ACCENT} label="HRV trend" />
              <Spark rows={rows} dataKey="readiness_score" color={ACCENT_2} label="Readiness trend" />
            </div>

            <div className="-mx-2 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead className="text-slate-500 dark:text-slate-400">
                  <tr className="text-left">
                    <th className="px-2 py-2 font-medium">Date</th>
                    <th className="px-2 py-2 font-medium">HRV</th>
                    <th className="px-2 py-2 font-medium">Rest HR</th>
                    <th className="px-2 py-2 font-medium">Sleep</th>
                    <th className="px-2 py-2 font-medium">Readiness</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {shown.map((r) => (
                    <tr key={r.calendar_date} className="border-t border-slate-100 dark:border-slate-800">
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
          </div>
        )}
      </StateWrap>
    </Section>
  );
}
