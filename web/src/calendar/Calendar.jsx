import { useMemo, useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { dateOnly, kmNum, routineGroup, shortDate, ymd } from '../format';
import { planCompliance, planDayStatus } from '../activityMatch';
import { Section, StateWrap } from '../ui';
import InsightModal from '../InsightModal';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const monthStart = (value) => new Date(value.getFullYear(), value.getMonth(), 1);
const monthEnd = (value) => new Date(value.getFullYear(), value.getMonth() + 1, 0);
const addDays = (value, days) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);

const monthLabel = (value) => value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const workoutName = (workout) => {
  if (!workout?.title) return workout?.estimated_distance_m ? `${kmNum(workout.estimated_distance_m)} km` : 'Run';
  return workout.title.replace(/\s+/g, ' ').trim();
};

function fetchRange(month) {
  const first = monthStart(month);
  const last = monthEnd(month);
  const gridStart = addDays(first, -((first.getDay() + 6) % 7));
  const gridEnd = addDays(last, 6 - ((last.getDay() + 6) % 7));
  return { from: ymd(gridStart), to: ymd(gridEnd), first, last, gridStart, gridEnd };
}

function statusFor(plan, runs, date, today) {
  if (!plan) return null;
  const status = planDayStatus(plan, runs);
  return status === 'pending' && date < today ? 'missed' : status;
}

function CalendarBody({ month, setMonth, onSelectDay }) {
  const range = useMemo(() => fetchRange(month), [month]);
  const planned = useFetch(() => api.planned({ from: range.from, to: range.to }), [range.from, range.to]);
  const activities = useFetch(() => api.activities({ from: range.from, to: `${range.to} 23:59:59`, limit: 500 }), [range.from, range.to]);
  const profile = useFetch(() => api.profile(), []);
  const loading = planned.loading || activities.loading || profile.loading;
  const error = planned.error || activities.error || profile.error;
  const today = ymd(new Date());
  const plansByDate = {};
  (planned.data || []).forEach((plan) => {
    const date = plan.calendar_date;
    if (date && !plansByDate[date]) plansByDate[date] = plan;
  });
  const runsByDate = {};
  const allRunsByDate = {};
  (activities.data || []).forEach((activity) => {
    const date = dateOnly(activity.start_time_local);
    if (!date) return;
    if (activity.activity_group === 'run') (runsByDate[date] ||= []).push(activity);
    (allRunsByDate[date] ||= []).push(activity);
  });
  const routinesByDow = {};
  (profile.data?.routines || []).forEach((routine) => {
    if (routine.activity && routine.day && !routinesByDow[routine.day]) routinesByDow[routine.day] = routine;
  });

  const days = [];
  for (let date = range.gridStart; date <= range.gridEnd; date = addDays(date, 1)) days.push(date);
  // The summary covers this month only, not the neighbouring grey days, and
  // counts planned runs that are past or already done, like This Week.
  const monthKey = ymd(range.first).slice(0, 7);
  const inMonth = (entries) => Object.fromEntries(Object.entries(entries).filter(([date]) => date.startsWith(monthKey)));
  const compliance = planCompliance(inMonth(plansByDate), runsByDate, today);
  const totalKm = Object.values(inMonth(runsByDate)).flat()
    .reduce((sum, activity) => sum + Number(activity.distance_m || 0), 0);

  return (
    <StateWrap loading={loading} error={error} empty={false}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1))} className="h-8 w-8 rounded-md border border-line text-lg text-ink-secondary hover:bg-surface-2" aria-label="Previous month">‹</button>
          <h3 className="min-w-[9.5rem] text-center font-display text-sm font-bold uppercase tracking-[0.12em] text-ink">{monthLabel(month)}</h3>
          <button onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1))} className="h-8 w-8 rounded-md border border-line text-lg text-ink-secondary hover:bg-surface-2" aria-label="Next month">›</button>
        </div>
        <button onClick={() => setMonth(monthStart(new Date()))} className="rounded-md border border-line px-2.5 py-1.5 font-body text-nano font-semibold uppercase tracking-[0.12em] text-ink-secondary hover:bg-surface-2">Today</button>
      </div>
      <p className="mt-3 font-mono text-nano uppercase tracking-[0.1em] text-ink-muted">{compliance.done} of {compliance.total} planned runs done · {kmNum(totalKm) || 0} km run distance</p>
      <div className="mt-4 grid grid-cols-7 gap-px" role="grid" aria-label={`${monthLabel(month)} calendar`}>
        {DOW.map((day) => <div key={day} className="pb-1 text-center font-body text-[0.48rem] font-semibold uppercase tracking-[0.08em] text-ink-muted sm:text-nano">{day}</div>)}
        {days.map((date) => {
          const dateText = ymd(date);
          const inThisMonth = date.getMonth() === month.getMonth();
          const isToday = dateText === today;
          const plan = plansByDate[dateText];
          const runs = runsByDate[dateText] || [];
          const runKm = runs.reduce((sum, run) => sum + Number(run.distance_m || 0), 0);
          const activity = runs.reduce((longest, run) => (!longest || Number(run.distance_m) > Number(longest.distance_m) ? run : longest), null);
          const status = statusFor(plan, runs, dateText, today);
          const routine = routinesByDow[DOW[(date.getDay() + 6) % 7]];
          const routineActivity = routine && (allRunsByDate[dateText] || []).find((item) => item.activity_group === routineGroup(routine.activity));
          const dayStatus = activity ? 'completed' : plan ? 'planned' : routineActivity ? 'routine_done' : routine && dateText >= today ? 'routine_expected' : 'rest';
          return (
            <button
              key={dateText}
              onClick={() => onSelectDay({ date: dateText, status: dayStatus, activity_id: activity?.activity_id || null, routine: routine && !activity ? { activity: routine.activity, state: routineActivity ? 'done' : 'expected' } : null })}
              className={`min-w-0 min-h-[4.8rem] border p-1.5 text-left transition hover:bg-surface-2 sm:min-h-[6.5rem] sm:p-2 ${inThisMonth ? 'bg-surface-1' : 'bg-surface-0 opacity-45'} ${isToday ? 'border-acc' : 'border-line'}`}
              aria-label={shortDate(dateText)}
              role="gridcell"
            >
              <div className={`flex flex-wrap items-center justify-between gap-0.5 font-mono text-nano tabular-nums ${isToday ? 'font-bold text-ink' : 'text-ink-muted'}`}><span>{date.getDate()}</span>{plan?.is_race ? <span className="rounded border border-line px-0.5 text-[0.42rem] font-bold leading-tight tracking-[0.04em] text-ink-secondary">RACE</span> : null}</div>
              <div className="mt-2 min-w-0 space-y-1">
                {plan && <div className="truncate font-display text-[0.55rem] font-bold uppercase leading-tight text-ink sm:text-[0.7rem]" title={plan.title}>{workoutName(plan)}</div>}
                {activity && <div className="font-mono text-[0.55rem] tabular-nums text-ink-secondary sm:text-nano">{kmNum(runKm) || 0} km{runs.length > 1 ? ` (${runs.length})` : ''}</div>}
                {!activity && !plan && routineActivity && <div className="truncate font-display text-[0.55rem] font-bold uppercase text-ink sm:text-[0.7rem]">{routine.activity}</div>}
                {!activity && !plan && !routineActivity && routine && dateText >= today && <div className="truncate font-display text-[0.55rem] font-bold uppercase text-ink-muted sm:text-[0.7rem]">{routine.activity}</div>}
                {!activity && !plan && !routine && <div className="font-display text-[0.55rem] font-bold uppercase text-ink-muted sm:text-[0.7rem]">Rest</div>}
                {plan?.estimated_distance_m ? <div className="font-mono text-[0.5rem] tabular-nums text-ink-muted">{activity ? 'plan ' : ''}{kmNum(plan.estimated_distance_m)} km</div> : null}
                {status && <div className={`font-mono text-[0.46rem] font-bold uppercase tracking-[0.05em] ${status === 'partial' ? 'text-sem-amber' : 'text-ink-muted'}`}>{status}</div>}
                {activity && !plan && <div className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.05em] text-ink-muted">Done</div>}
              </div>
            </button>
          );
        })}
      </div>
    </StateWrap>
  );
}

const DAY_SUBTITLE = { completed: 'How your run went', planned: 'Tips for this session', rest: 'Rest day', routine_done: 'How it went', routine_expected: 'Tips for this session' };
const chatSeed = (day) => day.status === 'completed' ? `How did my run on ${shortDate(day.date)} go?` : day.status === 'planned' ? `Any tips for my planned session on ${shortDate(day.date)}?` : `${shortDate(day.date)} is a rest day. Anything worth noting given my training?`;

export default function Calendar() {
  const [month, setMonth] = useState(monthStart(new Date()));
  const [day, setDay] = useState(null);
  return (
    <>
      <Section title="Month calendar" subtitle="Planned sessions, completed runs and routines">
        <CalendarBody month={month} setMonth={setMonth} onSelectDay={setDay} />
      </Section>
      {day && <InsightModal key={day.date} title={shortDate(day.date)} subtitle={DAY_SUBTITLE[day.status]} chatSeed={chatSeed(day)} activityId={day.activity_id} onClose={() => setDay(null)} {...(day.status === 'rest' ? { staticBody: 'Rest day. Nothing planned and no run logged.' } : { generate: () => api.coachDay(day.date) })} />}
    </>
  );
}
