import { useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, AXIS, GRID, INK } from '../ui';
import { useAccentHex } from '../accent';

const dateLabel = (value) => value?.slice(5) || '';
const signed = (seconds) => {
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(Math.round(seconds));
  return `${sign}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function FitnessChart() {
  const [windowDays, setWindowDays] = useState(84);
  const fitness = useFetch(() => api.fitness(windowDays), [windowDays]);
  return (
    <Section title="Fitness and fatigue" subtitle="Derived from Garmin training load">
      <StateWrap loading={fitness.loading} error={fitness.error} empty={fitness.data && !fitness.data.series?.length}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex gap-1" role="group" aria-label="Fitness chart window">
            {[[42, '6 weeks'], [84, '3 months'], [180, '6 months']].map(([days, label]) => (
              <button key={days} onClick={() => setWindowDays(days)} className={`rounded-md px-2 py-1 font-body text-nano font-semibold uppercase tracking-[0.08em] ${windowDays === days ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-3 font-mono text-nano text-ink-muted"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-ink" />CTL</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-ink-muted" />ATL</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-sem-amber" />TSB</span></div>
        </div>
        <div className="h-56 min-w-0 sm:h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={fitness.data?.series || []} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
              <defs><linearGradient id="tsbFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d5a83c" stopOpacity={0.28} /><stop offset="100%" stopColor="#d5a83c" stopOpacity={0.03} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fontSize: 10, fill: AXIS }} tickLine={false} axisLine={false} minTickGap={22} />
              <YAxis tick={{ fontSize: 10, fill: AXIS }} tickLine={false} axisLine={false} />
              <Tooltip labelFormatter={(v) => v} contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }} />
              <Area type="monotone" dataKey="tsb" stroke="#d5a83c" fill="url(#tsbFill)" strokeWidth={1.5} />
              <Line type="monotone" dataKey="ctl" stroke={INK} dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="atl" stroke="#b5b5bd" dot={false} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </StateWrap>
    </Section>
  );
}

const predictionLabels = { '5k': '5K', '10k': '10K', half: 'Half', marathon: 'Marathon' };
function PredictionChart() {
  const [distance, setDistance] = useState('5k');
  const predictions = useFetch(() => api.predictionHistory(180));
  const rows = predictions.data?.series || [];
  const values = rows.map((row) => row[distance]).filter((v) => v != null);
  const change = values.length > 1 ? values.at(-1) - values[0] : null;
  return (
    <Section title="Race prediction history" subtitle="Garmin predictions, lower is faster">
      <StateWrap loading={predictions.loading} error={predictions.error} empty={predictions.data && !rows.length}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex gap-1" role="group" aria-label="Prediction distance">
            {Object.entries(predictionLabels).map(([key, label]) => (
              <button key={key} onClick={() => setDistance(key)} className={`rounded-md px-2 py-1 font-body text-nano font-semibold uppercase tracking-[0.08em] ${distance === key ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:text-ink'}`}>{label}</button>
            ))}
          </div>
          {change != null && <span className={`font-mono text-nano ${change <= 0 ? 'text-acc' : 'text-ink-muted'}`}>{change <= 0 ? 'down' : 'up'} {signed(change)} since {rows.find((r) => r[distance] != null)?.date}</span>}
        </div>
        <div className="h-56 min-w-0 sm:h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fontSize: 10, fill: AXIS }} tickLine={false} axisLine={false} minTickGap={22} />
              <YAxis reversed tickFormatter={(v) => signed(v)} tick={{ fontSize: 10, fill: AXIS }} tickLine={false} axisLine={false} />
              <Tooltip labelFormatter={(v) => v} formatter={(v) => [signed(v), predictionLabels[distance]]} contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }} />
              <Line type="monotone" dataKey={distance} stroke={useAccentHex()} dot={false} connectNulls strokeWidth={2.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </StateWrap>
    </Section>
  );
}

export default function TrendsCharts() {
  return <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-5 lg:grid-cols-2"><FitnessChart /><PredictionChart /></div>;
}

export function RaceCountdown() {
  const countdown = useFetch(() => api.raceCountdown());
  if (countdown.loading) return <p className="px-1 text-sm text-ink-muted">Loading race countdown…</p>;
  if (countdown.error) return <p className="px-1 text-sm text-sem-red">Couldn’t load race countdown: {countdown.error.message}</p>;
  if (!countdown.data) return null;
  const race = countdown.data;
  return (
    <section className="rounded-xl border border-line bg-surface-1 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div><div className="font-body text-nano font-semibold uppercase tracking-[0.18em] text-ink-muted">Next race</div><div className="mt-1 font-display text-lg font-extrabold uppercase text-ink">{race.name}</div></div>
        <div className="font-mono text-xl font-semibold tabular-nums text-acc">{race.days_to_go === 0 ? 'Today' : `${race.days_to_go} days`}</div>
        <div className="flex gap-4 font-mono text-sm text-ink-secondary"><span>Goal {race.goal?.display || 'Not set'}</span>{race.prediction && <span>Garmin {race.prediction.display}</span>}</div>
      </div>
    </section>
  );
}
