import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap } from '../ui';

const distance = (metres) => metres == null ? '-' : `${Math.round(Number(metres) / 1000)} km`;

function GearRows({ data, compact }) {
  const items = data?.items || [];
  if (!items.length) return <p className="text-sm text-ink-muted">No Garmin gear yet.</p>;
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.gear_uuid} className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-body text-sm font-semibold text-ink">{item.display_name || item.model_name || 'Unnamed gear'}</p>
              <p className="mt-1 text-xs text-ink-muted">
                {item.runs} runs · {item.first_used || 'Unknown'} to {item.last_used || 'Unknown'}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-sm font-semibold tabular-nums text-ink">{distance(item.garmin_total_distance_m)}</p>
              <p className="text-nano uppercase tracking-[0.1em] text-ink-muted">Garmin total</p>
            </div>
          </div>
          {!compact && (
            <p className="mt-2 text-xs text-ink-muted">
              Run sum check {distance(item.summed_run_distance_m)}{item.retired ? ' · Retired' : ' · Active'}
            </p>
          )}
          {item.mileage_alert && (
            <p className="mt-2 text-xs font-semibold text-sem-amber">
              Mileage alert: above {item.mileage_alert_km} km
            </p>
          )}
        </div>
      ))}
      {!compact && <p className="text-nano text-ink-muted">{data.match_method}</p>}
    </div>
  );
}

export function ShoeMileageContent({ state, compact = false }) {
  return (
    <StateWrap loading={state.loading} error={state.error} empty={false}>
      <GearRows data={state.data} compact={compact} />
    </StateWrap>
  );
}

export default function ShoeMileage() {
  const state = useFetch(() => api.gear());
  return (
    <Section title="Shoe mileage" subtitle="Garmin gear totals with logged run checks">
      <ShoeMileageContent state={state} compact />
    </Section>
  );
}
