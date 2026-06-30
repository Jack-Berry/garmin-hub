import { kmNum, dateOnly, ymd, routineGroup } from '../format';
import { Icon } from '../ui';

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

// Tabler icon slug for a routine's activity group. One run icon (ti-run) covers
// every run type — the name text does the differentiating.
const ROUTINE_ICON = { football: 'ball-football', walk: 'walk', run: 'run' };
const routineIcon = (group) => ROUTINE_ICON[group] || 'barbell';

// Centred focal activity: a monochrome icon above the name, optional detail (km)
// below. The run line uses this; `tone` colours the icon (done = success green,
// planned = muted).
function ActivityBlock({ icon, tone, name, detail }) {
  const iconClass = tone === 'done'
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-slate-400 dark:text-slate-500';
  return (
    <div className="flex max-w-full flex-col items-center gap-1">
      <Icon name={icon} className={`text-2xl ${iconClass}`} />
      <div className="max-w-full truncate text-[16px] font-medium leading-tight text-slate-700 dark:text-slate-200">
        {name}
      </div>
      {detail && (
        <div className="text-[10px] tabular-nums text-slate-400 dark:text-slate-500">{detail}</div>
      )}
    </div>
  );
}

// A recurring profile activity (football, gym…) as a compact chip, stackable
// under a run line or standing alone on a routine-only day. Two states: 'done'
// (a matching activity was logged — solid success colour) and 'expected'
// (today/future, not yet logged — dashed outline, no "expected" text; the dashed
// style is the signal). A past routine with nothing logged isn't rendered here
// at all — the day falls back to plain Rest.
function RoutineChip({ icon, name, done }) {
  return done ? (
    <div className="flex max-w-full items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
      <Icon name={icon} className="text-sm" />
      <span className="truncate">{name}</span>
    </div>
  ) : (
    <div className="flex max-w-full items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
      <Icon name={icon} className="text-sm" />
      <span className="truncate">{name}</span>
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
    <div className="flex h-full flex-col">
      <header className="mb-3">
        <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          This Week
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Planned vs done · tap a day for detail
        </p>
      </header>
      <div className="grid flex-1 grid-cols-7 gap-1.5">
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
              className={`flex flex-col rounded-lg border p-2 text-left transition hover:border-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 ${
                isToday
                  ? 'border-indigo-500 bg-indigo-50/60 dark:border-indigo-500 dark:bg-indigo-500/10'
                  : 'border-slate-200 dark:border-slate-800'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className={`text-[11px] font-semibold uppercase ${isToday ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  {DOW[i]}
                </span>
                <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
                  {d.getDate()}
                </span>
              </div>

              <div className="flex flex-1 flex-col items-center justify-center gap-1.5 pt-1 text-center">
                {act ? (
                  <ActivityBlock
                    icon="circle-check"
                    tone="done"
                    name={plan ? workoutLabel(plan.title) : 'Run'}
                    detail={`${kmNum(act.distance_m)} km`}
                  />
                ) : plan ? (
                  <ActivityBlock
                    icon="run"
                    tone="planned"
                    name={workoutLabel(plan.title)}
                    detail={plan.estimated_distance_m != null ? `${kmNum(plan.estimated_distance_m)} km` : null}
                  />
                ) : null}

                {routineState && (
                  <RoutineChip
                    icon={routineIcon(routine.group)}
                    name={routine.activity}
                    done={routineState === 'done'}
                  />
                )}

                {!hasRun && !routineState && (
                  <div className="text-[12px] text-slate-400 dark:text-slate-600">Rest</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
