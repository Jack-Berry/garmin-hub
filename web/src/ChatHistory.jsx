import { useEffect, useState } from 'react';
import { api } from './api';

const when = (value) => new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(value));

export default function ChatHistory({ currentId, mode, onClose, onNew, onOpen, disabled = false }) {
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    api.chatThreads().then(setThreads).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const remove = async (event, id) => {
    event.stopPropagation();
    if (disabled) return;
    try {
      await api.deleteChatThread(id);
      setThreads((items) => items.filter((item) => item.id !== id));
      if (id === currentId) onNew(mode);
    } catch (e) {
      setError(e.message || 'Delete failed');
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-surface-1">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h3 className="font-display text-sm font-bold uppercase tracking-[0.1em] text-ink">History</h3>
          <p className="mt-0.5 text-nano uppercase tracking-[0.16em] text-ink-muted">Saved on every device</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onNew(mode)}
            disabled={disabled}
            className="rounded-lg bg-acc px-3 py-1.5 text-xs font-semibold text-acc-ink disabled:opacity-50"
          >
            New chat
          </button>
          <button onClick={onClose} aria-label="Close history" className="rounded-lg border border-line px-2.5 py-1 text-sm text-ink-secondary">✕</button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {threads == null && !error && <p className="p-3 text-center text-xs text-ink-muted">Loading history…</p>}
        {error && <p className="p-3 text-center text-xs text-sem-red">{error}</p>}
        {threads?.length === 0 && <p className="p-3 text-center text-xs text-ink-muted">No saved chats yet.</p>}
        <div className="space-y-2">
          {threads?.map((thread) => (
            <div key={thread.id} className={`flex min-w-0 items-center gap-2 rounded-xl border p-2 ${thread.id === currentId ? 'border-acc' : 'border-line'}`}>
              <button
                onClick={() => onOpen(thread.id)}
                disabled={disabled}
                className="min-w-0 flex-1 rounded-lg p-1 text-left transition hover:bg-surface-2 disabled:opacity-50"
              >
                <span className="block truncate text-sm font-medium text-ink">{thread.title}</span>
                <span className="mt-1 block text-[11px] text-ink-muted">
                  {thread.mode === 'planning' ? 'Planning' : 'Chat'} · {thread.message_count} messages · {when(thread.updated_at)}
                </span>
              </button>
              <button
                onClick={(event) => remove(event, thread.id)}
                disabled={disabled}
                aria-label={`Delete ${thread.title}`}
                className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-ink-muted hover:text-sem-red disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
