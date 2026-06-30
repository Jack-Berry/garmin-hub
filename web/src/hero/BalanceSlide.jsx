// Slide 3 — Training Balance. A current snapshot (~last 4 weeks of load) parsed
// from Garmin's training_status: three Load Focus bars (Low/High Aerobic +
// Anaerobic, each with its optimal-range band), a humanised training-status
// pill, and the ACWR load ratio (the injury-risk sweet-spot metric). Data comes
// pre-parsed from /api/training-balance — no raw_json on the frontend.

// Garmin Load Focus feedback phrases → plain language. The order in some enums
// (AEROBIC_LOW_*) reads backwards, so these are mapped explicitly; anything
// unmapped falls back to a generic de-snake.
const LOAD_FEEDBACK = {
  BALANCED: 'On target',
  AEROBIC_LOW_SHORTAGE: 'Low aerobic shortage',
  AEROBIC_HIGH_SHORTAGE: 'High aerobic shortage',
  ANAEROBIC_SHORTAGE: 'Anaerobic shortage',
  AEROBIC_LOW_EXCESS: 'Low aerobic excess',
  AEROBIC_HIGH_EXCESS: 'High aerobic excess',
  ANAEROBIC_EXCESS: 'Anaerobic excess',
  NO_RECENT: 'Not enough recent data',
};

// Training-status phrase base (trailing _1/_2 stripped) → label + conventional
// colour. Greens/oranges come from Tailwind's default palette (the sem-* tokens
// only cover amber/red/violet/blue); peaking carries the live accent.
const STATUS = {
  PRODUCTIVE: { label: 'Productive', cls: 'text-emerald-400 bg-emerald-400/15' },
  MAINTAINING: { label: 'Maintaining', cls: 'text-amber-400 bg-amber-400/15' },
  OVERREACHING: { label: 'Overreaching', cls: 'text-red-400 bg-red-400/15' },
  UNPRODUCTIVE: { label: 'Unproductive', cls: 'text-orange-400 bg-orange-400/15' },
  DETRAINING: { label: 'Detraining', cls: 'text-orange-400 bg-orange-400/15' },
  RECOVERY: { label: 'Recovery', cls: 'text-sky-400 bg-sky-400/15' },
  PEAKING: { label: 'Peaking', cls: 'text-acc bg-acc/15' },
  NO: { label: 'No status', cls: 'text-ink-muted bg-surface-2' },
};

// ACWR status → colour: in the 0.8–1.3 band is optimal (green), under-loaded
// amber, over the top red.
const ACWR_CLS = { OPTIMAL: 'text-emerald-400', LOW: 'text-amber-400', HIGH: 'text-red-400' };

const titleCase = (s) =>
  (s || '').replace(/_\d+$/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// One Load Focus bar: a faint value fill + the optimal-range band (lighter zone
// with bracket edges) + a solid tick marking the current value. Monochrome —
// these are reference readings, not the live/key one (accent rule).
function Bar({ label, value, min, max }) {
  const hi = (Math.max(value || 0, max || 0) || 1) * 1.08;
  const pct = (v) => `${Math.max(0, Math.min(100, (v / hi) * 100))}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-body text-micro font-semibold uppercase tracking-[0.12em] text-ink-secondary">
          {label}
        </span>
        <span className="font-mono text-label tabular-nums text-ink">{value ?? '—'}</span>
      </div>
      <div className="relative mt-2 h-2.5 rounded-full bg-surface-2">
        {value != null && (
          <div className="absolute inset-y-0 left-0 rounded-full bg-ink-secondary/40" style={{ width: pct(value) }} />
        )}
        {min != null && max != null && (
          <div
            className="absolute inset-y-0 rounded-[3px] bg-ink-muted/15 ring-1 ring-inset ring-ink-muted/45"
            style={{ left: pct(min), width: `calc(${pct(max)} - ${pct(min)})` }}
          />
        )}
        {value != null && (
          <div
            className="absolute -top-0.5 -bottom-0.5 w-[3px] -translate-x-1/2 rounded-full bg-ink"
            style={{ left: pct(value) }}
          />
        )}
      </div>
    </div>
  );
}

export default function BalanceSlide({ data }) {
  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <header className="mb-3">
          <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-ink">
            Training Balance
          </h2>
          <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
            Snapshot · ~last 4 weeks of load
          </p>
        </header>
        <p className="my-auto text-sm text-ink-muted">No training-status data yet.</p>
      </div>
    );
  }

  const bars = data.load_focus?.bars || [];
  const feedback = data.load_focus?.feedback
    ? (LOAD_FEEDBACK[data.load_focus.feedback] || titleCase(data.load_focus.feedback))
    : null;
  const st = data.training_status?.phrase
    ? (STATUS[data.training_status.phrase.split('_')[0]] || { label: titleCase(data.training_status.phrase), cls: 'text-ink-secondary bg-surface-2' })
    : null;
  const acwr = data.acwr;

  return (
    <div className="flex h-full flex-col">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-ink">
            Training Balance
          </h2>
          <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
            Snapshot · ~last 4 weeks of load
          </p>
        </div>
        {feedback && (
          <span className="shrink-0 font-body text-micro font-medium text-ink-secondary">{feedback}</span>
        )}
      </header>

      <div className="my-auto space-y-3">
        {bars.map((b) => (
          <Bar key={b.key} label={b.label} value={b.value} min={b.target_min} max={b.target_max} />
        ))}
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
        {st && (
          <div className="flex items-center gap-2">
            <span className="font-body text-nano font-semibold uppercase tracking-[0.16em] text-ink-muted">Status</span>
            <span className={`inline-flex items-center rounded-md px-2 py-0.5 font-body text-micro font-bold uppercase tracking-[0.08em] ${st.cls}`}>
              {st.label}
            </span>
          </div>
        )}
        {acwr?.ratio != null && (
          <div className="text-right">
            <div className="font-body text-nano font-semibold uppercase tracking-[0.16em] text-ink-muted">
              Load ratio · sweet spot 0.8–1.3
            </div>
            <div className="mt-1 font-mono text-label tabular-nums">
              {/* The ACWR is the key/live injury-risk reading — accented value. */}
              <span className="font-semibold text-acc">{acwr.ratio}</span>
              {acwr.status && (
                <>
                  <span className="mx-1.5 text-ink-muted">·</span>
                  <span className={ACWR_CLS[acwr.status] || 'text-ink-secondary'}>{acwr.status.toLowerCase()}</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
