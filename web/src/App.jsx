import { useState } from 'react';
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

// Topbar button: runs the Python ingest, then bumps the dashboard refresh key
// so every section refetches. Disabled while running; shows a brief outcome.
function RefreshButton({ className, onRefreshed }) {
  // 'idle' | 'running' | 'ok' | 'error'
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');

  const refresh = async () => {
    if (status === 'running') return;
    setStatus('running');
    setMessage('');
    try {
      await api.refreshIngest();
      setStatus('ok');
      onRefreshed();
      setTimeout(() => setStatus('idle'), 2500);
    } catch (err) {
      setStatus('error');
      setMessage(
        /409/.test(err.message)
          ? 'Already refreshing…'
          : 'Refresh failed — you may need to re-authenticate Garmin in a terminal.'
      );
      setTimeout(() => setStatus('idle'), 6000);
    }
  };

  const label =
    status === 'running' ? 'Refreshing…' : status === 'ok' ? 'Updated' : 'Refresh';

  return (
    <div className="relative">
      <button
        onClick={refresh}
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
        <p className="absolute right-0 mt-1 w-56 text-right text-xs text-sem-red">{message}</p>
      )}
    </div>
  );
}

export default function App() {
  const [dark, setDark] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pacerOpen, setPacerOpen] = useState(false);
  // Bumping this remounts <main>, so all sections refetch from the API.
  const [refreshKey, setRefreshKey] = useState(0);

  const topBtn =
    'inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-body text-micro font-semibold uppercase tracking-[0.1em] text-ink-secondary transition hover:bg-surface-2 hover:text-ink';

  return (
    <AccentProvider dark={dark}>
    <div className={dark ? 'dark' : ''}>
      <div className="min-h-screen bg-surface-0 text-ink transition-colors">
        <header className="sticky top-0 z-10 border-b border-line bg-surface-0/80 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <div>
              <h1 className="font-display text-[1.5rem] font-extrabold uppercase leading-none tracking-[0.02em] text-ink">Garmin Hub</h1>
              <p className="mt-1 font-body text-nano uppercase tracking-[0.22em] text-ink-muted">Running dashboard</p>
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton className={topBtn} onRefreshed={() => setRefreshKey((k) => k + 1)} />
              <button onClick={() => setPacerOpen(true)} className={topBtn} aria-label="New pacer" title="Build a pacing workout">
                <Icon name="stopwatch" /> New pacer
              </button>
              <button onClick={() => setSettingsOpen(true)} className={topBtn} aria-label="Settings">
                <Icon name="settings" /> Settings
              </button>
              <button onClick={() => setDark((d) => !d)} className={`${topBtn} text-acc hover:text-acc`} aria-label="Toggle theme">
                <Icon name={dark ? 'sun' : 'moon'} /> {dark ? 'Light' : 'Dark'}
              </button>
            </div>
          </div>
        </header>

        <main key={refreshKey} className="mx-auto max-w-5xl space-y-5 px-6 py-6">
          <Hero />
          {/* Saved-plan activation (Stage 9c): push to Garmin + the guided
              cancel-Runna step. Renders only while there's choreography left. */}
          <PlanActivation />
          {/* Lower dashboard — a full-width Recovery band on top, then Recent
              activities (wide, table) beside Upcoming planned (narrow, list).
              The two columns top-align and collapse to a single column on
              narrow widths. */}
          <Recovery />
          {/* [&>*]:min-w-0 stops the fr tracks blowing out wider than the shared
              max-w-5xl width — without it the table/badges force the columns
              (and the section's right edge) past the dashboard's right margin. */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.5fr_1fr] lg:items-start [&>*]:min-w-0">
            <RecentActivities />
            <PlannedWorkouts />
          </div>
        </main>

        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
        {pacerOpen && <PacerModal onClose={() => setPacerOpen(false)} />}
        <ChatWidget />
      </div>
    </div>
    </AccentProvider>
  );
}
