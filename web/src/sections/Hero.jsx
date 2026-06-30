import { useState, useEffect } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { kmNum, ymd, shortDate } from '../format';
import { Icon } from '../ui';
import InsightModal from '../InsightModal';
import WeekStrip from '../hero/WeekStrip';
import PaceSlide from '../hero/PaceSlide';
import LoadSlide from '../hero/LoadSlide';

// Auto-cycling carousel: advances every 12s, pauses on hover / focus / any
// interaction, with manual arrows + clickable dots. Slides are kept mounted
// (stacked, faded) so charts don't remount or refetch on each cycle, and the
// viewport is a fixed height so cycling never reflows the page.
function Carousel({ slides }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const n = slides.length;

  useEffect(() => {
    if (paused || n <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % n), 12000);
    return () => clearInterval(t);
  }, [paused, n, idx]); // idx dep restarts the 12s clock after a manual nav

  const go = (i) => setIdx(((i % n) + n) % n);

  const arrow =
    'flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-lg text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="relative h-[380px] px-5 pt-5">
        {slides.map((s, i) => (
          <div
            key={s.key}
            aria-hidden={i !== idx}
            className={`absolute inset-x-5 bottom-0 top-5 transition-opacity duration-500 ${
              i === idx ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            {s.node}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between px-5 py-3">
        <button className={arrow} onClick={() => go(idx - 1)} aria-label="Previous slide">‹</button>
        <div className="flex items-center gap-2">
          {slides.map((s, i) => (
            <button
              key={s.key}
              onClick={() => go(i)}
              aria-label={s.label}
              title={s.label}
              className={`h-2 w-2 rounded-full transition ${
                i === idx ? 'bg-indigo-500' : 'bg-slate-300 hover:bg-slate-400 dark:bg-slate-700 dark:hover:bg-slate-600'
              }`}
            />
          ))}
        </div>
        <button className={arrow} onClick={() => go(idx + 1)} aria-label="Next slide">›</button>
      </div>
    </div>
  );
}

function Tile({ icon, label, value, sub }) {
  return (
    <div className="flex flex-1 items-center gap-3 px-4 py-3">
      <Icon name={icon} className="text-2xl leading-none text-slate-400 dark:text-slate-500" />
      <div className="min-w-0">
        <div className="text-lg font-bold tabular-nums leading-tight text-slate-900 dark:text-slate-100">
          {value}
          {sub && <span className="ml-0.5 text-[11px] font-normal text-slate-400">{sub}</span>}
        </div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </div>
      </div>
    </div>
  );
}

// Persistent key-metric row below the carousel (does not cycle). Latest
// recovery snapshot + a rolling 7-day running total. The 7-day figure is
// deliberately a rolling window (not the calendar week the Load bars already
// show) — "what the legs have actually done lately", independent of Monday.
function MetricRow({ recovery, sevenDayKm }) {
  const r = (recovery && recovery[0]) || {};
  return (
    <div className="flex flex-wrap divide-slate-100 dark:divide-slate-800 sm:divide-x">
      <Tile icon="lungs" label="VO₂max" value={r.vo2max ?? '—'} />
      <Tile icon="heartbeat" label="Resting HR" value={r.resting_hr != null ? Math.round(r.resting_hr) : '—'} />
      <Tile icon="activity" label="HRV" value={r.hrv_last_night ?? '—'} />
      <Tile icon="run" label="Last 7 days" value={sevenDayKm ?? '—'} sub={sevenDayKm != null ? 'km' : ''} />
    </div>
  );
}

// Stage 6a hero zone: a cycling carousel (This Week / Pace trend / Load) above
// a persistent key-metric row. One fetch per endpoint, fanned out to slides.
// The day-insight modal titles with the clicked date; this is its subtitle.
const DAY_SUBTITLE = {
  completed: 'How your run went',
  planned: 'Tips for this session',
  rest: 'Rest day',
  routine_done: 'How it went',
  routine_expected: 'Tips for this session',
};

// Framing user turn that seeds the modal's mini-chat: it sets the focus day so
// the generated insight reads as a natural answer and follow-ups make sense,
// while /api/coach/chat supplies the full training context around it.
function chatSeedFor(day) {
  const d = shortDate(day.date);
  const act = day.routine?.activity || 'session';
  switch (day.status) {
    case 'completed': return `How did my run on ${d} go?`;
    case 'planned': return `Any tips for executing my planned session on ${d}?`;
    case 'routine_done': return `How did my ${act} session on ${d} go, and how does it fit my running week?`;
    case 'routine_expected': return `Any tips for my ${act} session on ${d}, and how should I balance it with my running?`;
    default: return `${d} is a rest day with nothing logged. Anything worth noting given my training?`;
  }
}

export default function Hero() {
  const [day, setDay] = useState(null); // clicked week-strip cell, or null
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const acts = useFetch(() => api.activities({ limit: 150 }));
  const planned = useFetch(() => api.planned({ from: ymd(monday), to: ymd(sunday) }));
  const recovery = useFetch(() => api.recovery({ limit: 7 }));
  const weekly = useFetch(() => api.weekly());
  const profile = useFetch(() => api.profile());

  // Rolling 7-day running mileage (today + prior 6 days), runs only.
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() - 6);
  const cutoffStr = ymd(cutoff);
  const sevenDayKm = acts.data
    ? kmNum(
        acts.data
          .filter((a) => a.activity_group === 'run' && (a.start_time_local || '').slice(0, 10) >= cutoffStr)
          .reduce((sum, a) => sum + (a.distance_m || 0), 0)
      )
    : null;

  const slides = [
    { key: 'week', label: 'This Week', node: <WeekStrip planned={planned.data} activities={acts.data} routines={profile.data?.routines} onSelectDay={setDay} /> },
    { key: 'pace', label: 'Pace trend', node: <PaceSlide activities={acts.data} /> },
    { key: 'load', label: 'Load', node: <LoadSlide weekly={weekly.data} /> },
  ];

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <Carousel slides={slides} />
        <div className="border-t border-slate-100 dark:border-slate-800">
          <MetricRow recovery={recovery.data} sevenDayKm={sevenDayKm} />
        </div>
      </section>

      {day && (
        <InsightModal
          key={day.date}
          title={shortDate(day.date)}
          subtitle={DAY_SUBTITLE[day.status]}
          chatSeed={chatSeedFor(day)}
          onClose={() => setDay(null)}
          {...(day.status === 'rest'
            ? { staticBody: 'Rest day. Nothing planned and no run logged.' }
            : { generate: () => api.coachDay(day.date) })}
        />
      )}
    </>
  );
}
