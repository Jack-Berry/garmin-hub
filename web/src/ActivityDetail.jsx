import { useEffect } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api } from './api';
import { useFetch } from './useFetch';
import { AXIS, GRID, INK, Badge, Icon, StateWrap, btnPrimary } from './ui';
import { duration, km, pace, paceFromMps, shortDate } from './format';
import { matchIntervals, planMatchesActivity } from './activityMatch';

const has = (value) => value != null && value !== '';
const number = (value, digits = 0) => has(value) ? Number(value).toFixed(digits) : '-';
const tone = { hit: 'blue', close: 'amber', missed: 'slate' };
const isRecovery = (value) => /rest|recover|warm|cool/i.test(value || '');
const humanise = (value) => value
  ? value.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase())
  : null;
const paceLabel = (seconds, unit = true) => {
  if (!(seconds > 0)) return '-';
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}${unit ? '/km' : ''}`;
};

function Metric({ label, value }) {
  if (!has(value)) return null;
  return (
    <div className="min-w-0">
      <div className="font-mono text-base font-semibold tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 font-body text-nano font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</div>
    </div>
  );
}

function PaceTooltip({ active, payload, label, football }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="rounded-lg border border-line bg-surface-1 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 font-semibold text-ink">Lap {label}{row?.recovery ? ' · recovery' : ''}</div>
      {!football && has(row?.pace) && <div className="font-mono text-ink-secondary">Pace {paceLabel(row.pace)}</div>}
      {has(row?.hr) && <div className="font-mono text-ink-secondary">HR {Math.round(row.hr)} bpm</div>}
    </div>
  );
}

function PaceChart({ laps, football }) {
  const rows = laps.filter((lap) => lap.distance_m >= 100).map((lap) => {
    const lapPace = lap.avg_speed_mps > 0 ? 1000 / lap.avg_speed_mps : null;
    const recovery = isRecovery(lap.intensity_type);
    return {
      lap: lap.lap_index, hr: lap.avg_hr, recovery,
      pace: lapPace, workPace: recovery ? null : lapPace, recoveryPace: recovery ? lapPace : null,
    };
  });
  const showPace = !football && rows.some((row) => has(row.pace));
  const showHr = rows.some((row) => has(row.hr));
  if (!showPace && !showHr) return null;
  return (
    <section>
      <h3 className="font-display text-xs font-bold uppercase tracking-[0.14em] text-ink">Lap shape</h3>
      <p className="mt-1 text-xs text-ink-muted">Pace is minutes per kilometre, with faster laps higher. Recovery laps are amber.</p>
      <div className="mt-3 h-60 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="lap" tick={{ fill: AXIS, fontSize: 10 }} tickLine={false} axisLine={false} />
            {showPace && (
              <YAxis yAxisId="pace" reversed domain={['auto', 'auto']} tickFormatter={(v) => paceLabel(v, false)} tick={{ fill: AXIS, fontSize: 10 }} tickLine={false} axisLine={false} width={48} />
            )}
            {showHr && (
              <YAxis yAxisId="hr" orientation="right" domain={['dataMin - 8', 'dataMax + 8']} tick={{ fill: AXIS, fontSize: 10 }} tickLine={false} axisLine={false} width={34} />
            )}
            <Tooltip content={<PaceTooltip football={football} />} />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
            {showPace && <Line yAxisId="pace" dataKey="workPace" name="Pace" stroke="var(--sem-blue)" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />}
            {showPace && <Line yAxisId="pace" dataKey="recoveryPace" name="Recovery" stroke="var(--sem-amber)" strokeWidth={2} dot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />}
            {showHr && <Line yAxisId="hr" dataKey="hr" name="Heart rate" stroke={INK} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function Zones({ activity }) {
  const zones = [1, 2, 3, 4, 5].map((zone) => ({ zone, seconds: activity[`hr_zone${zone}_s`] })).filter((z) => z.seconds > 0);
  const total = zones.reduce((sum, z) => sum + z.seconds, 0);
  if (!zones.length) return null;
  return (
    <section>
      <h3 className="font-display text-xs font-bold uppercase tracking-[0.14em] text-ink">Heart rate zones</h3>
      <div className="mt-3 space-y-2">
        {zones.map(({ zone, seconds }) => (
          <div key={zone} className="grid grid-cols-[2rem_1fr_3.5rem] items-center gap-2 text-xs">
            <span className="font-body font-semibold text-ink-secondary">Z{zone}</span>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-ink-muted" style={{ width: `${seconds / total * 100}%` }} /></div>
            <span className="text-right font-mono tabular-nums text-ink-muted">{duration(seconds)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const FORM = [
  ['avg_cadence_spm', 'avg_cadence_spm', 'Cadence', ' spm', 0],
  ['avg_ground_contact_ms', 'ground_contact_ms', 'Ground contact', ' ms', 0],
  ['avg_stride_length_cm', 'stride_length_cm', 'Stride length', ' cm', 0],
  ['avg_vertical_ratio', 'vertical_ratio', 'Vertical ratio', '%', 1],
  ['avg_power', 'avg_power', 'Power', ' W', 0],
];

function FormMetrics({ activity, laps }) {
  const metrics = FORM.filter(([whole, lap]) => has(activity[whole]) || laps.some((row) => has(row[lap])));
  if (!metrics.length) return null;
  return (
    <section>
      <h3 className="font-display text-xs font-bold uppercase tracking-[0.14em] text-ink">Form</h3>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {metrics.map(([whole, lap, label, suffix, digits]) => {
          const trend = laps.map((row) => ({ x: row.lap_index, value: row[lap] })).filter((row) => has(row.value));
          return (
            <div key={whole} className="min-w-0 rounded-lg bg-surface-2 p-3">
              <div className="font-mono text-base font-semibold text-ink">{has(activity[whole]) ? `${number(activity[whole], digits)}${suffix}` : '-'}</div>
              <div className="mt-1 truncate text-nano font-semibold uppercase tracking-[0.1em] text-ink-muted">{label}</div>
              {trend.length > 1 && (
                <div className="mt-2 h-8">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend}><Line dataKey="value" stroke={INK} strokeWidth={1.5} dot={false} isAnimationActive={false} /></LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LapTable({ laps, football }) {
  if (!laps.length) return null;
  return (
    <section>
      <h3 className="font-display text-xs font-bold uppercase tracking-[0.14em] text-ink">Laps</h3>
      <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-line">
        <table className="w-full min-w-[42rem] text-xs">
          <thead className="sticky top-0 bg-surface-2 text-left font-body text-nano uppercase tracking-[0.1em] text-ink-muted">
            <tr>{['Lap', 'Type', 'Distance', 'Time', ...(football ? [] : ['Pace']), 'HR', 'Cadence', 'Power', 'GCT', 'Stride', 'V ratio'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody className="font-mono tabular-nums text-ink-secondary">
            {laps.map((lap) => (
              <tr key={lap.lap_index} className="border-t border-line">
                <td className="px-3 py-2">{lap.lap_index}</td>
                <td className="px-3 py-2">{lap.intensity_type || '-'}</td>
                <td className="px-3 py-2">{km(lap.distance_m)}</td>
                <td className="px-3 py-2">{duration(lap.duration_s)}</td>
                {!football && <td className="px-3 py-2">{paceFromMps(lap.avg_speed_mps)}</td>}
                <td className="px-3 py-2">{has(lap.avg_hr) ? Math.round(lap.avg_hr) : '-'}</td>
                <td className="px-3 py-2">{number(lap.avg_cadence_spm)}</td>
                <td className="px-3 py-2">{number(lap.avg_power)}</td>
                <td className="px-3 py-2">{number(lap.ground_contact_ms)}</td>
                <td className="px-3 py-2">{number(lap.stride_length_cm)}</td>
                <td className="px-3 py-2">{number(lap.vertical_ratio, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlannedActual({ planned, laps, activity, dayActivities }) {
  if (!planned?.length) return null;
  return (
    <section>
      <h3 className="font-display text-xs font-bold uppercase tracking-[0.14em] text-ink">Planned vs actual</h3>
      <div className="mt-3 space-y-3">
        {planned.map((workout) => {
          const textOnly = Array.isArray(workout.steps) && workout.steps.every((step) => typeof step === 'string');
          const isMatch = planMatchesActivity(activity, workout, dayActivities);
          const matches = isMatch ? matchIntervals(laps, workout.steps) : [];
          return (
            <div key={String(workout.schedule_id)} className="rounded-lg border border-line p-3">
              <div className="font-body text-sm font-semibold text-ink">{workout.title || 'Planned workout'}</div>
              {textOnly ? (
                <ul className="mt-2 space-y-1 text-xs text-ink-secondary">{workout.steps.map((line, i) => <li key={i}>{line}</li>)}</ul>
              ) : !isMatch ? (
                <p className="mt-2 text-xs text-ink-muted">No matching plan for this activity.</p>
              ) : matches.length ? (
                <>
                {matches.some((match) => match.byLap) && (
                  <p className="mt-2 text-xs text-ink-muted">Your laps are longer than the planned steps, so those steps are graded per lap. A lap that is mostly outside the steps is shown as mixed.</p>
                )}
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {matches.map((match, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-2.5 py-2 text-xs">
                      <span className="min-w-0 text-ink-secondary">
                        {match.byLap ? `Lap ${match.lap.lap_index} (${match.steps} steps)` : `Rep ${matches.slice(0, i + 1).filter((item) => !item.byLap).length}`}
                        {' · '}{paceLabel(match.fast, false)} to {paceLabel(match.slow)}
                      </span>
                      {tone[match.status] ? <Badge tone={tone[match.status]}>{match.status}</Badge> : <span className="text-ink-muted">{match.status === 'mixed' ? 'Mixed lap' : 'No lap'}</span>}
                    </div>
                  ))}
                </div>
                </>
              ) : (
                <p className="mt-2 text-xs text-ink-muted">No pace-target work intervals to compare.</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DetailBody({ data, plannedState, dayActivities, onAskCoach }) {
  const activity = data;
  const laps = data.laps || [];
  const football = activity.activity_group === 'football';
  const effect = [humanise(activity.training_effect_label), has(activity.aerobic_training_effect) ? `Aerobic ${number(activity.aerobic_training_effect, 1)}` : null, has(activity.anaerobic_training_effect) ? `Anaerobic ${number(activity.anaerobic_training_effect, 1)}` : null].filter(Boolean).join(', ');
  return (
    <>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-line px-4 py-4 sm:grid-cols-4 sm:px-6">
        <Metric label="Distance" value={km(activity.distance_m)} />
        <Metric label="Time" value={duration(activity.duration_s)} />
        {!football && <Metric label="Average pace" value={pace(activity.distance_m, activity.duration_s)} />}
        <Metric label="Average HR" value={has(activity.avg_hr) ? `${Math.round(activity.avg_hr)} bpm` : null} />
        <Metric label="Training effect" value={effect || null} />
        <Metric label="Load" value={has(activity.activity_training_load) ? number(activity.activity_training_load) : null} />
      </div>
      <div className="space-y-6 px-4 py-5 sm:px-6">
        <PaceChart laps={laps} football={football} />
        <Zones activity={activity} />
        <FormMetrics activity={activity} laps={laps} />
        <LapTable laps={laps} football={football} />
        <StateWrap loading={plannedState.loading} error={plannedState.error} empty={false}>
          <PlannedActual planned={plannedState.data} laps={laps} activity={activity} dayActivities={dayActivities} />
        </StateWrap>
        {activity.activity_group !== 'walk' && (
          <button className={`${btnPrimary} inline-flex items-center gap-2`} onClick={() => onAskCoach(activity)}>
            <Icon name="message-circle" /> Ask coach about this run
          </button>
        )}
      </div>
    </>
  );
}

export default function ActivityDetail({ activity, dayActivities, onClose, onAskCoach }) {
  const date = activity.start_time_local?.slice(0, 10);
  const detail = useFetch(() => api.activity(activity.activity_id), [activity.activity_id]);
  const planned = useFetch(() => api.planned({ from: date, to: date }), [date]);

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-hidden bg-black/55 p-0 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Activity detail for ${activity.name}`} className="mobile-sheet my-auto flex h-full max-h-none w-full max-w-5xl flex-col overflow-hidden bg-surface-1 shadow-2xl sm:h-auto sm:max-h-[90vh] sm:rounded-2xl sm:border sm:border-line" onClick={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="font-body text-nano font-semibold uppercase tracking-[0.18em] text-ink-muted">{shortDate(activity.start_time_local)}</p>
            <h2 className="mt-1 truncate font-display text-lg font-extrabold uppercase tracking-[0.03em] text-ink">{activity.name || 'Activity'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close activity detail" className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-sm text-ink-secondary transition hover:bg-surface-2">✕</button>
        </header>
        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="p-4 sm:p-6"><StateWrap loading={detail.loading} error={detail.error} empty={!detail.data}>{detail.data && <DetailBody data={detail.data} plannedState={planned} dayActivities={dayActivities} onAskCoach={onAskCoach} />}</StateWrap></div>
        </div>
      </div>
    </div>
  );
}
