import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, Badge } from '../ui';
import { km, shortDate, todayISO } from '../format';

// One planned workout row with its race-override controls.
function PlannedRow({ w, onChanged }) {
  const [busy, setBusy] = useState(false);
  const overridden = w.is_race_override != null;

  const set = async (override) => {
    setBusy(true);
    try {
      await api.raceOverride(w.schedule_id, override);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{w.title}</span>
          {w.is_race ? <Badge tone="amber">Race</Badge> : null}
          {overridden ? <Badge tone="slate">manual</Badge> : null}
        </div>
        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {shortDate(w.calendar_date)}
          {w.estimated_distance_m != null && <span> · {km(w.estimated_distance_m)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => set(w.is_race ? 0 : 1)}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {w.is_race ? 'Unmark race' : 'Mark as race'}
        </button>
        {overridden && (
          <button
            onClick={() => set(null)}
            disabled={busy}
            className="text-xs text-slate-400 underline-offset-2 hover:underline disabled:opacity-50"
          >
            auto
          </button>
        )}
      </div>
    </li>
  );
}

// Upcoming planned workouts (today onward), ordered by date.
export default function PlannedWorkouts() {
  const { data, loading, error, reload } = useFetch(() => api.planned({ from: todayISO() }));
  return (
    <Section title="Upcoming planned workouts" subtitle="From Runna · toggle a race override">
      <StateWrap loading={loading} error={error} empty={!data || !data.length}>
        {data && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.map((w) => (
              <PlannedRow key={w.schedule_id} w={w} onChanged={reload} />
            ))}
          </ul>
        )}
      </StateWrap>
    </Section>
  );
}
