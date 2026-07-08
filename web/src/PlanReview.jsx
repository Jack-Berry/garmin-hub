import { useState } from 'react';
import { shortDate } from './format';
import { PacerPreview } from './PacerPreview';

// Stage 9b plan review — the composer's generated plan rendered week by week.
// Each session row expands to the same preview card the single-session
// planner shows (repeat groups stay grouped); invalid sessions are flagged
// with their guard error, never hidden. Presentation + the Save action only —
// the caller owns the API call and the message state.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (d) => DOW[new Date(`${d}T00:00:00`).getDay()];

// ISO-week Monday for a YYYY-MM-DD (matches the plan's weeks[].start).
const mondayOf = (d) => {
  const dt = new Date(`${d}T00:00:00`);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

const km = (m) => `${(m / 1000).toFixed(1)} km`;

export function PlanReview({ plan, active, saving, saved, onSave }) {
  const [openIdx, setOpenIdx] = useState(null);
  const sessions = plan.sessions || [];
  const invalid = sessions.filter((s) => !s.valid);
  const weekMeta = new Map((plan.weeks || []).map((w) => [w.start, w]));

  // Group by week (Monday start), preserving session order within a week.
  const weeks = new Map();
  sessions.forEach((s, i) => {
    const wk = s.date ? mondayOf(s.date) : 'undated';
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk).push([s, i]);
  });

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <h3 className="font-body text-sm font-semibold text-ink">{plan.name || 'Adapted plan'}</h3>
      {plan.goal_race && (
        <p className="mt-0.5 font-mono text-xs text-ink-muted">{plan.goal_race}</p>
      )}
      {plan.summary && (
        <p className="mt-2 text-xs leading-relaxed text-ink-secondary">{plan.summary}</p>
      )}

      <div className="mt-3 space-y-3">
        {[...weeks.entries()].map(([wk, entries]) => {
          const meta = weekMeta.get(wk);
          const wkKm = entries.reduce(
            (t, [s]) => t + (s.valid && s.preview ? s.preview.total_distance_m : 0), 0);
          return (
            <div key={wk}>
              <div className="flex items-baseline justify-between border-b border-line pb-1">
                <span className="font-display text-xs font-bold uppercase tracking-[0.1em] text-ink">
                  Week of {shortDate(wk)}
                </span>
                <span className="font-mono text-[11px] text-ink-muted">{km(wkKm)}</span>
              </div>
              {meta?.focus && (
                <p className="mt-1 text-[11px] italic text-ink-muted">{meta.focus}</p>
              )}
              <div>
                {entries.map(([s, i]) => (
                  <div key={i} className="border-b border-line last:border-0">
                    <button
                      onClick={() => setOpenIdx(openIdx === i ? null : i)}
                      className="flex w-full items-center gap-2 py-1.5 text-left text-sm transition hover:bg-surface-1"
                    >
                      <span className="w-9 shrink-0 font-mono text-[11px] text-ink-muted">
                        {s.date ? dowOf(s.date) : '—'}
                      </span>
                      <span className="flex-1 truncate font-body font-medium text-ink">
                        {s.name || s.type || 'Session'}
                      </span>
                      {s.valid ? (
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-secondary">
                          {km(s.preview.total_distance_m)}
                        </span>
                      ) : (
                        <span className="shrink-0 rounded border border-sem-red px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sem-red">
                          invalid
                        </span>
                      )}
                    </button>
                    {openIdx === i && (
                      <div className="space-y-2 pb-2">
                        {s.rationale && (
                          <p className="text-[11px] italic text-ink-muted">{s.rationale}</p>
                        )}
                        {s.valid ? (
                          <PacerPreview preview={s.preview} date={s.date} />
                        ) : (
                          <p className="text-xs text-sem-red">
                            Rejected by the guard: {s.error}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="font-mono text-[11px] text-ink-muted">
          {sessions.length} sessions
          {invalid.length > 0 && (
            <span className="text-sem-red"> · {invalid.length} invalid</span>
          )}
        </span>
        {saved ? (
          <span className="text-xs text-ink-secondary">
            Saved ✓ <span className="font-mono">{saved.plan_id}</span>
          </span>
        ) : active ? (
          <button
            onClick={onSave}
            disabled={saving || invalid.length > 0}
            title={invalid.length ? 'Fix the invalid sessions before saving' : 'Save the plan to your calendar'}
            className="rounded-lg bg-acc px-3 py-1.5 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save plan'}
          </button>
        ) : (
          <span className="text-xs text-ink-muted">
            Not saved — composer ended. Re-enter Adapt plan to save.
          </span>
        )}
      </div>
    </div>
  );
}
