import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './ui';
import { shortDate } from './format';

// Stage 9c — activating a saved plan: sequential push to Garmin, then the
// guided cancel-Runna step. Renders as a card only while there's choreography
// left to do; every step is derived from server state (GET /api/plan/current),
// so a reload mid-flow resumes at the right step:
//   pending > 0                     → push step (resume affordance after a failure)
//   all pushed + Runna rows remain  → cancel-Runna gate
//   otherwise                       → nothing (the plan lives in Upcoming planned)
// Ordering is deliberate: push FIRST, cancel Runna AFTER the push is confirmed
// complete — Runna stays intact as the fallback until the app plan has fully
// landed. The brief double-listing on the Garmin calendar is cosmetic and
// clears with the same refresh that clears the Runna rows.

const km = (m) => (m != null ? `${(m / 1000).toFixed(1)} km` : '');

// Local wall-clock YYYY-MM-DD — matches the server's localDate, so the
// expired/pending split renders the same as the counts it sits beside.
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function PlanActivation() {
  const [plan, setPlan] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | pushing | refreshing
  const [pushingId, setPushingId] = useState(null); // schedule_id mid-push
  const [error, setError] = useState(null);
  const [halted, setHalted] = useState(false); // recorded:false — do NOT resume blind
  const [refreshed, setRefreshed] = useState(false); // cancel-step refresh has run

  const load = () => api.planCurrent().then(setPlan).catch(() => setPlan(null));
  useEffect(() => { load(); }, []);

  if (!plan || !plan.sessions?.length) return null;
  const { pending, pushed, expired } = plan.counts;
  const cancelStep = pending === 0 && plan.runna_remaining > 0;
  const complete = pending === 0 && plan.runna_remaining === 0;
  // Fully done: show the success state once (right after the clearing
  // refresh), then disappear for good on the next mount.
  if (complete && !refreshed) return null;

  // Sequential push loop: one session per call, stamping workout_id onto the
  // local session row as each lands so the list updates live. Stops on the
  // first failure (server state = clean pushed/pending boundary; the same
  // button resumes) and HARD-stops on recorded:false — the workout is on
  // Garmin but the row still says pending, so a blind resume would push it
  // twice.
  const pushAll = async () => {
    if (phase !== 'idle' || halted) return;
    setPhase('pushing');
    setError(null);
    try {
      // `plan` in this closure is a snapshot — track what this loop has pushed
      // locally so the "pushing…" marker advances (mirrors the server's own
      // oldest-future-pending selection).
      const done = new Set();
      const today = todayLocal();
      for (;;) {
        const nextRow = plan.sessions.find((s) =>
          s.workout_id == null && !done.has(s.schedule_id) && s.calendar_date >= today);
        setPushingId(nextRow?.schedule_id ?? null);
        const r = await api.planPushNext(plan.plan_id);
        if (r.done) break;
        done.add(r.pushed.schedule_id);
        setPlan((p) => ({
          ...p,
          sessions: p.sessions.map((s) =>
            s.schedule_id === r.pushed.schedule_id
              ? { ...s, workout_id: r.pushed.workout_id } : s),
          counts: { ...p.counts, pushed: p.counts.pushed + 1, pending: r.remaining },
        }));
        if (r.recorded === false) {
          setHalted(true);
          setError(`"${r.pushed.name}" reached Garmin but the hub failed to record it. ` +
            'Don’t resume until the mismatch is fixed — resuming would push it a second time.');
          return;
        }
      }
      await load(); // status flipped to active server-side
    } catch (e) {
      setError(e.message || 'Push failed');
      await load(); // pull the clean pushed/pending boundary
    } finally {
      setPushingId(null);
      setPhase('idle');
    }
  };

  // Cancel-Runna step: the athlete acts in Runna, then this refresh lets the
  // ingest's per-source stale cleanup clear the Runna rows (and the Garmin
  // calendar duplicates go with them, since Runna's cancellation removed its
  // workouts there).
  const refreshAfterCancel = async () => {
    if (phase !== 'idle') return;
    setPhase('refreshing');
    setError(null);
    try {
      await api.refreshIngest();
      await load();
      setRefreshed(true);
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      setPhase('idle');
    }
  };

  return (
    <section className="rounded-xl border border-acc/60 bg-surface-1 p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.1em] text-ink">
            {complete ? 'Plan live' : cancelStep ? 'Plan on Garmin — retire Runna' : 'Activate plan'}
          </h2>
          <p className="mt-0.5 font-body text-xs text-ink-muted">
            {plan.name || 'Adapted plan'} · {shortDate(plan.date_from)} – {shortDate(plan.date_to)}
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-ink-secondary">
          {pushed} of {pushed + pending} pushed
          {expired > 0 && <span className="text-ink-muted"> · {expired} past, skipped</span>}
        </span>
      </div>

      {complete ? null : cancelStep ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-ink-secondary">
            All {pushed} sessions are scheduled on Garmin. The hub can’t cancel Runna
            for you — open the <span className="font-medium text-ink">Runna app</span> and
            end your plan there, which removes Runna’s workouts from the Garmin calendar.
            Until then both plans appear on Garmin (cosmetic — the hub already shows only
            the app plan). Keep the Runna calendar URL in Settings until after the refresh,
            so the hub can see the feed emptied and clear its {plan.runna_remaining} remaining
            Runna workout{plan.runna_remaining === 1 ? '' : 's'}.
          </p>
          {refreshed && plan.runna_remaining > 0 && (
            <p className="text-xs text-ink-muted">
              Still seeing {plan.runna_remaining} Runna workout{plan.runna_remaining === 1 ? '' : 's'} —
              the calendar feed can lag after cancelling. Refresh again in a while.
            </p>
          )}
          <button
            onClick={refreshAfterCancel}
            disabled={phase !== 'idle'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-acc px-3 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
          >
            <Icon name="refresh" className={phase === 'refreshing' ? 'animate-spin' : ''} />
            {phase === 'refreshing' ? 'Refreshing…' : 'I’ve cancelled Runna — refresh now'}
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <div className="max-h-56 overflow-y-auto">
            {plan.sessions.map((s) => {
              const isExpired = s.workout_id == null && s.calendar_date < todayLocal();
              const state = s.workout_id != null ? 'pushed'
                : s.schedule_id === pushingId ? 'pushing'
                : 'pending';
              return (
                <div key={s.schedule_id}
                     className="flex items-center gap-2 border-b border-line py-1.5 text-sm last:border-0">
                  <span className="w-16 shrink-0 font-mono text-[11px] text-ink-muted">
                    {shortDate(s.calendar_date)}
                  </span>
                  <span className={`flex-1 truncate font-body ${isExpired ? 'text-ink-muted line-through' : 'text-ink'}`}>
                    {s.title}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                    {km(s.estimated_distance_m)}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[11px]">
                    {isExpired ? <span className="text-ink-muted">skipped</span>
                      : state === 'pushed' ? <span className="text-ink-secondary">✓ pushed</span>
                      : state === 'pushing' ? <span className="text-acc">pushing…</span>
                      : <span className="text-ink-muted">pending</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="max-w-[65%] text-xs leading-relaxed text-ink-muted">
              Pushes each session to Garmin one at a time. Runna stays untouched until
              every session has landed — you’ll be prompted to cancel it after.
            </p>
            <button
              onClick={pushAll}
              disabled={phase !== 'idle' || halted}
              className="inline-flex items-center gap-1.5 rounded-lg bg-acc px-3 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
            >
              <Icon name="upload" />
              {phase === 'pushing' ? 'Pushing…'
                : pushed > 0 ? `Resume push (${pending} left)`
                : 'Activate & push to Garmin'}
            </button>
          </div>
        </div>
      )}

      {complete && refreshed && (
        <p className="mt-3 text-sm text-ink-secondary">
          Runna cleared — the app plan is the only one live. ✓
        </p>
      )}
      {error && <p className="mt-3 text-xs text-sem-red">{error}</p>}
    </section>
  );
}
