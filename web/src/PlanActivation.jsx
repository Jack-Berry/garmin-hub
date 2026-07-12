import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './ui';
import { shortDate } from './format';

// Stage 9c/9d-3 — activating a saved plan: sequential push to Garmin, then a
// CONDITIONAL cancel-Runna step (only when the plan's date span actually
// overlaps live Runna workouts — runna_remaining is span-scoped server-side; a
// bridge/gap plan skips the step entirely). One flow, two hosts (9d-3):
//   - the in-chat "Activate now" modal right after a save (the primary route)
//   - the dashboard card (default export), the resume/fallback path — it only
//     renders while choreography is left undone.
// Every step derives from server state (GET /api/plan/current), so a reload —
// or completing the flow in the other host — resumes/clears correctly: both
// instances re-read on the shared plan-changed event, and always re-read after
// a refresh even when the ingest itself errored (the state may have moved
// anyway). Ordering is deliberate: push FIRST, cancel Runna AFTER the push is
// confirmed complete — Runna stays intact as the fallback until the app plan
// has fully landed. The athlete is never hostage to the feed check: the cancel
// step carries a manual "Runna's already gone" override (api.runnaCleared).

const km = (m) => (m != null ? `${(m / 1000).toFixed(1)} km` : '');

// Local wall-clock YYYY-MM-DD — matches the server's localDate, so the
// expired/pending split renders the same as the counts it sits beside.
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Cross-instance sync: the modal and the dashboard card are independent mounts
// of this flow — an action in one re-loads the other.
const PLAN_EVENT = 'garminhub:plan-changed';
const emitPlanChanged = () => window.dispatchEvent(new Event(PLAN_EVENT));

export function ActivationFlow({ variant = 'card', expectPlanId = null }) {
  const modal = variant === 'modal';
  const [plan, setPlan] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | pushing | refreshing | skipping
  const [pushingId, setPushingId] = useState(null); // schedule_id mid-push
  const [error, setError] = useState(null);
  const [halted, setHalted] = useState(false); // recorded:false — do NOT resume blind
  const [refreshed, setRefreshed] = useState(false); // cancel-step refresh has run

  const load = () =>
    api.planCurrent().then((p) => { setPlan(p); setLoaded(true); })
      .catch(() => { setPlan(null); setLoaded(true); });
  useEffect(() => {
    load();
    window.addEventListener(PLAN_EVENT, load);
    return () => window.removeEventListener(PLAN_EVENT, load);
  }, []);

  if (!plan || !plan.sessions?.length) {
    if (!modal) return null;
    return (
      <p className="text-sm text-ink-secondary">
        {loaded ? 'No plan awaiting activation.' : 'Loading…'}
      </p>
    );
  }

  // Stage 9d lifecycle: the plan auto-completes once its block has passed
  // (goal race / last session behind us). The card surfaces that briefly — a
  // week past the last session — then gets out of the way.
  if (plan.status === 'completed') {
    if (modal) {
      return (
        <p className="text-sm text-ink-secondary">
          “{plan.name || 'Adapted plan'}” has already run its course — nothing to activate.
        </p>
      );
    }
    const weekAfter = new Date(`${plan.date_to}T00:00:00`).getTime() + 7 * 86400000;
    if (Date.now() > weekAfter) return null;
    return (
      <section className="rounded-xl border border-line bg-surface-1 p-5">
        <h2 className="font-display text-sm font-bold uppercase tracking-[0.1em] text-ink">
          Plan complete
        </h2>
        <p className="mt-1 font-body text-sm text-ink-secondary">
          “{plan.name || 'Adapted plan'}” has run its course
          ({shortDate(plan.date_from)} – {shortDate(plan.date_to)}). It stays in your
          history — compose a new block whenever you’re ready.
        </p>
      </section>
    );
  }

  const { pending, pushed, expired } = plan.counts;
  const hasRunna = plan.runna_remaining > 0 && !plan.runna_cleared;
  const cancelStep = pending === 0 && hasRunna;
  const complete = pending === 0 && !hasRunna;
  // Card: fully done → show the success state once (right after the clearing
  // action), then disappear for good on the next mount. Modal: always show it.
  if (complete && !refreshed && !modal) return null;

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
      emitPlanChanged();
    }
  };

  // Cancel-Runna step: the athlete acts in Runna, then this refresh lets the
  // ingest's per-source stale cleanup clear the Runna rows. Always re-read
  // plan state afterwards, even when the ingest errored — a partial ingest (or
  // an earlier one) may already have moved the state this card renders.
  const refreshAfterCancel = async () => {
    if (phase !== 'idle') return;
    setPhase('refreshing');
    setError(null);
    try {
      await api.refreshIngest();
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      await load();
      setRefreshed(true);
      setPhase('idle');
      emitPlanChanged();
    }
  };

  // Manual override (9d-3): the athlete can see their own Runna app — if they
  // say it's gone (or was never involved), that assertion beats the feed
  // check. The hub must never hold activation hostage to a dead/laggy feed.
  const skipRunna = async () => {
    if (phase !== 'idle') return;
    setPhase('skipping');
    setError(null);
    try {
      await api.runnaCleared(plan.plan_id);
      await load();
      setRefreshed(true);
    } catch (e) {
      setError(e.message || 'Skip failed');
    } finally {
      setPhase('idle');
      emitPlanChanged();
    }
  };

  const body = (
    <>
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

      {expectPlanId && plan.plan_id !== expectPlanId && (
        <p className="mt-2 text-xs text-ink-muted">
          Showing the plan that currently needs attention — it isn’t the one just saved.
        </p>
      )}
      {plan.supersedes_active && (
        <p className="mt-2 text-xs text-ink-secondary">
          “{plan.supersedes_active}” is still the active plan — activating this one
          archives it (its pushed sessions stay on Garmin).
        </p>
      )}

      {complete ? null : cancelStep ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-ink-secondary">
            All {pushed} sessions are scheduled on Garmin, but {plan.runna_remaining} Runna
            workout{plan.runna_remaining === 1 ? '' : 's'} still overlap this plan’s dates.
            The hub can’t cancel Runna for you — open the{' '}
            <span className="font-medium text-ink">Runna app</span> and end your plan there,
            which removes Runna’s workouts from the Garmin calendar. Until then both plans
            appear on Garmin (cosmetic — the hub already shows only the app plan). Keep the
            Runna calendar URL in Settings until after the refresh.
          </p>
          {refreshed && hasRunna && (
            <p className="text-xs text-ink-muted">
              Still seeing {plan.runna_remaining} overlapping Runna
              workout{plan.runna_remaining === 1 ? '' : 's'} — the calendar feed can lag
              (or die entirely) after cancelling. Refresh again in a while, or use
              “Runna’s already gone” below if you’ve definitely cancelled.
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={refreshAfterCancel}
              disabled={phase !== 'idle'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-acc px-3 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
            >
              <Icon name="refresh" className={phase === 'refreshing' ? 'animate-spin' : ''} />
              {phase === 'refreshing' ? 'Refreshing…' : 'I’ve cancelled Runna — refresh now'}
            </button>
            <button
              onClick={skipRunna}
              disabled={phase !== 'idle'}
              className="text-xs text-ink-muted underline-offset-2 transition hover:text-ink-secondary hover:underline disabled:opacity-50"
            >
              {phase === 'skipping' ? 'Skipping…' : 'Runna’s already gone — skip this check'}
            </button>
          </div>
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
              {hasRunna
                ? `Pushes each session to Garmin one at a time. ${plan.runna_remaining} Runna workout${plan.runna_remaining === 1 ? '' : 's'} overlap this plan — Runna stays untouched until every session has landed, then you’ll be prompted to cancel it.`
                : 'Pushes each session to Garmin one at a time. No Runna workouts overlap this plan — it goes live as soon as every session has landed.'}
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

      {complete && (
        <p className="mt-3 text-sm text-ink-secondary">
          {plan.status === 'active' || pushed > 0
            ? 'The plan is live on Garmin. ✓'
            : 'Nothing left to do for this plan. ✓'}
        </p>
      )}
      {error && <p className="mt-3 text-xs text-sem-red">{error}</p>}
    </>
  );

  if (modal) return body;
  return (
    <section className="rounded-xl border border-acc/60 bg-surface-1 p-5">
      {body}
    </section>
  );
}

// The dashboard card — since 9d-3 the resume/fallback host of the flow (the
// primary route is the in-chat modal right after a save).
export default function PlanActivation() {
  return <ActivationFlow variant="card" />;
}
