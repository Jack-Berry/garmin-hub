import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, Badge } from '../ui';
import { km, pace, shortDate, dateOnly } from '../format';

// Planned workouts matched to a completed run on the same calendar date.
// Kept deliberately simple this pass: distance/pace side by side, no
// step-by-step target comparison yet.
export default function PlannedVsActual() {
  const planned = useFetch(() => api.planned());
  const acts = useFetch(() => api.activities({ limit: 60 }));
  const loading = planned.loading || acts.loading;
  const error = planned.error || acts.error;

  // First activity found per date wins the match.
  const byDate = {};
  (acts.data || []).forEach((a) => {
    const d = dateOnly(a.start_time_local);
    if (d && !byDate[d]) byDate[d] = a;
  });

  const rows = (planned.data || []).map((w) => ({ w, match: byDate[w.calendar_date] }));

  return (
    <Section title="Planned vs actual" subtitle="Matched by date">
      <StateWrap loading={loading} error={error} empty={!rows.length}>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map(({ w, match }) => (
            <li key={w.schedule_id} className="py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{w.title}</span>
                {w.is_race ? <Badge tone="amber">Race</Badge> : null}
                <span className="text-xs text-slate-500 dark:text-slate-400">{shortDate(w.calendar_date)}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-950/40">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Planned
                  </div>
                  <div className="mt-0.5 text-sm tabular-nums text-slate-800 dark:text-slate-200">
                    {w.estimated_distance_m != null ? km(w.estimated_distance_m) : '—'}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-950/40">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Actual
                  </div>
                  {match ? (
                    <div className="mt-0.5 text-sm tabular-nums text-slate-800 dark:text-slate-200">
                      {km(match.distance_m)} · {pace(match.distance_m, match.duration_s)}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-sm text-slate-400 dark:text-slate-500">No completed match yet</div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </StateWrap>
    </Section>
  );
}
