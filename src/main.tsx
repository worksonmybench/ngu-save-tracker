import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import './style.css';
import type { SaveRecord } from './save/derive';
import { loadSaves, type ImportResult } from './store/db';
import { Calculators } from './views/Calculators';
import { Compare } from './views/Compare';
import { GearWhatIf } from './views/GearWhatIf';
import { Overview } from './views/Overview';
import { Rates } from './views/Rates';
import { ImportPanel, ImportReport, Saves } from './views/Saves';

const TABS = [
  { id: 'overview', label: 'Progress' },
  { id: 'rates', label: 'Rates & targets' },
  { id: 'gear', label: 'Gear what-if' },
  { id: 'calculators', label: 'Calculators' },
  { id: 'compare', label: 'Compare saves' },
  { id: 'saves', label: 'Manage saves' },
];

const currentTab = () => {
  const id = location.hash.slice(1);
  return TABS.some((t) => t.id === id) ? id : 'overview';
};

function App() {
  const [saves, setSaves] = useState<SaveRecord[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(currentTab);
  const [report, setReport] = useState<ImportResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSaves(await loadSaves());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const onImported = useCallback(async (r: ImportResult) => {
    setReport(r);
    await refresh();
  }, []);
  useEffect(() => {
    refresh();
    const onHash = () => setTab(currentTab());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div class="page">
      <header class="top">
        <div class="brand">
          <span class="brand-note">NGU IDLE · SAVE ANALYSIS</span>
          <h1>NGU Save Tracker</h1>
        </div>
        {!!saves?.length && (
          <nav aria-label="Sections">
            {TABS.map((t) => <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? 'page' : undefined}>{t.label}</a>)}
          </nav>
        )}
      </header>
      <main>
        {error && <p class="error" role="alert">Couldn't open browser storage: {error}. Private windows can block it.</p>}
        {report && <ImportReport result={report} onDismiss={() => setReport(null)} />}
        {saves && !saves.length && (
          <div class="stack">
            <p class="lead">Chart your NGU Idle progress from your save files. One save is one data point, so start with your whole save folder.</p>
            <ImportPanel onImported={onImported} />
          </div>
        )}
        {!!saves?.length && tab === 'overview' && <Overview saves={saves} />}
        {!!saves?.length && tab === 'rates' && <Rates saves={saves} />}
        {!!saves?.length && tab === 'gear' && <GearWhatIf saves={saves} />}
        {!!saves?.length && tab === 'calculators' && <Calculators saves={saves} />}
        {!!saves?.length && tab === 'compare' && <Compare saves={saves} />}
        {!!saves?.length && tab === 'saves' && <Saves saves={saves} onChange={refresh} onImported={onImported} />}
      </main>
      <footer class="muted">Unofficial fan tool, not affiliated with the developers of NGU Idle.</footer>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
