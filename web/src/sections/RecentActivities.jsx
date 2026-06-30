import { Fragment, useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, Badge, PageMore, Icon } from '../ui';
import { km, duration, pace, paceFromMps, shortDate } from '../format';

const SHOWN = ['run', 'football']; // exclude walks and other
const ACT_ICON = { run: 'run', football: 'ball-football' };

// Lap types are categorical (historical), not "live" — so they use the semantic
// palette (amber/blue), never the reserved accent.
const intensityTone = (t) =>
  /rest|recover/i.test(t || '') ? 'amber' : /interval|active/i.test(t || '') ? 'blue' : 'slate';

// Laps for one activity, fetched on demand when its row is expanded.
function ActivityDetail({ id }) {
  const { data, loading, error } = useFetch(() => api.activity(id), [id]);
  const laps = data && data.laps;
  return (
    <div className="bg-surface-2 px-4 py-3">
      <StateWrap loading={loading} error={error} empty={!laps || !laps.length}>
        {laps && (
          <table className="w-full text-xs">
            <thead className="font-body text-nano uppercase tracking-[0.1em] text-ink-muted">
              <tr className="text-left">
                <th className="py-1 pr-3 font-semibold">Lap</th>
                <th className="py-1 pr-3 font-semibold">Distance</th>
                <th className="py-1 pr-3 font-semibold">Pace</th>
                <th className="py-1 pr-3 font-semibold">HR</th>
                <th className="py-1 font-semibold">Type</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums text-ink-secondary">
              {laps.map((l) => (
                <tr key={l.lap_index} className="border-t border-line">
                  <td className="py-1 pr-3">{l.lap_index}</td>
                  <td className="py-1 pr-3">{km(l.distance_m)}</td>
                  <td className="py-1 pr-3">{paceFromMps(l.avg_speed_mps)}</td>
                  <td className="py-1 pr-3">{l.avg_hr ?? '—'}</td>
                  <td className="py-1">
                    {l.intensity_type ? (
                      <Badge tone={intensityTone(l.intensity_type)}>{l.intensity_type.toLowerCase()}</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StateWrap>
    </div>
  );
}

// Recent runs + football; click a row to reveal its laps. 6 shown by default
// (keeps the left column height close to the shorter Upcoming-planned column),
// "Show more" paginates the rest 10 at a time.
export default function RecentActivities() {
  const { data, loading, error } = useFetch(() => api.activities({ limit: 100 }));
  const [openId, setOpenId] = useState(null);
  const [visible, setVisible] = useState(6);

  const all = data ? data.filter((a) => SHOWN.includes(a.activity_group)) : [];
  const shown = all.slice(0, visible);

  return (
    <Section title="Recent activities" subtitle="Runs & football · click a row to see its laps">
      <StateWrap loading={loading} error={error} empty={!all.length}>
        {data && (
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
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
                  const open = openId === a.activity_id;
                  return (
                    <Fragment key={a.activity_id}>
                      <tr
                        onClick={() => setOpenId(open ? null : a.activity_id)}
                        className={`cursor-pointer border-t border-line transition hover:bg-surface-2 ${
                          open ? 'bg-surface-2' : ''
                        }`}
                      >
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
                      {open && (
                        <tr>
                          <td colSpan={6} className="p-0">
                            <ActivityDetail id={a.activity_id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
