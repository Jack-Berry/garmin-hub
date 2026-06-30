import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Markdown } from './ui';

// On-demand coaching modal for a clicked week-strip day. Generates its insight
// via generate() on mount (a stateless POST returning { content, model }),
// unless staticBody is supplied (e.g. rest days — no API call). Below the
// insight it's a mini-chat: follow-ups reuse the FULL coaching context via
// /api/coach/chat, seeded with this day (a framing user turn + the generated
// insight as the assistant's opening message), so questions can range across
// the whole training picture, not just the clicked day. Chat lives in component
// state only — not persisted. Matches the floating ChatWidget's UX.
export default function InsightModal({ title, subtitle, generate, staticBody, chatSeed, onClose }) {
  const [status, setStatus] = useState(staticBody ? 'done' : 'loading');
  const [content, setContent] = useState(staticBody || '');
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);

  // Mini-chat: only the visible follow-up turns. The seed (framing turn + the
  // generated insight as the assistant's opening message) is prepended at send.
  const [chat, setChat] = useState([]); // [{role, content}]
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [chatError, setChatError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (staticBody) return;
    let alive = true;
    generate()
      .then((r) => alive && (setContent(r.content), setModel(r.model), setStatus('done')))
      .catch((e) => alive && (setError(e.message || 'Something went wrong'), setStatus('error')));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the thread pinned to the latest follow-up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, pending]);

  const send = async () => {
    const text = input.trim();
    if (!text || pending) return;
    const next = [...chat, { role: 'user', content: text }];
    setChat(next);
    setInput('');
    setChatError(null);
    setPending(true);
    try {
      // Prepend the seed so the coach has both the day and (via the endpoint)
      // the full training context. The visible thread is everything after it.
      const { reply } = await api.chat([
        { role: 'user', content: chatSeed },
        { role: 'assistant', content },
        ...next,
      ]);
      setChat([...next, { role: 'assistant', content: reply }]);
    } catch (e) {
      setChatError(e.message || 'Something went wrong');
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const canChat = chatSeed && status === 'done' && content;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-[0.9375rem] font-bold uppercase tracking-[0.1em] text-ink">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 truncate font-body text-nano uppercase tracking-[0.18em] text-ink-muted">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-sm text-ink-secondary transition hover:bg-surface-2"
          >
            ✕
          </button>
        </header>

        <div ref={scrollRef} className="overflow-y-auto px-5 py-5">
          {status === 'loading' ? (
            <p className="text-sm text-ink-muted">
              <span className="mr-1 inline-block animate-spin">⟳</span> Thinking…
            </p>
          ) : status === 'error' ? (
            <p className="text-sm text-sem-red">Couldn't generate: {error}</p>
          ) : (
            <>
              <Markdown className="font-body text-[15px] leading-relaxed text-ink-secondary">
                {content}
              </Markdown>
              {model && (
                <p className="mt-4 font-mono text-micro text-ink-muted">{model}</p>
              )}

              {canChat && (chat.length > 0 || pending) && (
                <div className="mt-5 space-y-3 border-t border-line pt-4">
                  {chat.map((m, i) => (
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
                        thinking…
                      </div>
                    </div>
                  )}
                  {chatError && <p className="text-center text-xs text-sem-red">{chatError}</p>}
                </div>
              )}
            </>
          )}
        </div>

        {canChat && (
          <div className="border-t border-line p-3">
            <div className="flex items-end gap-2">
              <textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask a follow-up…"
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
        )}
      </div>
    </div>
  );
}
