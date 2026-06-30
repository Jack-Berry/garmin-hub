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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-sm text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </header>

        <div ref={scrollRef} className="overflow-y-auto px-5 py-5">
          {status === 'loading' ? (
            <p className="text-sm text-slate-400 dark:text-slate-500">
              <span className="mr-1 inline-block animate-spin">⟳</span> Thinking…
            </p>
          ) : status === 'error' ? (
            <p className="text-sm text-rose-500">Couldn't generate: {error}</p>
          ) : (
            <>
              <Markdown className="text-[15px] leading-relaxed text-slate-700 dark:text-slate-300">
                {content}
              </Markdown>
              {model && (
                <p className="mt-4 text-[11px] text-slate-400 dark:text-slate-500">{model}</p>
              )}

              {canChat && (chat.length > 0 || pending) && (
                <div className="mt-5 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                  {chat.map((m, i) => (
                    <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                      {m.role === 'user' ? (
                        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-500 px-3 py-2 text-sm text-white">
                          {m.content}
                        </div>
                      ) : (
                        <Markdown className="max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                          {m.content}
                        </Markdown>
                      )}
                    </div>
                  ))}
                  {pending && (
                    <div className="flex justify-start">
                      <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm text-slate-400 dark:bg-slate-800 dark:text-slate-500">
                        thinking…
                      </div>
                    </div>
                  )}
                  {chatError && <p className="text-center text-xs text-rose-500">{chatError}</p>}
                </div>
              )}
            </>
          )}
        </div>

        {canChat && (
          <div className="border-t border-slate-100 p-3 dark:border-slate-800">
            <div className="flex items-end gap-2">
              <textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask a follow-up…"
                className="max-h-32 flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600"
              />
              <button
                onClick={send}
                disabled={pending || !input.trim()}
                className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-600 disabled:opacity-50"
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
