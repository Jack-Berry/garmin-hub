import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, Stat, ACCENT, AXIS, GRID } from '../ui';
import { km, paceFromSecPerKm, shortDate } from '../format';

// Current-week top-line stats above the 12-week mileage bar chart. Runs only
// (both come from /api/summary/weekly, which excludes walks/football).
export default function WeekSummary() {
  const { data, loading, error } = useFetch(() => api.weekly());
  const w = data && data[0];
  const rows =
    data &&
    [...data]
      .reverse()
      .map((x) => ({ week: shortDate(x.week_start), km: +(x.total_distance_m / 1000).toFixed(1) }));

  return (
    <Section
      title="This week"
      subtitle={w ? `Week of ${shortDate(w.week_start)} · 12-week mileage below` : 'Current week & mileage trend'}
    >
      <StateWrap loading={loading} error={error} empty={!w}>
        {w && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Distance" value={km(w.total_distance_m)} />
              <Stat label="Runs" value={w.run_count} />
              <Stat label="Avg pace" value={paceFromSecPerKm(w.avg_pace_s_per_km)} />
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: GRID }}
                  contentStyle={{ borderRadius: 8, border: 'none', fontSize: 12 }}
                  formatter={(v) => [`${v} km`, 'Distance']}
                />
                <Bar dataKey="km" fill={ACCENT} radius={[4, 4, 0, 0]} maxBarSize={42} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </StateWrap>
    </Section>
  );
}
