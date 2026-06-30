import { useState } from 'react';
import { api } from './api';
import DailyInsight from './sections/DailyInsight';
import Hero from './sections/Hero';
import RecentActivities from './sections/RecentActivities';
import Recovery from './sections/Recovery';
import PlannedWorkouts from './sections/PlannedWorkouts';
import PlannedVsActual from './sections/PlannedVsActual';
import SettingsModal from './SettingsModal';
import PacerModal from './PacerModal';
import ChatWidget from './ChatWidget';

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
    status === 'running' ? 'Refreshing…' : status === 'ok' ? '✓ Updated' : '⟳ Refresh';

  return (
    <div className="relative">
      <button
        onClick={refresh}
        disabled={status === 'running'}
        className={`${className} disabled:opacity-60`}
        aria-label="Refresh Garmin data"
        title="Refresh Garmin data"
      >
        <span className={status === 'running' ? 'mr-1 inline-block animate-spin' : 'hidden'}>⟳</span>
        {label}
      </button>
      {status === 'error' && (
        <p className="absolute right-0 mt-1 w-56 text-right text-xs text-rose-500">{message}</p>
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
    'rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-100">
        <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-slate-50/80 backdrop-blur dark:border-slate-800/70 dark:bg-slate-950/80">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <div>
              <h1 className="text-lg font-bold tracking-tight">Garmin Hub</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">Running dashboard</p>
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton className={topBtn} onRefreshed={() => setRefreshKey((k) => k + 1)} />
              <button onClick={() => setPacerOpen(true)} className={topBtn} aria-label="New pacer" title="Build a pacing workout">
                ⏱ New pacer
              </button>
              <button onClick={() => setSettingsOpen(true)} className={topBtn} aria-label="Settings">
                ⚙ Settings
              </button>
              <button onClick={() => setDark((d) => !d)} className={topBtn} aria-label="Toggle theme">
                {dark ? '☀︎ Light' : '☾ Dark'}
              </button>
            </div>
          </div>
        </header>

        <main key={refreshKey} className="mx-auto max-w-5xl space-y-6 px-6 py-8">
          <DailyInsight />
          <Hero />
          <RecentActivities />
          <Recovery />
          <PlannedWorkouts />
          <PlannedVsActual />
        </main>

        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
        {pacerOpen && <PacerModal onClose={() => setPacerOpen(false)} />}
        <ChatWidget />
      </div>
    </div>
  );
}
