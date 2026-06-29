import { useEffect, useState } from 'react';
import { api } from './api';
import { useFetch } from './useFetch';
import { StateWrap } from './ui';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600';

const addBtnCls =
  'rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-300';

// Small round delete control for a list row.
function DelBtn({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-2 text-sm text-slate-400 transition hover:border-rose-400 hover:text-rose-500 dark:border-slate-700"
    >
      ✕
    </button>
  );
}

function Group({ title, hint, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

// One read-only stat card: label on top, value below, optional sub line.
function RecordCard({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {sub && <div className="text-[11px] text-slate-400 dark:text-slate-500">{sub}</div>}
    </div>
  );
}

// Read-only Garmin-sourced records: personal bests + current race predictions.
// These are ingest-owned (not user-edited), so they're displayed, never editable.
function GarminRecords() {
  const prs = useFetch(() => api.personalRecords());
  const preds = useFetch(() => api.racePredictions());
  return (
    <div className="space-y-6 border-t border-slate-100 pt-6 dark:border-slate-800">
      <Group title="Personal records" hint="Your Garmin bests — read-only, updated by ingest">
        <StateWrap loading={prs.loading} error={prs.error} empty={prs.data && !prs.data.length}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(prs.data || []).map((r) => (
              <RecordCard key={r.type_id} label={r.label} value={r.value_display} sub={r.record_date} />
            ))}
          </div>
        </StateWrap>
      </Group>

      <Group title="Current race predictions" hint="Garmin's predicted times at current fitness — read-only">
        <StateWrap loading={preds.loading} error={preds.error} empty={preds.data === null}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(preds.data?.predictions || []).map((p) => (
              <RecordCard key={p.label} label={p.label} value={p.display} />
            ))}
          </div>
          {preds.data?.calendar_date && (
            <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
              As of {preds.data.calendar_date}
            </p>
          )}
        </StateWrap>
      </Group>
    </div>
  );
}

// Coaching profile editor in a modal overlay. Loads the profile, edits the
// shoe / race / injury lists + notes inline, and saves everything at once.
export default function SettingsModal({ onClose }) {
  const { data, loading, error } = useFetch(() => api.profile());
  const [shoes, setShoes] = useState([]);
  const [races, setRaces] = useState([]);
  const [injuries, setInjuries] = useState([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // 'saved' | { error }

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Populate from the loaded profile. Shoes start with one empty row.
  useEffect(() => {
    if (!data) return;
    setShoes(data.shoes?.length ? data.shoes : [{ name: '', purpose: '' }]);
    setRaces(data.races || []);
    setInjuries(data.injuries || []);
    setNotes(data.general_notes || '');
  }, [data]);

  const dirty = () => setStatus(null);
  const patch = (setter) => (i, p) => { setter((a) => a.map((r, j) => (j === i ? { ...r, ...p } : r))); dirty(); };
  const remove = (setter) => (i) => { setter((a) => a.filter((_, j) => j !== i)); dirty(); };
  const setShoe = patch(setShoes);
  const setRace = patch(setRaces);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await api.saveProfile({
        // Drop fully-empty rows so blanks don't accumulate.
        shoes: shoes.filter((s) => s.name?.trim() || s.purpose?.trim()),
        races: races.filter((r) => r.name?.trim() || r.date || r.goal_time?.trim()),
        injuries: injuries.map((s) => s.trim()).filter(Boolean),
        general_notes: notes,
      });
      setStatus('saved');
    } catch (e) {
      setStatus({ error: e });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              Coaching profile
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Context injected into AI-coach prompts
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </header>

        <div className="space-y-6 p-5">
          <StateWrap loading={loading} error={error}>
            <Group title="Shoes" hint="Your shoes and what each is for (daily, tempo, race…)">
              {shoes.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={inputCls}
                    placeholder="Shoe name"
                    value={s.name || ''}
                    onChange={(e) => setShoe(i, { name: e.target.value })}
                  />
                  <input
                    className={inputCls}
                    placeholder="Purpose (daily, tempo…)"
                    value={s.purpose || ''}
                    onChange={(e) => setShoe(i, { purpose: e.target.value })}
                  />
                  <DelBtn onClick={() => remove(setShoes)(i)} label="Remove shoe" />
                </div>
              ))}
              <button type="button" className={addBtnCls} onClick={() => { setShoes((a) => [...a, { name: '', purpose: '' }]); dirty(); }}>
                + Add shoe
              </button>
            </Group>

            <Group title="Upcoming races" hint="Race, date (optional), and a goal time — leave goal time blank for “just running it”.">
              {races.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${inputCls} min-w-[10rem] flex-1`}
                    placeholder="Race name / description"
                    value={r.name || ''}
                    onChange={(e) => setRace(i, { name: e.target.value })}
                  />
                  <input
                    type="date"
                    className={`${inputCls} w-auto`}
                    value={r.date || ''}
                    onChange={(e) => setRace(i, { date: e.target.value })}
                  />
                  <input
                    className={`${inputCls} w-32`}
                    placeholder="Goal time (opt.)"
                    value={r.goal_time || ''}
                    onChange={(e) => setRace(i, { goal_time: e.target.value })}
                  />
                  <DelBtn onClick={() => remove(setRaces)(i)} label="Remove race" />
                </div>
              ))}
              <button type="button" className={addBtnCls} onClick={() => { setRaces((a) => [...a, { name: '', date: '', goal_time: '' }]); dirty(); }}>
                + Add race
              </button>
            </Group>

            <Group title="Injuries & constraints" hint="Any niggles, injury history, max runs per week, etc.">
              {injuries.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={inputCls}
                    placeholder="e.g. right achilles tightness; max 5 runs/week"
                    value={s}
                    onChange={(e) => { setInjuries((a) => a.map((v, j) => (j === i ? e.target.value : v))); dirty(); }}
                  />
                  <DelBtn onClick={() => remove(setInjuries)(i)} label="Remove constraint" />
                </div>
              ))}
              <button type="button" className={addBtnCls} onClick={() => { setInjuries((a) => [...a, '']); dirty(); }}>
                + Add constraint
              </button>
            </Group>

            <Group title="General notes" hint="Anything else useful for coaching context">
              <textarea
                className={`${inputCls} resize-y`}
                rows={3}
                value={notes}
                onChange={(e) => { setNotes(e.target.value); dirty(); }}
                placeholder="Anything else useful for coaching context"
              />
            </Group>

            <div className="flex items-center gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-600 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save profile'}
              </button>
              {status === 'saved' && <span className="text-sm text-emerald-500">Saved ✓</span>}
              {status?.error && (
                <span className="text-sm text-rose-500">Couldn’t save: {status.error.message}</span>
              )}
            </div>
          </StateWrap>

          <GarminRecords />
        </div>
      </div>
    </div>
  );
}
