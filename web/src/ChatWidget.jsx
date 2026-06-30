import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon, Markdown } from './ui';

// Floating chat coach — a discreet bottom-right widget that answers training
// questions using the same context engine as the daily insight. Conversation
// lives in React state only (no persistence): it resets on reload or when the
// panel is cleared. The client sends the full message array each turn; the
// server is stateless.
export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // [{role, content}]
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  // Copy-context state: 'idle' | 'copying' | 'copied' | 'error'. `fallbackText`
  // holds the dump when the clipboard API is unavailable, so it can be shown in
  // a selectable area for manual copy.
  const [copyState, setCopyState] = useState('idle');
  const [fallbackText, setFallbackText] = useState(null);
  const scrollRef = useRef(null);

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

  const send = async () => {
    const text = input.trim();
    if (!text || pending) return;
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setError(null);
    setPending(true);
    try {
      const { reply } = await api.chat(next);
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setPending(false);
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
        className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-500 text-2xl text-white shadow-lg transition hover:bg-indigo-600"
      >
        <Icon name="message-circle" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex h-[500px] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Coach
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Asks the data, not the workout plan
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={copyContext}
            disabled={copyState === 'copying'}
            title="Copy your full training context to paste into another chat (Claude, ChatGPT, etc.)"
            aria-label="Copy training context"
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {copyState === 'copied' ? 'Copied ✓'
              : copyState === 'error' ? 'Failed'
              : copyState === 'copying' ? '…'
              : '📋 Context'}
          </button>
          {messages.length > 0 && (
            <button
              onClick={() => { setMessages([]); setError(null); }}
              aria-label="Clear conversation"
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            aria-label="Minimise chat"
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="mt-2 text-center text-xs text-slate-400 dark:text-slate-500">
            Ask about your training — paces, recovery, whether a goal is realistic,
            why a run felt hard.
          </p>
        )}
        {messages.map((m, i) => (
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
        {error && <p className="text-center text-xs text-rose-500">{error}</p>}
      </div>

      {fallbackText && (
        <div className="border-t border-slate-100 p-3 dark:border-slate-800">
          <p className="mb-1 text-[11px] text-slate-500 dark:text-slate-400">
            Clipboard blocked — select all and copy manually:
          </p>
          <textarea
            readOnly
            value={fallbackText}
            onFocus={(e) => e.target.select()}
            className="h-28 w-full resize-none rounded-lg border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
          />
        </div>
      )}

      <div className="border-t border-slate-100 p-3 dark:border-slate-800">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask your coach…"
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
    </div>
  );
}
