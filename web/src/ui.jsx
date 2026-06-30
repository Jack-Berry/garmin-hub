// Shared presentational primitives + chart theme constants.

// Chart accent now comes from the accent context (useAccentHex) so it follows
// the picker — see accents.js. Axis ticks stay a neutral grey for both themes.
export const AXIS = '#6c6c74';
export const GRID = 'rgba(148,163,184,0.18)';
// Monochrome chart ink for the design-system reskin (accent rule: resting data
// is not "live", so its lines stay grey, not accent). Mid-grey reads on both
// the dark card (#1c1c20) and the light card (#fff). Recharts strokes need a
// concrete colour, so this is a fixed value rather than a theme-switched var.
export const INK = '#83838c';

// Tabler webfont icon (the stylesheet is loaded via the CDN <link> in
// index.html). `name` is the icon slug without the `ti-` prefix, e.g.
// <Icon name="run" />. Inherits colour + size from the surrounding text.
export function Icon({ name, className = '' }) {
  return <i className={`ti ti-${name} ${className}`} aria-hidden="true" />;
}

// Shared button treatments (token-driven). Primary carries the accent (it's the
// live/primary action — see the accent rule); ghost is monochrome outline.
export const btnPrimary =
  'rounded-lg bg-acc px-4 py-2 text-sm font-semibold text-acc-ink transition hover:opacity-90 disabled:opacity-50';
export const btnGhost =
  'rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-secondary transition hover:bg-surface-2 disabled:opacity-50';

// Section title + subtitle treatment, reused by every card header. The reference
// uses small condensed-uppercase Archivo eyebrows (not a big sentence-case
// heading) with a wide-tracked Hanken subtitle.
export function SectionTitle({ title, subtitle }) {
  return (
    <>
      <h2 className="font-display text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-ink">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 font-body text-nano uppercase tracking-[0.18em] text-ink-muted">
          {subtitle}
        </p>
      )}
    </>
  );
}

export function Section({ title, subtitle, children }) {
  return (
    <section className="rounded-xl border border-line bg-surface-1">
      <header className="border-b border-line px-5 py-4">
        <SectionTitle title={title} subtitle={subtitle} />
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

// Handles the loading / error / empty states uniformly.
export function StateWrap({ loading, error, empty, children }) {
  if (loading) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (error)
    return <p className="text-sm text-sem-red">Couldn’t load: {error.message}</p>;
  if (empty) return <p className="text-sm text-ink-muted">No data yet.</p>;
  return children;
}

export function Stat({ label, value, sub }) {
  return (
    <div>
      <div className="font-mono text-[1.5rem] font-semibold tabular-nums tracking-tight text-ink">
        {value}
      </div>
      <div className="mt-0.5 font-body text-micro font-semibold uppercase tracking-[0.14em] text-ink-muted">
        {label}
      </div>
      {sub && <div className="font-body text-micro text-ink-muted">{sub}</div>}
    </div>
  );
}

// "Show more / Show less" pager. Owns nothing — parent holds the visible count.
export function PageMore({ visible, total, base, step, set }) {
  if (total <= base) return null;
  const btn =
    'rounded-md border border-line px-2 py-1 font-medium text-ink-secondary transition hover:bg-surface-2';
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-ink-muted">
      <span>
        Showing {Math.min(visible, total)} of {total}
      </span>
      <div className="flex gap-2">
        {visible > base && (
          <button className={btn} onClick={() => set(base)}>
            Show less
          </button>
        )}
        {visible < total && (
          <button className={btn} onClick={() => set(visible + step)}>
            Show more
          </button>
        )}
      </div>
    </div>
  );
}

// Minimal markdown renderer for AI-coach output (chat replies + daily insight).
// The coach emits short prose with **bold**, ## headers, blank-line paragraphs,
// and simple - / * bullet lists — that's all this handles, deliberately. Not a
// full parser.
const renderInline = (text) =>
  // Split on **bold** spans; odd indices are the emphasised segments.
  text.split(/\*\*(.+?)\*\*/g).map((seg, i) =>
    i % 2 ? <strong key={i}>{seg}</strong> : seg
  );

export function Markdown({ children, className = '' }) {
  const blocks = (children || '').trim().split(/\n{2,}/); // blank line = new block
  return (
    <div className={`space-y-2 ${className}`}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        // ## / ### header (single line). Slightly larger, weighted, with space above.
        const heading = block.match(/^#{2,3}\s+(.+)$/);
        if (heading && lines.length === 1) {
          return (
            <h3
              key={bi}
              className="pt-2 font-body text-label font-semibold uppercase tracking-[0.12em] text-ink-muted first:pt-0"
            >
              {renderInline(heading[1])}
            </h3>
          );
        }
        const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((l, li) => (
                <li key={li}>{renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        // Paragraph: keep single newlines as soft line breaks.
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <span key={li}>
                {renderInline(l)}
                {li < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// Small status pill. `race` is a solid lime fill (the reference's signature RACE
// marker); `indigo` is a subtle accent tint for live/ready states (e.g. a pacer).
export function Badge({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-surface-2 text-ink-secondary',
    race: 'bg-acc text-acc-ink',
    amber: 'bg-sem-amber/15 text-sem-amber',
    indigo: 'bg-acc/15 text-acc',
    blue: 'bg-sem-blue/15 text-sem-blue',
    violet: 'bg-sem-violet/15 text-sem-violet',
    emerald: 'bg-sem-blue/15 text-sem-blue',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-body text-nano font-semibold uppercase tracking-[0.1em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
