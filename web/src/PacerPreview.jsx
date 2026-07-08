import { duration, shortDate } from './format';

// Shared pacer-preview presentation, lifted out of PacerModal so the inline
// ChatWidget planner, the plan review (Stage 9b) and the modal render the
// exact same card. Presentation only — no preview/push logic; the caller owns
// those and the buttons.

// One row in the preview's segment list. `n` numbers top-level intervals;
// null for repeat-group children (one iteration's steps, shown once).
export function SegRow({ seg, n }) {
  // Rest steps render distinctly — no pace, no distance/"easy" treatment.
  if (seg.type === 'rest') {
    const label = seg.duration_s != null
      ? `Rest ${seg.duration_s}s`
      : `Recovery ${seg.distance_m} m`;
    return (
      <div className="flex items-center justify-between border-b border-line py-1.5 text-sm last:border-0">
        <span className="font-body font-medium text-ink-muted">{label}</span>
        <span className="font-mono tabular-nums text-ink-muted">rest</span>
      </div>
    );
  }
  const isInterval = seg.type === 'interval';
  const dist = seg.distance_m >= 1000
    ? `${(seg.distance_m / 1000).toFixed(2)} km`
    : `${seg.distance_m} m`;
  const label =
    seg.type === 'warmup' ? 'Warm-up'
    : seg.type === 'cooldown' ? 'Cool-down'
    : n == null ? 'Rep'
    : `Segment ${n}`;
  return (
    <div className="flex items-center justify-between border-b border-line py-1.5 text-sm last:border-0">
      <span className="font-body font-medium text-ink">{label}</span>
      <span className="font-mono tabular-nums text-ink-secondary">
        {dist}
        {isInterval && seg.pace_label
          ? <> @ <span className="font-semibold text-acc">{seg.pace_label}</span></>
          : ' easy'}
      </span>
    </div>
  );
}

// A repeat group stays GROUPED — "8 ×" over one iteration's steps — instead of
// unrolling (unreadable at plan scale; matches how the watch shows it).
function RepeatGroup({ seg }) {
  return (
    <div className="border-b border-line py-1.5 last:border-0">
      <div className="flex items-center justify-between text-sm">
        <span className="font-body font-medium text-ink">Repeat</span>
        <span className="font-mono tabular-nums font-semibold text-ink">{seg.count} ×</span>
      </div>
      <div className="ml-2 border-l border-line pl-3">
        {seg.steps.map((c, i) => <SegRow key={i} seg={c} n={null} />)}
      </div>
    </div>
  );
}

// Executed work-step count: repeats multiply out (8×[rep, rest] = 8 intervals).
const intervalCount = (segs) => segs.reduce((t, s) =>
  s.type === 'repeat' ? t + s.count * intervalCount(s.steps)
  : s.type === 'interval' ? t + 1 : t, 0);

// The preview card: name + date, totals, and the segment list. `date` is the
// spec's target date (params.date in the modal, spec.date inline).
export function PacerPreview({ preview, date }) {
  // Interval numbering is independent of warmup/cooldown/repeat rows.
  let intervalN = 0;
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="font-body text-sm font-semibold text-ink">{preview.name}</h3>
        <span className="font-mono text-xs text-ink-muted">{shortDate(date)}</span>
      </div>
      <div className="mt-1 flex gap-4 font-mono text-xs text-ink-muted">
        <span>{(preview.total_distance_m / 1000).toFixed(2)} km total</span>
        <span>est. {duration(preview.est_duration_s)}</span>
        <span>{intervalCount(preview.segments)} segments</span>
      </div>
      <div className="mt-3">
        {preview.segments.map((seg, i) => (
          seg.type === 'repeat'
            ? <RepeatGroup key={i} seg={seg} />
            : <SegRow key={i} seg={seg} n={seg.type === 'interval' ? ++intervalN : null} />
        ))}
      </div>
    </div>
  );
}
