import { Markdown, StateWrap } from './ui';

export default function DebriefCard({ state, className = '' }) {
  return (
    <section className={className}>
      <h3 className="font-display text-xs font-bold uppercase tracking-[0.14em] text-ink">Post-run debrief</h3>
      <div className="mt-3">
        <StateWrap loading={state.loading} error={state.error} empty={!state.loading && !state.error && !state.data}>
          {state.data && <Markdown className="font-body text-sm leading-relaxed text-ink-secondary">{state.data.content}</Markdown>}
        </StateWrap>
      </div>
    </section>
  );
}
