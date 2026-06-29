import { Fragment, useState } from 'react';
import { api } from '../api';
import { useFetch } from '../useFetch';
import { Section, StateWrap, Badge, PageMore } from '../ui';
import { km, duration, pace, paceFromMps, shortDate } from '../format';

const SHOWN = ['run', 'football']; // exclude walks and other

const intensityTone = (t) =>
  /rest|recover/i.test(t || '') ? 'amber' : /interval|active/i.test(t || '') ? 'indigo' : 'slate';

// Laps for one activity, fetched on demand when its row is expanded.
function ActivityDetail({ id }) {
  const { data, loading, error } = useFetch(() => api.activity(id), [id]);
  const laps = data && data.laps;
  return (
    <div className="bg-slate-50 px-4 py-3 dark:bg-slate-950/40">
      <StateWrap loading={loading} error={error} empty={!laps || !laps.length}>
        {laps && (
          <table className="w-full text-xs">
            <thead className="text-slate-500 dark:text-slate-400">
              <tr className="text-left">
                <th className="py-1 pr-3 font-medium">Lap</th>
                <th className="py-1 pr-3 font-medium">Distance</th>
                <th className="py-1 pr-3 font-medium">Pace</th>
                <th className="py-1 pr-3 font-medium">HR</th>
                <th className="py-1 font-medium">Type</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {laps.map((l) => (
                <tr key={l.lap_index} className="border-t border-slate-200/60 dark:border-slate-800/60">
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

// Recent runs + football; click a row to reveal its laps. 5 shown by default,
// "Show more" paginates the rest 10 at a time.
export default function RecentActivities() {
  const { data, loading, error } = useFetch(() => api.activities({ limit: 100 }));
  const [openId, setOpenId] = useState(null);
  const [visible, setVisible] = useState(5);

  const all = data ? data.filter((a) => SHOWN.includes(a.activity_group)) : [];
  const shown = all.slice(0, visible);

  return (
    <Section title="Recent activities" subtitle="Runs & football · click a row to see its laps">
      <StateWrap loading={loading} error={error} empty={!all.length}>
        {data && (
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-slate-500 dark:text-slate-400">
                <tr className="text-left">
                  <th className="px-2 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Dist</th>
                  <th className="px-2 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">Pace</th>
                  <th className="px-2 py-2 font-medium">HR</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {shown.map((a) => {
                  const open = openId === a.activity_id;
                  return (
                    <Fragment key={a.activity_id}>
                      <tr
                        onClick={() => setOpenId(open ? null : a.activity_id)}
                        className={`cursor-pointer border-t border-slate-100 transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40 ${
                          open ? 'bg-slate-50 dark:bg-slate-800/40' : ''
                        }`}
                      >
                        <td className="px-2 py-2 whitespace-nowrap">{shortDate(a.start_time_local)}</td>
                        <td className="px-2 py-2 not-italic">{a.name}</td>
                        <td className="px-2 py-2 whitespace-nowrap">{km(a.distance_m)}</td>
                        <td className="px-2 py-2 whitespace-nowrap">{duration(a.duration_s)}</td>
                        <td className="px-2 py-2 whitespace-nowrap">{pace(a.distance_m, a.duration_s)}</td>
                        <td className="px-2 py-2">{a.avg_hr ?? '—'}</td>
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
            <PageMore visible={visible} total={all.length} base={5} step={10} set={setVisible} />
          </div>
        )}
      </StateWrap>
    </Section>
  );
}
