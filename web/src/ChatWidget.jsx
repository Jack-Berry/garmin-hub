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
        className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-acc text-2xl text-acc-ink shadow-lg transition hover:opacity-90"
      >
        <Icon name="message-circle" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex h-[500px] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-line bg-surface-1 shadow-xl">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="font-display text-[0.9375rem] font-bold uppercase tracking-[0.1em] text-ink">
            Coach
          </h2>
          <p className="mt-0.5 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
            Asks the data, not the workout plan
          </p>
        </div>
        <div className="flex items-center gap-1">
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
            Ask about your training — paces, recovery, whether a goal is realistic,
            why a run felt hard.
          </p>
        )}
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
            placeholder="Ask your coach…"
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
