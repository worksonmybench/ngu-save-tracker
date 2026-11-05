import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtDateTime } from '../charts/format';
import { itemName } from '../data/itemNames';
import type { PlayerData } from '../save/decode';
import type { SaveRecord } from '../save/derive';
import { challengeRows, currentDifficulty, DIFFICULTY_NAMES, setRows, setsInProgress, type ItemState } from '../stats/checklists';
import { loadDecoded } from '../store/db';

export function Checklists({ saves }: { saves: SaveRecord[] }) {
  const latest = useMemo(() => [...saves].sort((a, b) => b.savedAt - a.savedAt)[0], [saves]);
  const [player, setPlayer] = useState<PlayerData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    loadDecoded(latest.id)
      .then(({ player: p }) => live && setPlayer(p))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [latest.id]);

  if (error) return <p class="error" role="alert">Couldn't open this save: {error}</p>;
  if (!player) return <p class="muted">Reading save…</p>;

  return (
    <div class="stack">
      <p class="muted">From your latest save, {fmtDateTime(latest.savedAt)}.</p>
      <ChallengeList player={player} />
      <SetList player={player} />
    </div>
  );
}

function ChallengeList({ player }: { player: PlayerData }) {
  const rows = challengeRows(player);
  const shown = rows[0]?.clears.length ?? 1;
  const difficulty = DIFFICULTY_NAMES[currentDifficulty(player)];
  return (
    <section class="card">
      <h2>Challenges</h2>
      <p class="note">
        Clears that still give rewards, at each difficulty you've reached, and what the next clear at {difficulty} needs.
        Some challenges unlock later in the game.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Challenge</th>
              {DIFFICULTY_NAMES.slice(0, shown).map((d) => <th key={d} scope="col">{d}</th>)}
              <th scope="col" class="text">Next clear at {difficulty}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} class={r.next ? '' : 'done'}>
                <td>{r.name}</td>
                {r.clears.map((n, d) => <td key={d}>{n >= r.max ? `${n} / ${r.max} ✓` : `${n} / ${r.max}`}</td>)}
                <td class="text">{r.next ?? 'All rewards collected'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const describe = (i: ItemState) =>
  i.state === 'missing' ? 'not found yet' : i.level === null ? 'found, not held now' : `level ${i.level}`;

function SetList({ player }: { player: PlayerData }) {
  const rows = setRows(player);
  const open = setsInProgress(rows);
  const complete = rows.filter((s) => s.complete);
  return (
    <section class="card">
      <h2>Sets</h2>
      <p class="note">
        A set's bonus needs every item in it maxed. {complete.length} of {rows.length} sets are complete. Sets you haven't
        found anything from yet are left out.
      </p>
      {open.length ? (
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">Set</th><th scope="col">Maxed</th><th scope="col" class="text">Still to max</th></tr></thead>
            <tbody>
              {open.map((s) => {
                const left = s.items.filter((i) => i.state !== 'maxed');
                return (
                  <tr key={s.flag}>
                    <td>{s.name}</td>
                    <td>{s.items.length - left.length} / {s.items.length}</td>
                    <td class="text">{left.map((i) => `${itemName(i.id)} (${describe(i)})`).join(', ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">No sets in progress.</p>
      )}
      {complete.length > 0 && (
        <details class="complete-sets">
          <summary>{complete.length} complete set{complete.length === 1 ? '' : 's'}</summary>
          <p class="note">{complete.map((s) => s.name).join(', ')}</p>
        </details>
      )}
    </section>
  );
}
