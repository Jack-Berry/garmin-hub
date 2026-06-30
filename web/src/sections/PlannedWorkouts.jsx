import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, Badge, Icon } from '../ui';
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
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-body text-sm font-medium text-ink">{w.title}</span>
          {w.is_race ? <Badge tone="race">Race</Badge> : null}
          {overridden ? <Badge tone="slate">manual</Badge> : null}
          {/* The same-day Engo pacer was collapsed into this row — flag it. */}
          {w.pacer_available ? (
            <Badge tone="indigo"><Icon name="stopwatch" className="mr-1" />pacer ready</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 font-mono text-micro text-ink-muted">
          {shortDate(w.calendar_date)}
          {w.estimated_distance_m != null && <span> · {km(w.estimated_distance_m)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => set(w.is_race ? 0 : 1)}
          disabled={busy}
          className="rounded-lg border border-line px-2.5 py-1 font-body text-micro font-semibold uppercase tracking-[0.08em] text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50"
        >
          {w.is_race ? 'Unmark race' : 'Mark as race'}
        </button>
        {overridden && (
          <button
            onClick={() => set(null)}
            disabled={busy}
            className="text-xs text-ink-muted underline-offset-2 hover:underline disabled:opacity-50"
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
    <Section title="Upcoming planned" subtitle="From Runna · toggle a race override">
      <StateWrap loading={loading} error={error} empty={!data || !data.length}>
        {data && (
          <ul className="divide-y divide-line">
            {data.map((w) => (
              <PlannedRow key={w.schedule_id} w={w} onChanged={reload} />
            ))}
          </ul>
        )}
      </StateWrap>
    </Section>
  );
}
