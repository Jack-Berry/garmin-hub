import { useState } from 'react';
import WeekSummary from './sections/WeekSummary';
import PaceTrend from './sections/PaceTrend';
import RecentActivities from './sections/RecentActivities';
import Recovery from './sections/Recovery';
import PlannedWorkouts from './sections/PlannedWorkouts';
import PlannedVsActual from './sections/PlannedVsActual';

export default function App() {
  const [dark, setDark] = useState(true);

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-100">
        <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-slate-50/80 backdrop-blur dark:border-slate-800/70 dark:bg-slate-950/80">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <div>
              <h1 className="text-lg font-bold tracking-tight">Garmin Hub</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">Running dashboard</p>
            </div>
            <button
              onClick={() => setDark((d) => !d)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              aria-label="Toggle theme"
            >
              {dark ? '☀︎ Light' : '☾ Dark'}
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
          <WeekSummary />
          <PaceTrend />
          <RecentActivities />
          <Recovery />
          <PlannedWorkouts />
          <PlannedVsActual />
        </main>
      </div>
    </div>
  );
}
