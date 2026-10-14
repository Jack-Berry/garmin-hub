import { useEffect, useState } from 'react';
import { api } from './api';
import Hero from './sections/Hero';
import RecentActivities from './sections/RecentActivities';
import Recovery from './sections/Recovery';
import PlannedWorkouts from './sections/PlannedWorkouts';
import SettingsModal from './SettingsModal';
import PacerModal from './PacerModal';
import ChatWidget from './ChatWidget';
import PlanActivation from './PlanActivation';
import { Icon } from './ui';
import { AccentProvider } from './accent';

// How stale the data may be before opening the dashboard pulls it itself.
// 30 minutes: long enough that a reload, a second tab or a quick tab-switch
// costs nothing, short enough that a run logged before you sit down is there.
const AUTO_REFRESH_AFTER_MIN = 30;

// A run older than this reads as a problem rather than a gap — the daily
// launchd ingest alone should never let it get here.
const STALE_WARN_MIN = 60 * 24;

const postNative = (message) =>
  window.webkit?.messageHandlers?.garminHub?.postMessage(message);

// Minutes -> "just now" / "12m ago" / "3h ago" / "2d ago".
const ago = (min) => {
  if (min == null) return null;
  if (min < 2) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 60 * 36) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
};

// Topbar refresh control: runs the Python ingest, then bumps the dashboard
// refresh key so every section refetches. It also refreshes ON ITS OWN — once
// when the dashboard opens and again whenever you come back to the tab —
// gated server-side so only genuinely stale data costs a Garmin pull. The
// "Updated N ago" label is the honest part: stale data now says so instead of
// looking current.
function RefreshButton({ className, onRefreshed }) {
  // 'idle' | 'running' | 'ok' | 'error'
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [age, setAge] = useState(null);      // minutes since the last ingest
  const [lastOk, setLastOk] = useState(true); // did that ingest come back clean

  // `auto` marks the unattended passes (page open, tab refocus): they carry the
  // staleness window, so the server skips the pull when data is already fresh,
  // and a "someone is already ingesting" 409 is an expected outcome rather than
  // something to shout about. A real failure still surfaces either way — silent
  // staleness is the whole bug being fixed here.
  const refresh = async (auto = false) => {
    setStatus((s) => (s === 'running' ? s : 'running'));
    setMessage('');
    try {
      const r = await api.refreshIngest(auto ? AUTO_REFRESH_AFTER_MIN : 0);
      setAge(r.age_minutes ?? 0);
      setLastOk(r.last_ok !== false);
      if (r.skipped) {
        setStatus('idle');
        return;
      }
      onRefreshed();
      setStatus('ok');
      setTimeout(() => setStatus('idle'), 2500);
    } catch (err) {
      if (auto && /409/.test(err.message)) {
        setStatus('idle');
        return;
      }
      setStatus('error');
      setMessage(
        /409/.test(err.message)
          ? 'Already refreshing…'
          : 'Refresh failed — you may need to re-authenticate Garmin in a terminal.'
      );
      setTimeout(() => setStatus('idle'), 6000);
    }
  };

  // On open, and again on every return to the tab. Both are gated server-side,
  // so a dashboard left open all day does not become a Garmin poller.
  useEffect(() => {
    refresh(true);
    const onVisible = () => { if (!document.hidden) refresh(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Keep the label honest while the page sits open.
  useEffect(() => {
    const t = setInterval(() => setAge((a) => (a == null ? a : a + 1)), 60000);
    return () => clearInterval(t);
  }, []);

  const label =
    status === 'running' ? 'Refreshing…' : status === 'ok' ? 'Updated' : 'Refresh';
  const stale = age != null && age >= STALE_WARN_MIN;

  return (
    <div className="relative flex items-center gap-2">
      {age != null && status !== 'running' && (
        <span
          className={`hidden font-body text-nano uppercase tracking-[0.18em] sm:inline ${
            stale || !lastOk ? 'text-sem-amber' : 'text-ink-muted'
          }`}
          title={lastOk ? 'Last Garmin ingest' : 'The last ingest reported errors'}
        >
          {lastOk ? '' : 'Ingest issue · '}Updated {ago(age)}
        </span>
      )}
      <button
        onClick={() => refresh(false)}
        disabled={status === 'running'}
        className={`${className} disabled:opacity-60`}
        aria-label="Refresh Garmin data"
        title="Refresh Garmin data"
      >
        <Icon
          name={status === 'ok' ? 'check' : 'refresh'}
          className={status === 'running' ? 'animate-spin' : ''}
        />
        {label}
      </button>
      {status === 'error' && (
        <p className="absolute right-0 top-full mt-1 w-56 text-right text-xs text-sem-red">{message}</p>
      )}
    </div>
  );
}

export default function App() {
  // The native shell sets this explicit flag at document start. Width alone
  // never enables app chrome, so narrow Safari keeps the responsive dashboard.
  const appMode = window.__GARMIN_HUB_APP__ === true;
  const [dark, setDark] = useState(true);
  const [tab, setTab] = useState('today');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pacerOpen, setPacerOpen] = useState(false);
  // Bumping this remounts <main>, so all sections refetch from the API.
  const [refreshKey, setRefreshKey] = useState(0);

  const topBtn =
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 font-body text-micro font-semibold uppercase tracking-[0.1em] text-ink-secondary transition hover:bg-surface-2 hover:text-ink md:h-auto md:px-3 md:py-1.5';

  useEffect(() => {
    if (!appMode) return;
    const root = document.documentElement;
    const viewportMeta = document.querySelector('meta[name="viewport"]');
    const originalViewport = viewportMeta?.content;
    viewportMeta?.setAttribute(
      'content',
      'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
    );
    root.classList.add('app-mode');
    const viewport = window.visualViewport;
    let layoutHeight = window.innerHeight;
    const size = () => {
      const height = viewport?.height || window.innerHeight;
      const keyboardOpen = layoutHeight - height > 120;
      if (!keyboardOpen) layoutHeight = Math.max(layoutHeight, height);
      root.style.setProperty('--app-height', `${height}px`);
      root.style.setProperty('--app-top', `${viewport?.offsetTop || 0}px`);
      root.classList.toggle('keyboard-open', keyboardOpen);
    };
    size();
    viewport?.addEventListener('resize', size);
    viewport?.addEventListener('scroll', size);
    window.addEventListener('resize', size);
    return () => {
      root.classList.remove('app-mode', 'keyboard-open');
      viewport?.removeEventListener('resize', size);
      viewport?.removeEventListener('scroll', size);
      window.removeEventListener('resize', size);
      if (originalViewport) viewportMeta?.setAttribute('content', originalViewport);
    };
  }, [appMode]);

  useEffect(() => {
    if (appMode) postNative({ action: 'theme', dark });
  }, [appMode, dark]);

  const tabs = [
    ['today', 'calendar', 'Today'],
    ['trends', 'chart-line', 'Trends'],
    ['activities', 'run', 'Activities'],
    ['coach', 'message-circle', 'Coach'],
  ];

  return (
    <AccentProvider dark={dark}>
    <div className={dark ? 'dark' : ''}>
      <div className={`min-h-screen bg-surface-0 text-ink transition-colors ${appMode ? 'app-shell' : ''}`}>
        <header className="sticky top-0 z-10 border-b border-line bg-surface-0/80 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 md:px-6 md:py-4">
            <div>
              <h1 className="whitespace-nowrap font-display text-lg font-extrabold uppercase leading-none tracking-[0.02em] text-ink md:text-[1.5rem]">Garmin Hub</h1>
              <p className="mt-1 hidden font-body text-nano uppercase tracking-[0.22em] text-ink-muted md:block">Running dashboard</p>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 md:gap-2">
              <RefreshButton className={topBtn} onRefreshed={() => setRefreshKey((k) => k + 1)} />
              <button onClick={() => setPacerOpen(true)} className={topBtn} aria-label="New pacer" title="Build a pacing workout">
                <Icon name="stopwatch" /> <span className="hidden md:inline">New pacer</span>
              </button>
              <button onClick={() => setSettingsOpen(true)} className={topBtn} aria-label="Settings">
                <Icon name="settings" /> <span className="hidden md:inline">Settings</span>
              </button>
              <button onClick={() => setDark((d) => !d)} className={`${topBtn} text-acc hover:text-acc`} aria-label="Toggle theme">
                <Icon name={dark ? 'sun' : 'moon'} /> <span className="hidden md:inline">{dark ? 'Light' : 'Dark'}</span>
              </button>
            </div>
          </div>
        </header>

        <main key={refreshKey} className={`mx-auto max-w-5xl space-y-4 px-3 py-4 md:space-y-5 md:px-6 md:py-6 ${appMode ? 'app-content' : ''}`}>
          {(!appMode || tab === 'today') && <Hero view={appMode ? 'today' : 'all'} />}
          {/* Saved-plan activation (Stage 9c): push to Garmin + the guided
              cancel-Runna step. Renders only while there's choreography left. */}
          {(!appMode || tab === 'today') && <PlanActivation />}
          {/* Lower dashboard — a full-width Recovery band on top, then Recent
              activities (wide, table) beside Upcoming planned (narrow, list).
              The two columns top-align and collapse to a single column on
              narrow widths. */}
          {(!appMode || tab === 'trends') && (
            <>
              {appMode && <Hero view="trends" />}
              <Recovery />
            </>
          )}
          {/* [&>*]:min-w-0 stops the fr tracks blowing out wider than the shared
              max-w-5xl width — without it the table/badges force the columns
              (and the section's right edge) past the dashboard's right margin. */}
          {(!appMode || tab === 'activities') && (
            <div className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-[1.5fr_1fr] lg:items-start [&>*]:min-w-0">
              <RecentActivities />
              <PlannedWorkouts />
            </div>
          )}
        </main>

        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
        {pacerOpen && <PacerModal onClose={() => setPacerOpen(false)} />}
        <ChatWidget appMode={appMode} active={!appMode || tab === 'coach'} />
        {appMode && (
          <nav className="app-tabs fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface-1/95 backdrop-blur" aria-label="App sections">
            {tabs.map(([key, icon, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex min-w-0 flex-col items-center gap-1 py-2 font-body text-nano font-semibold uppercase tracking-[0.08em] ${tab === key ? 'text-acc' : 'text-ink-muted'}`}
                aria-current={tab === key ? 'page' : undefined}
              >
                <Icon name={icon} className="text-xl" />
                {label}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
    </AccentProvider>
  );
}
