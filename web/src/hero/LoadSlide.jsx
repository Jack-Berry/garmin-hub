import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { ACCENT, AXIS, GRID } from '../ui';
import { shortDate } from '../format';

const MUTED = '#94a3b8'; // slate-400 — non-current weeks

// Plain-language load read. Placeholder heuristic (current week vs the mean of
// the prior weeks); the AI-generated verdict lands in a later stage.
function verdict(weeks) {
  if (weeks.length < 2) return 'Not enough history yet.';
  const cur = weeks[weeks.length - 1].km;
  const prior = weeks.slice(0, -1);
  const avg = prior.reduce((s, w) => s + w.km, 0) / prior.length;
  if (avg === 0) return 'Building back up.';
  const ratio = cur / avg;
  if (ratio < 0.7) return 'Backing off — lighter week.';
  if (ratio > 1.2) return 'Building — load ramping up.';
  return 'Holding steady around your usual load.';
}

// Slide 3 — weekly running mileage bars, last 12 weeks, current week accented.
export default function LoadSlide({ weekly }) {
  // weekly is newest-first; chart oldest→newest, current week is the last bar.
  const rows = (weekly || [])
    .slice()
    .reverse()
    .map((w) => ({ week: shortDate(w.week_start), km: +(w.total_distance_m / 1000).toFixed(1) }));
  const lastIdx = rows.length - 1;

  return (
    <div className="flex h-full flex-col">
      <header className="mb-3">
        <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Load
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Weekly running mileage · last 12 weeks
        </p>
      </header>

      <div className="min-h-0 flex-1">
        {!rows.length ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">No mileage yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: GRID }}
                contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }}
                formatter={(v) => [`${v} km`, 'Distance']}
              />
              <Bar dataKey="km" radius={[4, 4, 0, 0]} maxBarSize={42}>
                {rows.map((_, i) => (
                  <Cell key={i} fill={i === lastIdx ? ACCENT : MUTED} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {rows.length > 0 && (
        <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-300">
          {verdict(rows)}
        </p>
      )}
    </div>
  );
}
