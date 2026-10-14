import { useEffect, useState } from 'react';
import { api } from './api';
import { useFetch } from './useFetch';
import { StateWrap } from './ui';

function ForgetButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Forget fact"
      className="shrink-0 rounded-lg border border-line px-2.5 py-2 text-sm text-ink-muted transition hover:border-sem-red hover:text-sem-red"
    >
      ✕
    </button>
  );
}

// Facts the coach has silently remembered from chats. This is deliberately
// separate from Settings because it is conversation context, not a preference.
export default function CoachMemory({ onClose, appMode = false }) {
  const { data, loading, error } = useFetch(() => api.coachMemory());
  const [facts, setFacts] = useState(null);
  const [delError, setDelError] = useState(null);
  useEffect(() => { if (data) setFacts(data); }, [data]);

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
    <div
      className="absolute inset-0 z-10 flex flex-col bg-surface-1"
      style={appMode ? { paddingTop: 'env(safe-area-inset-top)' } : undefined}
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="border-l-2 border-l-acc pl-3">
          <h3 className="font-display text-label font-bold uppercase tracking-[0.1em] text-ink">
            What I remember
          </h3>
          <p className="mt-1 font-body text-micro text-ink-muted">Facts saved from your coaching conversations</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close coach memory"
          className="rounded-lg border border-line px-2.5 py-1 text-sm text-ink-secondary transition hover:bg-surface-2"
        >
          Done
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <StateWrap loading={loading} error={error}>
          {(!facts || facts.length === 0) && (
            <p className="font-body text-sm text-ink-muted">Nothing remembered yet.</p>
          )}
          <div className="space-y-2">
            {(facts || []).map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2">
                  <span className="font-mono text-nano text-ink-muted">{(m.created_at || '').slice(0, 10)}</span>
                  <span className="ml-2 font-body text-sm text-ink">{m.content}</span>
                </div>
                <ForgetButton onClick={() => forget(m.id)} />
              </div>
            ))}
          </div>
          {delError && <p className="mt-3 font-body text-micro text-sem-red">Could not delete: {delError.message}</p>}
        </StateWrap>
      </div>
    </div>
  );
}
