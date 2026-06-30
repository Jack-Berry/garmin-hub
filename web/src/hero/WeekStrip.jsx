import { kmNum, dateOnly, ymd, routineGroup } from '../format';

// Mon→Sun dates for the week containing `today` (Monday start).
function weekDates(today) {
  const base = new Date(today);
  const monday = new Date(base);
  monday.setDate(base.getDate() - ((base.getDay() + 6) % 7)); // Sun=0 → 6 back
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Concise label from a Runna title, e.g.
// "W7 Wed Easy Run - 5.5km Easy Run (5.5km)" → "Easy".
const TYPES = ['Recovery', 'Intervals', 'Interval', 'Tempo', 'Threshold', 'Pyramid',
  'Progression', 'Taper', 'Long Run', 'Long', 'Easy', 'Race', 'Parkrun'];
function workoutLabel(title) {
  if (!title) return 'Run';
  for (const t of TYPES) if (new RegExp(t, 'i').test(title)) return t === 'Interval' ? 'Intervals' : t;
  return title.split(' - ')[0].replace(/^W\d+\s+\w+\s+/, '') || 'Run';
}

// Left-aligned activity headline (no icons, matching the reference): a big bold
// uppercase Archivo word with the distance small + muted directly below. Active
// (done/planned/routine) reads white; a race is the lime highlight.
function ActivityBlock({ name, detail, accent }) {
  return (
    <div className="flex max-w-full flex-col items-start">
      <div className={`max-w-full truncate font-display text-[1.25rem] font-bold uppercase leading-none ${accent ? 'text-acc' : 'text-ink'}`}>
        {name}
      </div>
      {detail && (
        <div className="mt-1.5 font-mono text-nano tabular-nums text-ink-muted">{detail}</div>
      )}
    </div>
  );
}

// Slide 1 — current-week Mon→Sun strip. Each cell makes the activity the focal
// point: a logged run shows a tick + actual distance, an unlogged plan shows the
// workout + planned distance, and a recurring profile activity (e.g. football)
// stacks/stands as a chip — done (logged) or a dashed not-yet-logged routine.
// A past routine day with nothing logged resolves to plain Rest, not a "missed"
// state. Clicking a cell calls onSelectDay; Hero owns the resulting modal.
export default function WeekStrip({ planned, activities, routines, onSelectDay }) {
  const today = new Date();
  const todayStr = ymd(today);
  const days = weekDates(today);

  // Index planned + run activities by calendar date (first per day wins).
  const plannedByDate = {};
  (planned || []).forEach((w) => {
    if (!plannedByDate[w.calendar_date]) plannedByDate[w.calendar_date] = w;
  });
  const runByDate = {};
  // Logged activities keyed by `date|group` so a routine can find its match
  // (e.g. football → activity_group 'football') using the same ymd() dates.
  const actByDateGroup = {};
  (activities || []).forEach((a) => {
    const d = dateOnly(a.start_time_local);
    if (!d) return;
    if (a.activity_group === 'run' && !runByDate[d]) runByDate[d] = a;
    const key = `${d}|${a.activity_group}`;
    if (!actByDateGroup[key]) actByDateGroup[key] = a;
  });

  // First recurring activity with a fixed day, indexed by weekday label.
  const routineByDow = {};
  (routines || []).forEach((r) => {
    if (r.activity && r.day && !routineByDow[r.day]) {
      routineByDow[r.day] = { ...r, group: routineGroup(r.activity) };
    }
  });

  return (
    <div className="flex flex-col">
      <header className="mb-3">
        <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-ink">
          This Week
        </h2>
        <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
          Planned vs done · tap a day for detail
        </p>
      </header>
      <div className="grid grid-cols-7 gap-px">
        {days.map((d, i) => {
          const date = ymd(d);
          const plan = plannedByDate[date];
          const act = runByDate[date];
          const isToday = date === todayStr;
          const isPast = date < todayStr;

          // Recurring activity for this weekday (runs are Runna's domain, so a
          // 'run'-group routine is left to the run line and shows no chip).
          const routine = routineByDow[DOW[i]];
          const showRoutine = routine && routine.group !== 'run';
          const routineAct = showRoutine ? actByDateGroup[`${date}|${routine.group}`] : null;
          // done if logged; expected only today/future. Past + unlogged → no
          // chip, so the day reads as Rest rather than implying a missed session.
          const routineState = !showRoutine ? null
            : routineAct ? 'done'
            : !isPast ? 'expected'
            : null;

          const hasRun = !!act || !!plan;

          // Click target: a logged run wins, then a plan, then a routine chip,
          // else rest.
          const status = act ? 'completed'
            : plan ? 'planned'
            : routineState ? `routine_${routineState}`
            : 'rest';

          return (
            <button
              key={date}
              onClick={() => onSelectDay({
                date,
                status,
                routine: routineState ? { activity: routine.activity, state: routineState } : null,
              })}
              className={`flex flex-col border-t-2 px-1.5 py-2 text-left transition hover:bg-surface-2 ${
                isToday ? 'border-acc' : 'border-line'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className={`font-body text-nano font-bold uppercase tracking-[0.12em] ${isToday ? 'text-acc' : 'text-ink-muted'}`}>
                  {DOW[i]}
                </span>
                <span className="font-mono text-nano tabular-nums text-ink-muted">
                  {d.getDate()}
                </span>
              </div>

              <div className="mt-4 flex min-h-[56px] flex-col items-start gap-2">
                {act ? (
                  <ActivityBlock
                    accent={!!plan?.is_race}
                    name={plan ? workoutLabel(plan.title) : 'Run'}
                    detail={`${kmNum(act.distance_m)} km`}
                  />
                ) : plan ? (
                  <ActivityBlock
                    accent={!!plan.is_race}
                    name={workoutLabel(plan.title)}
                    detail={plan.estimated_distance_m != null ? `${kmNum(plan.estimated_distance_m)} km` : null}
                  />
                ) : null}

                {routineState && (
                  <ActivityBlock name={routine.activity} />
                )}

                {!hasRun && !routineState && (
                  <div className="font-display text-[1.25rem] font-bold uppercase leading-none text-ink-muted">Rest</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
