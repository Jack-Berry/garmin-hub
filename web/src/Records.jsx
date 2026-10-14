import { api } from './api';
import { useFetch } from './useFetch';
import { Section, StateWrap } from './ui';

function RecordCard({ label, value, sub, accent }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="font-body text-nano font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</div>
      <div className={`mt-1 font-mono text-[1.375rem] font-semibold tabular-nums ${accent ? 'text-acc' : 'text-ink'}`}>{value}</div>
      {sub && <div className="font-mono text-nano text-ink-muted">{sub}</div>}
    </div>
  );
}

export default function GarminRecords() {
  const prs = useFetch(() => api.personalRecords());
  const preds = useFetch(() => api.racePredictions());
  return (
    <Section title="Records" subtitle="Garmin bests and current predictions">
      <div className="space-y-6">
        <div>
          <h3 className="font-display text-label font-bold uppercase tracking-[0.1em] text-ink">Personal records</h3>
          <p className="mt-1 font-body text-micro text-ink-muted">Your Garmin bests, updated by ingest</p>
          <div className="mt-2">
            <StateWrap loading={prs.loading} error={prs.error} empty={prs.data && !prs.data.length}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(prs.data || []).map((r) => <RecordCard key={r.type_id} label={r.label} value={r.value_display} sub={r.record_date} />)}
              </div>
            </StateWrap>
          </div>
        </div>
        <div>
          <h3 className="font-display text-label font-bold uppercase tracking-[0.1em] text-ink">Current race predictions</h3>
          <p className="mt-1 font-body text-micro text-ink-muted">Predicted times at current fitness</p>
          <div className="mt-2">
            <StateWrap loading={preds.loading} error={preds.error} empty={preds.data === null}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(preds.data?.predictions || []).map((p) => <RecordCard key={p.label} label={p.label} value={p.display} accent />)}
              </div>
              {preds.data?.calendar_date && <p className="mt-2 font-mono text-nano text-ink-muted">As of {preds.data.calendar_date}</p>}
            </StateWrap>
          </div>
        </div>
      </div>
    </Section>
  );
}
