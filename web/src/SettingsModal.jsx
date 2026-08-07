import { useEffect, useState } from 'react';
import { api } from './api';
import { useFetch } from './useFetch';
import { StateWrap } from './ui';
import { useAccent } from './accent';
import { ACCENTS, ACCENT_KEYS } from './accents';

const inputCls =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-muted focus:border-acc focus:ring-2 focus:ring-acc/20';

const addBtnCls =
  'rounded-lg border border-dashed border-line px-3 py-1.5 font-body text-micro font-semibold uppercase tracking-[0.1em] text-ink-secondary transition hover:border-acc hover:text-acc';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Small round delete control for a list row.
function DelBtn({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="shrink-0 rounded-lg border border-line px-2.5 py-2 text-sm text-ink-muted transition hover:border-sem-red hover:text-sem-red"
    >
      ✕
    </button>
  );
}

// Accent-colour picker — swatches apply instantly (live preview, no save) and
// persist to localStorage via the accent context. Swatches show each accent's
// vivid dark-mode hue; the active one carries a neutral ring.
function AccentPicker() {
  const { accent, setAccent } = useAccent();
  return (
    <div>
      <h3 className="font-display text-label font-bold uppercase tracking-[0.1em] text-ink">Accent colour</h3>
      <p className="mt-1 font-body text-micro text-ink-muted">Recolours the whole dashboard — live, no save needed.</p>
      <div className="mt-3 flex items-center gap-3">
        {ACCENT_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setAccent(key)}
            aria-label={ACCENTS[key].label}
            aria-pressed={accent === key}
            title={ACCENTS[key].label}
            style={{ backgroundColor: ACCENTS[key].d[0] }}
            className={`h-8 w-8 rounded-full ring-offset-2 ring-offset-surface-1 transition ${
              accent === key ? 'ring-2 ring-ink' : 'opacity-70 hover:opacity-100'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function Group({ title, hint, children }) {
  return (
    <div>
      <h3 className="font-display text-label font-bold uppercase tracking-[0.1em] text-ink">{title}</h3>
      {hint && <p className="mt-1 font-body text-micro text-ink-muted">{hint}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

// One read-only stat card: label on top, value below, optional sub line. The
// value is a mono data-readout; `accent` lifts it to the accent colour (used for
// race predictions — current-fitness/live data, per the accent rule).
function RecordCard({ label, value, sub, accent }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="font-body text-nano font-semibold uppercase tracking-[0.12em] text-ink-muted">
        {label}
      </div>
      <div className={`mt-1 font-mono text-[1.375rem] font-semibold tabular-nums ${accent ? 'text-acc' : 'text-ink'}`}>
        {value}
      </div>
      {sub && <div className="font-mono text-nano text-ink-muted">{sub}</div>}
    </div>
  );
}

// Read-only Garmin-sourced records: personal bests + current race predictions.
// These are ingest-owned (not user-edited), so they're displayed, never editable.
function GarminRecords() {
  const prs = useFetch(() => api.personalRecords());
  const preds = useFetch(() => api.racePredictions());
  return (
    <div className="space-y-6 border-t border-line pt-6">
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
              <RecordCard key={p.label} label={p.label} value={p.display} accent />
            ))}
          </div>
          {preds.data?.calendar_date && (
            <p className="mt-2 font-mono text-nano text-ink-muted">
              As of {preds.data.calendar_date}
            </p>
          )}
        </StateWrap>
      </Group>
    </div>
  );
}

// Facts the coach has silently remembered from chats (race debriefs, illnesses,
// context for training gaps). Server-side, not part of the profile save —
// deleting a fact applies immediately.
function CoachMemory() {
  const { data, loading, error } = useFetch(() => api.coachMemory());
  const [facts, setFacts] = useState(null);
  const [delError, setDelError] = useState(null);
  useEffect(() => { if (data) setFacts(data); }, [data]);
  const list = facts || [];

  const forget = async (id) => {
    setDelError(null);
    try {
      await api.forgetMemory(id);
      setFacts((f) => (f || []).filter((m) => m.id !== id));
    } catch (e) {
      setDelError(e);
    }
  };

  return (
    <div className="border-t border-line pt-6">
      <Group
        title="Coach memory"
        hint="Facts the coach quietly remembers from your chats — race debriefs, illnesses, context. Delete anything wrong or stale (applies immediately)."
      >
        <StateWrap loading={loading} error={error}>
          {list.length === 0 && (
            <p className="font-body text-sm text-ink-muted">Nothing remembered yet.</p>
          )}
          {list.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <div className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <span className="font-mono text-nano text-ink-muted">
                  {(m.created_at || '').slice(0, 10)}
                </span>
                <span className="ml-2 font-body text-sm text-ink">{m.content}</span>
              </div>
              <DelBtn onClick={() => forget(m.id)} label="Forget fact" />
            </div>
          ))}
          {delError && (
            <p className="font-body text-micro text-sem-red">
              Couldn’t delete: {delError.message}
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
  const [routines, setRoutines] = useState([]);
  const [notes, setNotes] = useState('');
  const [icalUrl, setIcalUrl] = useState('');
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
    setRoutines(data.routines || []);
    setNotes(data.general_notes || '');
    setIcalUrl(data.runna_ical_url || '');
  }, [data]);

  const dirty = () => setStatus(null);
  const patch = (setter) => (i, p) => { setter((a) => a.map((r, j) => (j === i ? { ...r, ...p } : r))); dirty(); };
  const remove = (setter) => (i) => { setter((a) => a.filter((_, j) => j !== i)); dirty(); };
  const setShoe = patch(setShoes);
  const setRace = patch(setRaces);
  const setRoutine = patch(setRoutines);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await api.saveProfile({
        // Drop fully-empty rows so blanks don't accumulate.
        shoes: shoes.filter((s) => s.name?.trim() || s.purpose?.trim()),
        races: races.filter((r) => r.name?.trim() || r.date || r.goal_time?.trim()),
        injuries: injuries.map((s) => s.trim()).filter(Boolean),
        routines: routines
          .filter((r) => r.activity?.trim())
          .map((r) => ({
            activity: r.activity.trim(),
            day: r.day || '',
            intensity: r.intensity === '' || r.intensity == null ? null : Number(r.intensity),
          })),
        general_notes: notes,
        runna_ical_url: icalUrl.trim(),
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-2xl rounded-2xl border border-line bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="border-l-2 border-l-acc pl-3">
            <h2 className="font-display text-heading font-extrabold uppercase tracking-tight text-acc">
              Coaching profile
            </h2>
            <p className="mt-1 font-body text-micro uppercase tracking-[0.14em] text-ink-muted">
              Context injected into AI-coach prompts
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-line px-2.5 py-1 text-sm text-ink-secondary transition hover:bg-surface-2"
          >
            ✕
          </button>
        </header>

        <div className="space-y-6 p-5">
          <div className="border-b border-line pb-6">
            <AccentPicker />
          </div>
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

            <Group title="Other regular activities" hint="Recurring sessions the coach should know about — football, gym, cycling, etc.">
              {routines.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${inputCls} min-w-[10rem] flex-1`}
                    placeholder="Activity (e.g. Football)"
                    value={r.activity || ''}
                    onChange={(e) => setRoutine(i, { activity: e.target.value })}
                  />
                  <select
                    className={`${inputCls} w-28`}
                    value={r.day || ''}
                    onChange={(e) => setRoutine(i, { day: e.target.value })}
                  >
                    <option value="">Any day</option>
                    {DAYS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    className={`${inputCls} w-28`}
                    placeholder="Intensity 1–10"
                    value={r.intensity ?? ''}
                    onChange={(e) => setRoutine(i, { intensity: e.target.value })}
                  />
                  <DelBtn onClick={() => remove(setRoutines)(i)} label="Remove activity" />
                </div>
              ))}
              <button type="button" className={addBtnCls} onClick={() => { setRoutines((a) => [...a, { activity: '', day: '', intensity: '' }]); dirty(); }}>
                + Add activity
              </button>
            </Group>

            <Group title="Runna calendar feed" hint="Runna's iCal subscription URL — ingest pulls the full plan from it (Garmin only syncs ~2 weeks)">
              <input
                className={inputCls}
                type="url"
                placeholder="https://… or webcal://… feed URL"
                value={icalUrl}
                onChange={(e) => { setIcalUrl(e.target.value); dirty(); }}
              />
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

            <div className="flex items-center gap-3 border-t border-line pt-4">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-acc px-4 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save profile'}
              </button>
              {status === 'saved' && <span className="text-sm text-acc">Saved ✓</span>}
              {status?.error && (
                <span className="text-sm text-sem-red">Couldn’t save: {status.error.message}</span>
              )}
            </div>
          </StateWrap>

          <CoachMemory />

          <GarminRecords />
        </div>
      </div>
    </div>
  );
}
