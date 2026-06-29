import { useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, ACCENT, ACCENT_2, AXIS, GRID } from '../ui';
import { shortDate, secPerKm, paceFromSecPerKm, kmNum } from '../format';

// Avg pace (min/km) over recent runs, oldest → newest. Y axis is reversed so
// faster paces sit at the top, with an even ~4:30–6:30/km scale.
function RunPace() {
  const { data, loading, error } = useFetch(() => api.activities({ group: 'run', limit: 20 }));
  const rows =
    data &&
    [...data]
      .reverse()
      .map((a) => ({ date: shortDate(a.start_time_local), sec: secPerKm(a.distance_m, a.duration_s) }))
      .filter((r) => r.sec != null);

  return (
    <StateWrap loading={loading} error={error} empty={!rows || !rows.length}>
      {rows && (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
            <YAxis
              reversed
              domain={[270, 390]}
              ticks={[270, 300, 330, 360, 390]}
              allowDataOverflow
              width={56}
              tick={{ fontSize: 11, fill: AXIS }}
              tickLine={false}
              axisLine={false}
              tickFormatter={paceFromSecPerKm}
            />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }}
              formatter={(v) => [paceFromSecPerKm(v), 'Pace']}
            />
            <Line type="monotone" dataKey="sec" stroke={ACCENT} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </StateWrap>
  );
}

// Football is stop-start, so pace is meaningless — show distance covered per
// session over time instead.
function FootballTrend() {
  const { data, loading, error } = useFetch(() => api.activities({ group: 'football', limit: 20 }));
  const rows =
    data &&
    [...data]
      .reverse()
      .map((a) => ({ date: shortDate(a.start_time_local), km: kmNum(a.distance_m) }))
      .filter((r) => r.km != null);

  return (
    <StateWrap loading={loading} error={error} empty={!rows || !rows.length}>
      {rows && (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
            <YAxis
              width={40}
              tick={{ fontSize: 11, fill: AXIS }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}`}
            />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }}
              formatter={(v) => [`${v} km`, 'Distance']}
            />
            <Line type="monotone" dataKey="km" stroke={ACCENT_2} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </StateWrap>
  );
}

const TABS = [
  { key: 'run', label: 'Run' },
  { key: 'football', label: 'Football' },
];

// Per-type activity trend: pace for runs, distance for football.
export default function PaceTrend() {
  const [tab, setTab] = useState('run');

  return (
    <Section
      title="Activity trend"
      subtitle={tab === 'run' ? 'Avg pace, recent runs' : 'Distance per session, recent football'}
    >
      <div className="mb-4 inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1 text-sm font-medium transition ${
              tab === t.key
                ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'run' ? <RunPace /> : <FootballTrend />}
    </Section>
  );
}
