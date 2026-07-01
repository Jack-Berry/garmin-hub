import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon, Markdown } from './ui';
import { shortDate } from './format';
import { PacerPreview } from './PacerPreview';

// Floating chat coach — a discreet bottom-right widget that answers training
// questions using the same context engine as the daily insight. Conversation
// lives in React state only (no persistence): it resets on reload or when the
// panel is cleared. The client sends the full message array each turn; the
// server is stateless.
//
// Two modes share the panel:
//   'chat'     — the Sonnet analyst (default, unchanged).
//   'planning' — routes turns to /api/coach/plan. When a turn returns a spec,
//                we preview it inline (api.pacerPreview) and offer a per-turn
//                "Push to Garmin" button (api.pacerPush) — the pacer flow lifted
//                into the conversation. The panel gets an accent border while
//                active; it auto-exits when the coach signals `done`.
// Assistant messages may carry { spec, preview, previewError, pushed } for the
// inline preview attached to that turn.
export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('chat'); // 'chat' | 'planning'
  const [messages, setMessages] = useState([]); // [{role, content, spec?, preview?, previewError?, pushed?}]
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [pushingIdx, setPushingIdx] = useState(null);
  const [error, setError] = useState(null);
  // Copy-context state: 'idle' | 'copying' | 'copied' | 'error'. `fallbackText`
  // holds the dump when the clipboard API is unavailable, so it can be shown in
  // a selectable area for manual copy.
  const [copyState, setCopyState] = useState('idle');
  const [fallbackText, setFallbackText] = useState(null);
  const scrollRef = useRef(null);

  const planning = mode === 'planning';

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

  // A chat and a planning thread can't share history (different system prompts),
  // so entering planning starts fresh — same spirit as the accepted "refresh
  // wipes the conversation" limitation.
  const startPlanning = () => {
    if (pending) return;
    setMode('planning');
    setMessages([]);
    setError(null);
  };

  // Manual bail: back to the analyst with a clean thread. Nothing half-commits —
  // each push was atomic and separately confirmed.
  const exitPlanning = () => {
    if (pending) return;
    setMode('chat');
    setMessages([]);
    setError(null);
  };

  // Run one planning turn: send `nextMessages` to the coach, attach any inline
  // preview to the reply, and apply the done/auto-exit gate. Shared by manual
  // sends and the post-push auto-advance. Deliberately does NOT fire any
  // follow-up itself — auto-advance lives only in push()'s success path, so the
  // coach presenting the next session's spec never auto-triggers anything.
  const runPlanTurn = async (nextMessages) => {
    setError(null);
    setPending(true);
    // Only role/content go to the API — strip inline-preview and `system` flags.
    const payload = nextMessages.map(({ role, content }) => ({ role, content }));
    try {
      const { reply, spec, done } = await api.plan(payload);
      let assistant = { role: 'assistant', content: reply };
      if (spec) {
        try {
          const preview = await api.pacerPreview(spec);
          assistant = { ...assistant, spec, preview };
        } catch (e) {
          assistant = { ...assistant, spec, previewError: e.message || 'Preview failed' };
        }
      }
      setMessages([...nextMessages, assistant]);
      // Coach signalled the plan is complete — drop back to the analyst but
      // keep the transcript so the finished plan stays visible. Gate the
      // auto-exit on a REAL push having happened in the thread: a bare
      // completion claim with no actual push (a phantom "all done") must not
      // silently end planning. Staying put keeps the discrepancy visible (no
      // card, no ✓). "Pushed ✓" is only ever set by an api.pacerPush result,
      // never by coach prose — so this reads structural push state, not text.
      // The final push's stamped turn is in nextMessages, so the last session
      // acknowledges + [[PLAN_COMPLETE]] and this exits cleanly.
      if (done && nextMessages.some((m) => m.pushed)) setMode('chat');
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setPending(false);
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
    setError(null);
    setPending(true);
    const payload = next.map(({ role, content }) => ({ role, content }));
    try {
      const { reply } = await api.chat(payload);
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
    if (!msg?.spec || pushingIdx != null || pending) return;
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
      className={`fixed bottom-5 right-5 z-40 flex h-[500px] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border bg-surface-1 shadow-xl ${
        planning ? 'border-acc' : 'border-line'
      }`}
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="font-display text-[0.9375rem] font-bold uppercase tracking-[0.1em] text-ink">
            Coach
          </h2>
          {planning ? (
            <p className="mt-0.5 font-body text-nano uppercase tracking-[0.18em] text-acc">
              Planning mode
            </p>
          ) : (
            <p className="mt-0.5 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
              Asks the data, not the workout plan
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {planning ? (
            <button
              onClick={exitPlanning}
              disabled={pending}
              className="rounded-lg border border-line px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50"
            >
              Exit planning
            </button>
          ) : (
            <>
              <button
                onClick={startPlanning}
                disabled={pending}
                title="Plan and push a workout to Garmin"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50"
              >
                <Icon name="stopwatch" /> Plan
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
                {m.previewError && (
                  <p className="mt-2 text-xs text-sem-red">Couldn't build preview: {m.previewError}</p>
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
                    ) : (
                      <button
                        onClick={() => push(i)}
                        disabled={pushingIdx != null || pending}
                        className="rounded-lg bg-acc px-3 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50"
                      >
                        {pushingIdx === i ? 'Pushing…' : 'Push to Garmin'}
                      </button>
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
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={planning ? 'Reply, or say "too fast" / "skip this"…' : 'Ask your coach…'}
            className="max-h-32 flex-1 resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-muted focus:border-acc focus:ring-2 focus:ring-acc/20"
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
