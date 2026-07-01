import { duration, shortDate } from './format';

// Shared pacer-preview presentation, lifted out of PacerModal so the inline
// ChatWidget planner and the modal render the exact same card. Presentation
// only — no preview/push logic; the caller owns those and the buttons.

// One row in the preview's segment list.
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

// The preview card: name + date, totals, and the segment list. `date` is the
// spec's target date (params.date in the modal, spec.date inline).
export function PacerPreview({ preview, date }) {
  // Interval numbering is independent of warmup/cooldown rows.
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
        <span>{preview.segments.filter((s) => s.type === 'interval').length} segments</span>
      </div>
      <div className="mt-3">
        {preview.segments.map((seg, i) => (
          <SegRow key={i} seg={seg} n={seg.type === 'interval' ? ++intervalN : null} />
        ))}
      </div>
    </div>
  );
}
