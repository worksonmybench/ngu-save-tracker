import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtDateTime } from '../charts/format';
import { itemName } from '../data/itemNames';
import { diffSaves, type Section } from '../save/diff';
import type { SaveRecord } from '../save/derive';
import { loadDecoded } from '../store/db';

const MAX_ROWS = 300;
// Worn or stored item ids, and the per-item flags in itemList, read better with the name.
const ITEM_ID_PATH = /^inventory\..*\.id$/;
const ITEM_FLAG_PATH = /^inventory\.itemList\.\w+\[(\d+)\]$/;
const flagItem = (path: string) => path.match(ITEM_FLAG_PATH)?.[1];
const showValue = (path: string, v: unknown) =>
  ITEM_ID_PATH.test(path) && typeof v === 'number' ? (v ? `${itemName(v)} (${v})` : 'Empty') : show(v);
const show = (v: unknown) => (v === undefined ? '(absent)' : typeof v === 'number' ? String(+v.toPrecision(7)) : String(v));

export function Compare({ saves }: { saves: SaveRecord[] }) {
  const sorted = useMemo(() => [...saves].sort((a, b) => b.savedAt - a.savedAt), [saves]);
  const [afterId, setAfterId] = useState(sorted[0].id);
  const [beforeId, setBeforeId] = useState((sorted[1] ?? sorted[0]).id);
  const [query, setQuery] = useState('');
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    Promise.all([loadDecoded(beforeId), loadDecoded(afterId)])
      .then(([a, b]) => live && setSections(diffSaves(a.player, b.player)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [beforeId, afterId]);

  const q = query.trim().toLowerCase();
  const shown = (sections ?? [])
    .map((s) => ({ ...s, changes: q ? s.changes.filter((c) => c.path.toLowerCase().includes(q)) : s.changes }))
    .filter((s) => s.changes.length);
  const picker = (label: string, value: string, set: (v: string) => void) => (
    <label class="field">
      {label}
      <select value={value} onChange={(e) => set(e.currentTarget.value)}>
        {sorted.map((s) => <option key={s.id} value={s.id}>{fmtDateTime(s.savedAt)}</option>)}
      </select>
    </label>
  );

  return (
    <div class="stack">
      <section class="card">
        <h2>What changed between two saves</h2>
        <p class="note">Every stored field that differs. Fields use the game's internal names. Item names are added where a field refers to an item.</p>
        <div class="filter-row">
          {picker('Before', beforeId, setBeforeId)}
          {picker('After', afterId, setAfterId)}
          <label class="field">
            Filter fields
            <input type="search" value={query} placeholder="e.g. inventory" onInput={(e) => setQuery(e.currentTarget.value)} />
          </label>
        </div>
      </section>
      {error && <p class="error" role="alert">Couldn't compare these saves: {error}</p>}
      {sections && !shown.length && !error && <p class="muted">No differences{q ? ' match that filter' : ''}.</p>}
      {shown.map((s) => (
        <details key={s.name} class="card" open={shown.length === 1}>
          <summary><b>{s.name}</b> <span class="muted">{s.changes.length} changed</span></summary>
          <div class="table-wrap">
            <table>
              <thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
              <tbody>
                {s.changes.slice(0, MAX_ROWS).map((c) => (
                  <tr key={c.path}><td class="path">{c.path}{flagItem(c.path) && ` (${itemName(Number(flagItem(c.path)))})`}</td><td>{showValue(c.path, c.before)}</td><td>{showValue(c.path, c.after)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.changes.length > MAX_ROWS && <p class="note">Showing the first {MAX_ROWS}. Use the filter to narrow this down.</p>}
        </details>
      ))}
    </div>
  );
}
