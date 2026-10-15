import { api } from './api';
import { useFetch } from './useFetch';
import { Icon, Markdown, StateWrap } from './ui';

export default function ProactiveCards() {
  const risks = useFetch(() => api.risks());
  const weekly = useFetch(() => api.weeklyReview());
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
      <StateWrap loading={risks.loading} error={risks.error} empty={false}>
        {!!risks.data?.length && (
          <section className="rounded-xl border border-sem-amber/40 bg-sem-amber/10 p-4 sm:p-5">
            <header className="flex items-center gap-2 text-sem-amber">
              <Icon name="alert-triangle" />
              <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em]">Training warnings</h2>
            </header>
            <ul className="mt-3 space-y-3">
              {risks.data.map((warning) => (
                <li key={warning.code} className="text-sm text-ink-secondary">
                  <span className="font-semibold text-ink">{warning.title}.</span> {warning.detail}
                </li>
              ))}
            </ul>
          </section>
        )}
      </StateWrap>
      <section className="rounded-xl border border-line bg-surface-1 p-4 sm:p-5">
        <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-ink">Weekly review</h2>
        <div className="mt-3">
          <StateWrap loading={weekly.loading} error={weekly.error} empty={!weekly.loading && !weekly.error && !weekly.data}>
            {weekly.data && (
              <details open>
                <summary className="cursor-pointer font-body text-sm font-semibold text-ink-secondary">
                  Week ending {weekly.data.week_end}
                </summary>
                <Markdown className="mt-3 font-body text-sm leading-relaxed text-ink-secondary">{weekly.data.content}</Markdown>
              </details>
            )}
          </StateWrap>
        </div>
      </section>
    </div>
  );
}
