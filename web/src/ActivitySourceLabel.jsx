import { isAppleActivity } from './activitySource';

export default function ActivitySourceLabel({ source }) {
  if (!isAppleActivity(source)) return null;
  return (
    <span className="inline-flex shrink-0 rounded border border-line px-1.5 py-0.5 font-body text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
      Apple Watch
    </span>
  );
}
