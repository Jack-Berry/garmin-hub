import { api } from './api';
import { useFetch } from './useFetch';
import { Section, StateWrap } from './ui';

function RecordCard({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="font-body text-nano font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</div>
      <div className="mt-1 font-mono text-[1.375rem] font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="font-mono text-nano text-ink-muted">{sub}</div>}
    </div>
  );
}

// Garmin personal bests: history, so they sit with the trends, not the live metrics.
export function PersonalRecords() {
  const prs = useFetch(() => api.personalRecords());
  return (
    <Section title="Personal records" subtitle="Garmin bests, updated by ingest">
      <StateWrap loading={prs.loading} error={prs.error} empty={prs.data && !prs.data.length}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(prs.data || []).map((r) => <RecordCard key={r.type_id} label={r.label} value={r.value_display} sub={r.record_date} />)}
        </div>
      </StateWrap>
    </Section>
  );
}

// Garmin's race predictions are current fitness, so they live under the key
// metrics row and take the accent like the other live readings.
export function PredictionsRow() {
  const preds = useFetch(() => api.racePredictions());
  return (
    <div className="border-t border-line px-4 py-3 sm:px-5 sm:py-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-body text-nano font-semibold uppercase tracking-[0.18em] text-ink-muted">Race predictions</div>
        {preds.data?.calendar_date && <div className="font-mono text-nano text-ink-muted">As of {preds.data.calendar_date}</div>}
      </div>
      <StateWrap loading={preds.loading} error={preds.error} empty={preds.data === null}>
        <div className="mt-2 grid grid-cols-4 gap-2 sm:gap-4">
          {(preds.data?.predictions || []).map((p) => (
            <div key={p.label} className="min-w-0">
              <div className="truncate font-body text-nano font-semibold uppercase tracking-[0.12em] text-ink-muted">
                <span className="sm:hidden">{p.label.replace(/^Half Marathon$/, 'Half')}</span>
                <span className="hidden sm:inline">{p.label}</span>
              </div>
              <div className="mt-1 font-mono text-[1rem] font-semibold tabular-nums text-acc sm:text-[1.5rem]">{p.display}</div>
            </div>
          ))}
        </div>
      </StateWrap>
    </div>
  );
}
