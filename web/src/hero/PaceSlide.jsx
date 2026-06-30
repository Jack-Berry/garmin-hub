import { useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { INK, AXIS, GRID } from '../ui';
import { useAccentHex } from '../accent';
import { shortDate, secPerKm, paceFromSecPerKm, kmNum } from '../format';

// Accent rule for trend lines: the line is monochrome ink; only the most recent
// (latest/"live") session is drawn as an accent point. `accent` is the resolved
// hex (Recharts can't read CSS var()), so it follows the picker.
const lastPointDot = (lastIdx, accent) => (props) => {
  const { cx, cy, index } = props;
  if (cx == null || cy == null) return null;
  const live = index === lastIdx;
  return <circle cx={cx} cy={cy} r={live ? 4 : 2} fill={live ? accent : INK} stroke="none" />;
};

// Name keywords that mark a session as "hard" regardless of HR.
const HARD_RE = /interval|taper|race|tempo|pyramid|threshold/i;
// Fallback: an easy run shouldn't average this high.
const HARD_HR = 150;
const isHard = (a) => HARD_RE.test(a.name || '') || (a.avg_hr != null && a.avg_hr >= HARD_HR);

const TABS = [
  { key: 'run', label: 'Run' },
  { key: 'football', label: 'Football' },
];
const INTENSITY = [
  { key: 'easy', label: 'Easy' },
  { key: 'hard', label: 'Hard' },
];
const FOOT_MODE = [
  { key: 'distance', label: 'Distance' },
  { key: 'speed', label: 'Max speed' },
];

// ~12 weeks back from now.
const cutoff = () => {
  const d = new Date();
  d.setDate(d.getDate() - 84);
  return d.toISOString().slice(0, 10);
};

const seg =
  'rounded-md px-3 py-1 font-body text-micro font-semibold uppercase tracking-[0.08em] transition';
const segOn = 'bg-surface-2 text-acc';
const segOff = 'text-ink-muted hover:text-ink-secondary';

// Slide 2 — activity trend. Runs: pace per session (inverted Y, faster = top)
// with an Easy/Hard split. Football: distance per session, or top speed (from
// max_speed_mps, m/s → km/h) when that's available. Last ~12 weeks.
export default function PaceSlide({ activities }) {
  const accent = useAccentHex();
  const [tab, setTab] = useState('run');
  const [intensity, setIntensity] = useState('easy');
  const [footMode, setFootMode] = useState('distance');

  const since = cutoff();
  const recent = (activities || []).filter((a) => (a.start_time_local || '') >= since);
  const isRun = tab === 'run';

  // Football top speed is only offered when the games actually carry it; else
  // fall back to distance-only (no toggle) rather than plotting empty points.
  const footGames = recent.filter((a) => a.activity_group === 'football' && a.distance_m > 0);
  const footHasSpeed = footGames.some((a) => a.max_speed_mps != null);
  const footSpeed = !isRun && footMode === 'speed' && footHasSpeed;

  let rows, domain;
  if (isRun) {
    const runs = recent
      .filter((a) => a.activity_group === 'run' && a.distance_m > 0)
      .filter((a) => (intensity === 'hard' ? isHard(a) : !isHard(a)));
    rows = [...runs]
      .reverse()
      .map((a) => ({ date: shortDate(a.start_time_local), sec: secPerKm(a.distance_m, a.duration_s) }))
      .filter((r) => r.sec != null);
    // Pad the data range so the line isn't glued to the axis edges.
    const secs = rows.map((r) => r.sec);
    const lo = secs.length ? Math.floor((Math.min(...secs) - 15) / 15) * 15 : 270;
    const hi = secs.length ? Math.ceil((Math.max(...secs) + 15) / 15) * 15 : 390;
    domain = [lo, hi];
  } else {
    rows = [...footGames]
      .reverse()
      .map((a) => ({
        date: shortDate(a.start_time_local),
        km: kmNum(a.distance_m),
        kmh: a.max_speed_mps != null ? +(a.max_speed_mps * 3.6).toFixed(1) : null,
      }))
      .filter((r) => (footSpeed ? r.kmh != null : r.km != null));
  }

  const footKey = footSpeed ? 'kmh' : 'km';
  const subtitle = isRun
    ? `${intensity === 'hard' ? 'Hard' : 'Easy'} runs · last 12 weeks`
    : `${footSpeed ? 'Top speed' : 'Distance'} per session · last 12 weeks`;

  return (
    <div className="flex h-full flex-col">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-ink">
            Activity trend
          </h2>
          <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">{subtitle}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="inline-flex rounded-lg border border-line p-0.5">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} className={`${seg} ${tab === t.key ? segOn : segOff}`}>
                {t.label}
              </button>
            ))}
          </div>
          {isRun && (
            <div className="inline-flex rounded-lg border border-line p-0.5">
              {INTENSITY.map((t) => (
                <button key={t.key} onClick={() => setIntensity(t.key)} className={`${seg} ${intensity === t.key ? segOn : segOff}`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {!isRun && footHasSpeed && (
            <div className="inline-flex rounded-lg border border-line p-0.5">
              {FOOT_MODE.map((t) => (
                <button key={t.key} onClick={() => setFootMode(t.key)} className={`${seg} ${footMode === t.key ? segOn : segOff}`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {!isRun && !footHasSpeed && footGames.length > 0 && (
            <p className="font-body text-micro uppercase tracking-[0.1em] text-ink-muted">Max speed unavailable</p>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {!rows.length ? (
          <p className="text-sm text-ink-muted">No matching sessions.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
              {isRun ? (
                <YAxis
                  reversed
                  domain={domain}
                  allowDataOverflow
                  width={56}
                  tick={{ fontSize: 11, fill: AXIS }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={paceFromSecPerKm}
                />
              ) : (
                <YAxis width={footSpeed ? 48 : 40} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
              )}
              <Tooltip
                contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }}
                formatter={(v) =>
                  isRun ? [paceFromSecPerKm(v), 'Pace']
                    : footSpeed ? [`${v} km/h`, 'Top speed']
                    : [`${v} km`, 'Distance']}
              />
              <Line
                type="monotone"
                dataKey={isRun ? 'sec' : footKey}
                stroke={INK}
                strokeWidth={2}
                dot={lastPointDot(rows.length - 1, accent)}
                activeDot={{ r: 4, fill: accent, stroke: 'none' }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
