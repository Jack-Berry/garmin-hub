import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Markdown, Icon } from './ui';
import { shortDate } from './format';
import { PacerPreview } from './PacerPreview';

// New-pacer builder (Stage 5c). Three steps in one modal:
//   1. distance  — the run distance, entered first.
//   2. chat      — a short Sonnet-guided Q&A (api.pacerChat) that gathers
//                  target / strategy / warmup / cooldown / date. The AI only
//                  proposes params; it never pushes.
//   3. preview   — a deterministic build (api.pacerPreview) shown for approval.
//                  Only the explicit "Push to Garmin" click writes (pacerPush).
const inputCls =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-muted focus:border-acc focus:ring-2 focus:ring-acc/20';

const primaryBtn =
  'rounded-lg bg-acc px-4 py-2 text-sm font-medium text-acc-ink transition hover:opacity-90 disabled:opacity-50';

const ghostBtn =
  'rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50';

export default function PacerModal({ onClose }) {
  // 'distance' | 'chat' | 'preview'
  const [step, setStep] = useState('distance');
  const [distance, setDistance] = useState('');
  const [messages, setMessages] = useState([]); // [{role, content}]
  const [input, setInput] = useState('');
  const [params, setParams] = useState(null);
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [pushed, setPushed] = useState(null); // { workout_id, name, date }
  const scrollRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, step]);

  // Send one chat turn. If the AI returns complete params, fetch the preview.
  const sendTurn = async (next) => {
    setMessages(next);
    setError(null);
    setPending(true);
    try {
      const { reply, params: p } = await api.pacerChat(next);
      setMessages([...next, { role: 'assistant', content: reply }]);
      if (p) {
        setParams(p);
        const pv = await api.pacerPreview(p);
        setPreview(pv);
        setStep('preview');
      }
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setPending(false);
    }
  };

  // Start: seed the conversation with the distance and let the AI take over.
  const startChat = () => {
    const d = distance.trim();
    if (!d || pending) return;
    setStep('chat');
    sendTurn([{ role: 'user', content: `I want to set up a pacer for ${d}.` }]);
  };

  const send = () => {
    const text = input.trim();
    if (!text || pending) return;
    setInput('');
    sendTurn([...messages, { role: 'user', content: text }]);
  };

  const push = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.pacerPush(params);
      setPushed(res);
    } catch (e) {
      setError(e.message || 'Push failed');
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      step === 'distance' ? startChat() : send();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="inline-flex items-center gap-1.5 font-display text-[0.9375rem] font-bold uppercase tracking-[0.1em] text-ink">
              <Icon name="stopwatch" /> New pacer
            </h2>
            <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
              Build a per-segment pace target for your Engo 3 glasses
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

        {/* Step 1 — distance */}
        {step === 'distance' && (
          <div className="space-y-4 p-5">
            <div>
              <label className="font-body text-sm font-medium text-ink">
                Distance of the run
              </label>
              <p className="mb-2 mt-0.5 text-xs text-ink-muted">
                e.g. 5k, 10k, or 5000m. We'll ask the rest in a moment.
              </p>
              <input
                autoFocus
                className={inputCls}
                placeholder="5k"
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
            <button className={primaryBtn} onClick={startChat} disabled={!distance.trim()}>
              Start
            </button>
          </div>
        )}

        {/* Step 2 — conversational Q&A */}
        {step === 'chat' && (
          <>
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {messages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  {m.role === 'user' ? (
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-acc px-3 py-2 text-sm text-acc-ink">
                      {m.content}
                    </div>
                  ) : (
                    <Markdown className="max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-2 px-3 py-2 font-body text-sm text-ink">
                      {m.content}
                    </Markdown>
                  )}
                </div>
              ))}
              {pending && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-sm bg-surface-2 px-3 py-2 text-sm text-ink-muted">
                    {params ? 'building preview…' : 'thinking…'}
                  </div>
                </div>
              )}
              {error && <p className="text-center text-xs text-sem-red">{error}</p>}
            </div>
            <div className="border-t border-line p-3">
              <div className="flex items-end gap-2">
                <textarea
                  rows={1}
                  autoFocus
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Type your answer…"
                  className="max-h-32 flex-1 resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-muted focus:border-acc focus:ring-2 focus:ring-acc/20"
                />
                <button onClick={send} disabled={pending || !input.trim()} className={primaryBtn}>
                  Send
                </button>
              </div>
            </div>
          </>
        )}

        {/* Step 3 — preview + push */}
        {step === 'preview' && preview && (
          <div className="space-y-4 overflow-y-auto p-5">
            {pushed ? (
              <div className="space-y-3 text-center">
                <div className="text-3xl">✅</div>
                <p className="font-body text-sm font-semibold text-ink">
                  Pushed to Garmin
                </p>
                <p className="text-sm text-ink-secondary">
                  <span className="font-medium">{pushed.name}</span> is scheduled for{' '}
                  {shortDate(pushed.date)}.
                </p>
                <p className="text-xs text-ink-muted">
                  Garmin workout ID <span className="font-mono">{pushed.workout_id}</span>. It'll
                  sync to your watch next time the Garmin Connect app is open near it.
                </p>
                <button className={primaryBtn} onClick={onClose}>Done</button>
              </div>
            ) : (
              <>
                <PacerPreview preview={preview} date={params.date} />

                {error && <p className="text-center text-sm text-sem-red">{error}</p>}

                <div className="flex items-center gap-2">
                  <button className={primaryBtn} onClick={push} disabled={pending}>
                    {pending ? 'Pushing…' : 'Push to Garmin'}
                  </button>
                  <button
                    className={ghostBtn}
                    onClick={() => { setStep('chat'); setError(null); }}
                    disabled={pending}
                  >
                    Back to chat
                  </button>
                  <span className="text-xs text-ink-muted">
                    Writes to Garmin — you can delete it after.
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
