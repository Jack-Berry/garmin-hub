import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, PageMore, Icon } from '../ui';
import { km, duration, pace, shortDate } from '../format';

const SHOWN = ['run', 'football'];
const ACT_ICON = { run: 'run', football: 'ball-football' };

// Recent runs and football; a row opens the full activity sheet.
// 6 shown by default
// (keeps the left column height close to the shorter Upcoming-planned column),
// "Show more" paginates the rest 10 at a time.
export default function RecentActivities({ onSelect }) {
  const { data, loading, error } = useFetch(() => api.activities({ limit: 100 }));
  const [visible, setVisible] = useState(6);

  const all = data ? data.filter((a) => SHOWN.includes(a.activity_group)) : [];
  const shown = all.slice(0, visible);

  return (
    <Section title="Recent activities" subtitle="Runs & football · tap for full detail">
      <StateWrap loading={loading} error={error} empty={!all.length}>
        {data && (
          <div className="md:-mx-2 md:overflow-x-auto">
            <div className="space-y-2 md:hidden">
              {shown.map((a) => {
                return (
                  <div key={a.activity_id} className="overflow-hidden rounded-lg border border-line">
                    <button onClick={() => onSelect(a, all.filter((item) => item.start_time_local?.slice(0, 10) === a.start_time_local?.slice(0, 10)))} className="w-full p-3 text-left transition hover:bg-surface-2">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <Icon name={ACT_ICON[a.activity_group] || 'run'} className="shrink-0 text-base text-ink-muted" />
                          <span className="truncate font-body text-sm font-medium text-ink">{a.name}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-ink-muted">{shortDate(a.start_time_local)}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-4 gap-2 font-mono text-[11px] tabular-nums text-ink-secondary">
                        <span>{km(a.distance_m)}</span><span>{duration(a.duration_s)}</span>
                        <span>{a.activity_group === 'football' ? '-' : pace(a.distance_m, a.duration_s)}</span>
                        <span>{a.avg_hr ?? '-'} bpm</span>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
            <table className="hidden w-full text-sm md:table md:min-w-[34rem]">
              <thead className="font-body text-micro uppercase tracking-[0.12em] text-ink-muted">
                <tr className="text-left">
                  <th className="px-2 py-2 font-semibold">Date</th>
                  <th className="px-2 py-2 font-semibold">Name</th>
                  <th className="px-2 py-2 font-semibold">Dist</th>
                  <th className="px-2 py-2 font-semibold">Time</th>
                  <th className="px-2 py-2 font-semibold">Pace</th>
                  <th className="px-2 py-2 font-semibold">HR</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  return (
                      <tr key={a.activity_id} onClick={() => onSelect(a, all.filter((item) => item.start_time_local?.slice(0, 10) === a.start_time_local?.slice(0, 10)))} className="cursor-pointer border-t border-line transition hover:bg-surface-2">
                        <td className="px-2 py-2 whitespace-nowrap font-mono text-ink-secondary">{shortDate(a.start_time_local)}</td>
                        <td className="px-2 py-2 not-italic">
                          <span className="flex items-center gap-2">
                            <Icon
                              name={ACT_ICON[a.activity_group] || 'run'}
                              className="shrink-0 text-base text-ink-muted"
                            />
                            <span className="truncate font-body text-ink">{a.name}</span>
                          </span>
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap font-mono tabular-nums text-ink-secondary">{km(a.distance_m)}</td>
                        <td className="px-2 py-2 whitespace-nowrap font-mono tabular-nums text-ink-secondary">{duration(a.duration_s)}</td>
                        {/* Football pace is distance ÷ match-time — meaningless, so blank it. */}
                        <td className="px-2 py-2 whitespace-nowrap font-mono tabular-nums text-ink-secondary">
                          {a.activity_group === 'football' ? '—' : pace(a.distance_m, a.duration_s)}
                        </td>
                        <td className="px-2 py-2 font-mono tabular-nums text-ink-secondary">{a.avg_hr ?? '—'}</td>
                      </tr>
                  );
                })}
              </tbody>
            </table>
            <PageMore visible={visible} total={all.length} base={6} step={10} set={setVisible} />
          </div>
        )}
      </StateWrap>
    </Section>
  );
}
