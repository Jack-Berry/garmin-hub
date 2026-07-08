import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon, Markdown } from './ui';
import { shortDate } from './format';
import { PacerPreview } from './PacerPreview';
import { PlanReview } from './PlanReview';

// Floating chat coach — a discreet bottom-right widget that answers training
// questions using the same context engine as the daily insight. Conversation
// lives in React state only (no persistence): it resets on reload or when the
// panel is cleared. The client sends the full message array each turn; the
// server is stateless.
//
// Three modes share the panel:
//   'chat'     — the Sonnet analyst (default, unchanged).
//   'planning' — routes turns to /api/coach/plan. When a turn returns a spec,
//                we preview it inline (api.pacerPreview) and offer a per-turn
//                "Push to Garmin" button (api.pacerPush) — the pacer flow lifted
//                into the conversation. The panel gets an accent border while
//                active; it auto-exits when the coach signals `done`.
//   'composer' — Stage 9b: routes turns to /api/coach/compose. A returned plan
//                (already guard-validated per session, server-side) renders as
//                a week-by-week PlanReview with a Save button (api.savePlan —
//                a DB write only, no Garmin). Wider panel while active.
// Assistant messages may carry { spec, preview, previewError, pushed, specError,
// duplicate, apiContent } for the inline preview attached to that turn.
// `apiContent` is what goes to the API instead of `content`: turns that carried
// a spec get a "[spec emitted: …]" marker appended, so the model's history
// shows WHICH sessions it already presented (the fence itself is stripped
// server-side and never stored — without the marker the model believes it
// never presented anything and re-emits).

// Same spec, already pushed in this thread? Keyed on name+date — the only
// stable identity a spec has before Garmin assigns an id.
const alreadyPushed = (msgs, spec) =>
  msgs.some((m) => m.pushed && m.spec &&
    m.spec.name === spec.name && m.spec.date === spec.date);

// Strip UI-only fields for the API; prefer the marker-stamped variant.
const toPayload = (msgs) =>
  msgs.map((m) => ({ role: m.role, content: m.apiContent ?? m.content }));

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('chat'); // 'chat' | 'planning' | 'composer'
  const [messages, setMessages] = useState([]); // [{role, content, spec?, preview?, previewError?, pushed?, plan?, savedPlan?}]
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [pushingIdx, setPushingIdx] = useState(null);
  const [savingIdx, setSavingIdx] = useState(null);
  const [error, setError] = useState(null);
  // Copy-context state: 'idle' | 'copying' | 'copied' | 'error'. `fallbackText`
  // holds the dump when the clipboard API is unavailable, so it can be shown in
  // a selectable area for manual copy.
  const [copyState, setCopyState] = useState('idle');
  const [fallbackText, setFallbackText] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const planning = mode === 'planning';
  const composer = mode === 'composer';

  // Auto-grow the input with its content: reset to the natural (rows=3) height,
  // then fit scrollHeight. The max-h class caps it around 8 rows, after which
  // the textarea scrolls internally. Re-runs on open so the panel remounting
  // the textarea starts at the right size.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input, open]);

  // Fetch the full coaching context as a pasteable block and copy it to the
  // clipboard. Falls back to a selectable textarea if the clipboard is blocked.
  const copyContext = async () => {
    if (copyState === 'copying') return;
    setCopyState('copying');
    setFallbackText(null);
    try {
      const { dump } = await api.contextDump();
      try {
        await navigator.clipboard.writeText(dump);
        setCopyState('copied');
        setTimeout(() => setCopyState('idle'), 2000);
      } catch {
        // No clipboard permission — show the text for manual selection/copy.
        setFallbackText(dump);
        setCopyState('idle');
      }
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2500);
    }
  };

  // Keep the message area pinned to the latest turn.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, open]);

  // Chat / planning / composer threads can't share history (different system
  // prompts), so entering a mode starts fresh — same spirit as the accepted
  // "refresh wipes the conversation" limitation. Exiting manually also clears;
  // nothing half-commits (pushes and the plan save are atomic and confirmed).
  const enterMode = (m) => {
    if (pending) return;
    setMode(m);
    setMessages([]);
    setError(null);
  };

  // Run one planning turn: send `nextMessages` to the coach, attach any inline
  // preview to the reply, and apply the done/auto-exit gate. Shared by manual
  // sends and the post-push auto-advance. The only follow-up it can fire
  // itself is the single guard-failure relay below (`canRelayFailure` blocks
  // re-entry, so a coach that keeps emitting rejected specs can't loop) —
  // push auto-advance still lives only in push()'s success path.
  const runPlanTurn = async (nextMessages, canRelayFailure = true) => {
    setError(null);
    setPending(true);
    try {
      const { reply, spec, done, specError } = await api.plan(toPayload(nextMessages));
      let assistant = { role: 'assistant', content: reply };
      let failNote = null;
      if (spec) {
        // Marker for the model's history — see toPayload/apiContent above.
        assistant.apiContent =
          `${reply}\n\n[spec emitted: ${spec.name || 'session'} for ${spec.date || 'unscheduled'}]`;
        if (alreadyPushed(nextMessages, spec)) {
          // Re-presented session that already went to Garmin — never offer a
          // second push (double-booking); render an "already pushed" note.
          assistant = { ...assistant, spec, duplicate: true };
        } else {
          try {
            const preview = await api.pacerPreview(spec);
            assistant = { ...assistant, spec, preview };
          } catch (e) {
            const msg = e.message || 'Preview failed';
            assistant = { ...assistant, spec, previewError: msg };
            // Relay the guard rejection to the coach (mirrors the [Pushed:]
            // note) so it can fix and re-emit without the athlete having to
            // copy error text around.
            failNote = {
              role: 'user',
              system: true,
              content: `[Preview failed: ${msg} — the spec was rejected by the guard before the athlete saw it. Fix exactly what the error names and re-emit the corrected spec for this same session.]`,
            };
          }
        }
      } else if (specError) {
        // Server already retried once; surface the dead end to the athlete.
        assistant = { ...assistant, specError: true };
      }
      const withReply = failNote
        ? [...nextMessages, assistant, failNote]
        : [...nextMessages, assistant];
      setMessages(withReply);
      if (failNote && canRelayFailure) {
        await runPlanTurn(withReply, false);
        return;
      }
      // Coach signalled the plan is complete — drop back to the analyst but
      // keep the transcript so the finished plan stays visible. Gate the
      // auto-exit on a REAL push having happened in the thread: a bare
      // completion claim with no actual push (a phantom "all done") must not
      // silently end planning. Staying put keeps the discrepancy visible (no
      // card, no ✓). "Pushed ✓" is only ever set by an api.pacerPush result,
      // never by coach prose — so this reads structural push state, not text.
      // The final push's stamped turn is in nextMessages, so the last session
      // acknowledges + [[PLAN_COMPLETE]] and this exits cleanly.
      if (done && withReply.some((m) => m.pushed)) setMode('chat');
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setPending(false);
    }
  };

  // Run one composer turn (Stage 9b). The server already guard-validated every
  // session of a returned plan; if any are invalid, relay the errors back to
  // the coach ONCE (same pattern as the planning guard-failure relay) so it
  // re-emits a corrected plan without the athlete copying error text around.
  const runComposeTurn = async (nextMessages, canRelayInvalid = true) => {
    setError(null);
    setPending(true);
    try {
      const { reply, plan, planError } = await api.compose(toPayload(nextMessages));
      let assistant = { role: 'assistant', content: reply };
      let invalidNote = null;
      if (plan) {
        const invalid = plan.sessions.filter((s) => !s.valid);
        const first = plan.sessions[0]?.date, last = plan.sessions[plan.sessions.length - 1]?.date;
        assistant.plan = plan;
        // Marker for the model's history (fences are stripped server-side).
        assistant.apiContent =
          `${reply}\n\n[plan emitted: ${plan.sessions.length} sessions, ${first} to ${last}${invalid.length ? `, ${invalid.length} invalid` : ''}]`;
        if (invalid.length) {
          invalidNote = {
            role: 'user',
            system: true,
            content: `[Plan validation failed for ${invalid.length} session(s): ${invalid
              .map((s) => `"${s.name || s.date}" — ${s.error}`)
              .join('; ')}. Fix exactly what each error names and re-emit the complete corrected plan.]`,
          };
        }
      } else if (planError) {
        assistant = { ...assistant, planError: true };
      }
      const withReply = invalidNote
        ? [...nextMessages, assistant, invalidNote]
        : [...nextMessages, assistant];
      setMessages(withReply);
      if (invalidNote && canRelayInvalid) await runComposeTurn(withReply, false);
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setPending(false);
    }
  };

  // Save the plan attached to message `i` — a DB write only (no Garmin; that's
  // a later stage). On success, stamp the turn, note it for the transcript, and
  // drop back to the analyst (the plan now shows up via the normal dashboard).
  const savePlan = async (i) => {
    const msg = messages[i];
    if (!composer || !msg?.plan || savingIdx != null || pending) return;
    setSavingIdx(i);
    setError(null);
    try {
      // Review-only fields stay client-side; the server re-validates the specs.
      // Plan-level metadata (name/goal/summary/weeks) rides along for the
      // plans parent row (Stage 9c).
      const sessions = msg.plan.sessions.map(({ valid, error, preview, ...s }) => s);
      const res = await api.savePlan({
        name: msg.plan.name, goal_race: msg.plan.goal_race,
        summary: msg.plan.summary, weeks: msg.plan.weeks, sessions,
      });
      setMessages([
        ...messages.map((m, j) => (j === i ? { ...m, savedPlan: res } : m)),
        {
          role: 'user',
          system: true,
          content: `[Plan saved: ${res.sessions} sessions, ${res.from} to ${res.to}. It now drives the dashboard and coach; push it to Garmin from the dashboard's "Activate plan" card.]`,
        },
      ]);
      setMode('chat');
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSavingIdx(null);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || pending) return;
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    if (planning) {
      await runPlanTurn(next);
      return;
    }
    if (composer) {
      await runComposeTurn(next);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const { reply } = await api.chat(toPayload(next));
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setPending(false);
    }
  };

  // Push the spec attached to message `i` to Garmin. Stamps `pushed` on that
  // turn on success (the ONLY thing that sets `pushed`, so "Pushed ✓" stays a
  // real-push-only state), then auto-advances: appends a clearly-marked system
  // turn telling the coach the push landed and fires one planning turn so it
  // moves to the next session with no manual input. One auto-advance per human
  // push — the `pushingIdx`/`pending` guards block re-entry, and runPlanTurn
  // never fires a follow-up of its own.
  const push = async (i) => {
    const msg = messages[i];
    // Planning-only: a leftover Push button after the mode exits must not
    // fire a planning turn into a chat thread. Duplicate/pushed specs never
    // push twice (name+date identity).
    if (!planning || !msg?.spec || msg.duplicate || pushingIdx != null || pending) return;
    if (alreadyPushed(messages, msg.spec)) {
      setError(`Already pushed "${msg.spec.name}" for ${msg.spec.date}.`);
      return;
    }
    setPushingIdx(i);
    setError(null);
    try {
      const res = await api.pacerPush(msg.spec);
      const advanced = messages.map((m, j) => (j === i ? { ...m, pushed: res } : m));
      // Structured confirmation so the coach reads it unambiguously as "this
      // session is done" and never re-presents it. `system: true` renders it as
      // a muted line (the app spoke, not the user) and is stripped for the API.
      const note = {
        role: 'user',
        system: true,
        content: `[Pushed: ${res.name} — now scheduled on Garmin. Continue with the next agreed session, or acknowledge completion if it was the last.]`,
      };
      const next = [...advanced, note];
      setMessages(next);
      await runPlanTurn(next);
    } catch (e) {
      setError(e.message || 'Push failed');
    } finally {
      setPushingIdx(null);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Collapsed: just the launcher button.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open coach chat"
        className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-acc text-2xl text-acc-ink shadow-lg transition hover:opacity-90"
      >
        <Icon name="message-circle" />
      </button>
    );
  }

  return (
    <div
      className={`fixed bottom-5 right-5 z-40 flex flex-col overflow-hidden rounded-2xl border bg-surface-1 shadow-xl ${
        composer
          ? 'h-[620px] w-[560px]'
          : 'h-[500px] w-[360px]'
      } max-w-[calc(100vw-2.5rem)] ${planning || composer ? 'border-acc' : 'border-line'}`}
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="font-display text-[0.9375rem] font-bold uppercase tracking-[0.1em] text-ink">
            Coach
          </h2>
          {planning || composer ? (
            <p className="mt-0.5 font-body text-nano uppercase tracking-[0.18em] text-acc">
              {planning ? 'Planning mode' : 'Plan composer'}
            </p>
          ) : (
            <p className="mt-0.5 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
              Asks the data, not the workout plan
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {planning || composer ? (
            <button
              onClick={() => enterMode('chat')}
              disabled={pending}
              className="rounded-lg border border-line px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50"
            >
              {planning ? 'Exit planning' : 'Exit composer'}
            </button>
          ) : (
            <>
              <button
                onClick={() => enterMode('planning')}
                disabled={pending}
                title="Plan and push a workout to Garmin"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50"
              >
                <Icon name="stopwatch" /> Plan
              </button>
              <button
                onClick={() => enterMode('composer')}
                disabled={pending}
                title="Compose an adapted multi-week plan (replaces the Runna block content)"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50"
              >
                <Icon name="calendar" /> Adapt
              </button>
              <button
                onClick={copyContext}
                disabled={copyState === 'copying'}
                title="Copy your full training context to paste into another chat (Claude, ChatGPT, etc.)"
                aria-label="Copy training context"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50"
              >
                {copyState === 'copied' ? 'Copied ✓'
                  : copyState === 'error' ? 'Failed'
                  : copyState === 'copying' ? '…'
                  : <><Icon name="clipboard" /> Context</>}
              </button>
              {messages.length > 0 && (
                <button
                  onClick={() => { setMessages([]); setError(null); }}
                  aria-label="Clear conversation"
                  className="rounded-lg border border-line px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-2"
                >
                  Clear
                </button>
              )}
            </>
          )}
          <button
            onClick={() => setOpen(false)}
            aria-label="Minimise chat"
            className="rounded-lg border border-line px-2.5 py-1 text-sm text-ink-secondary transition hover:bg-surface-2"
          >
            ✕
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="mt-2 text-center text-xs text-ink-muted">
            {planning
              ? 'Planning mode — describe the week or session you want, and the coach will propose it, then build and push each session for your approval.'
              : composer
                ? 'Plan composer — the coach reads your Runna block and proposes an adapted plan (same skeleton, its own sessions). You review week by week, then save it to your calendar.'
                : 'Ask about your training — paces, recovery, whether a goal is realistic, why a run felt hard.'}
          </p>
        )}
        {messages.map((m, i) => (
          m.system ? (
            // Auto-advance confirmation — the app spoke, not the user.
            <p key={i} className="px-2 text-center text-xs italic text-ink-muted">{m.content}</p>
          ) : (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-acc px-3 py-2 text-sm text-acc-ink">
                {m.content}
              </div>
            ) : (
              <>
                <Markdown className="max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-2 px-3 py-2 font-body text-sm text-ink">
                  {m.content}
                </Markdown>
                {m.specError && (
                  <p className="mt-2 text-xs text-sem-red">
                    The coach tried to present a session but its spec couldn't be read.
                    Ask it to re-send the session.
                  </p>
                )}
                {m.planError && (
                  <p className="mt-2 text-xs text-sem-red">
                    The coach tried to present a plan but it couldn't be read.
                    Ask it to re-send the plan.
                  </p>
                )}
                {m.plan && (
                  <div className="mt-2 w-full">
                    <PlanReview
                      plan={m.plan}
                      active={composer}
                      saving={savingIdx === i}
                      saved={m.savedPlan}
                      onSave={() => savePlan(i)}
                    />
                  </div>
                )}
                {m.previewError && (
                  <p className="mt-2 text-xs text-sem-red">Couldn't build preview: {m.previewError}</p>
                )}
                {m.duplicate && (
                  <p className="mt-2 text-xs text-ink-muted">
                    Already pushed — <span className="font-medium">{m.spec.name}</span> is on
                    Garmin for {shortDate(m.spec.date)}. Ask the coach to rename it if this
                    is a deliberate revision.
                  </p>
                )}
                {m.preview && (
                  <div className="mt-2 w-full space-y-2">
                    <PacerPreview preview={m.preview} date={m.spec.date} />
                    {m.pushed ? (
                      <p className="text-xs text-ink-secondary">
                        Pushed ✓ <span className="font-medium">{m.pushed.name}</span> scheduled for{' '}
                        {shortDate(m.pushed.date)} · ID{' '}
                        <span className="font-mono">{m.pushed.workout_id}</span>
                      </p>
                    ) : planning ? (
                      <button
                        onClick={() => push(i)}
                        disabled={pushingIdx != null || pending}
                        className="rounded-lg bg-acc px-3 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
                      >
                        {pushingIdx === i ? 'Pushing…' : 'Push to Garmin'}
                      </button>
                    ) : (
                      <p className="text-xs text-ink-muted">
                        Not pushed — planning ended. Re-enter planning to push this session.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          )
        ))}
        {pending && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-surface-2 px-3 py-2 text-sm text-ink-muted">
              thinking…
            </div>
          </div>
        )}
        {error && <p className="text-center text-xs text-sem-red">{error}</p>}
      </div>

      {fallbackText && (
        <div className="border-t border-line p-3">
          <p className="mb-1 text-[11px] text-ink-muted">
            Clipboard blocked — select all and copy manually:
          </p>
          <textarea
            readOnly
            value={fallbackText}
            onFocus={(e) => e.target.select()}
            className="h-28 w-full resize-none rounded-lg border border-line bg-surface-2 px-2 py-1 font-mono text-[11px] text-ink-secondary"
          />
        </div>
      )}

      <div className="border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              planning ? 'Reply, or say "too fast" / "skip this"…'
              : composer ? 'Describe the adaptation you want, or reply to the outline…'
              : 'Ask your coach… (Shift+Enter for a new line)'
            }
            className="max-h-[178px] flex-1 resize-none overflow-y-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-muted focus:border-acc focus:ring-2 focus:ring-acc/20"
          />
          <button
            onClick={send}
            disabled={pending || !input.trim()}
            className="rounded-lg bg-acc px-3 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
