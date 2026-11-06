import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtCompact, fmtDateTime } from '../charts/format';
import { itemName } from '../data/itemNames';
import type { PlayerData } from '../save/decode';
import { withRuns, type Row, type SaveRecord } from '../save/derive';
import { span } from '../save/progress';
import { adventureStats } from '../stats/adventure';
import { titanRows } from '../stats/titans';
import { challengeRows, currentDifficulty, difficultyReached, DIFFICULTY_NAMES, setRows, setsInProgress, type ItemState } from '../stats/checklists';
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
      <TitanList player={player} saves={saves} />
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

const GROWTH_DAYS = 30;
const DAY_SECONDS = 86_400;

// Growth per day as a ratio, from the latest save and one about a month earlier. Advanced Training
// and temporary beard levels reset each rebirth, so this is rough.
function growthPerDay(rows: Row[], key: 'advPower' | 'advToughness' | 'advRegen') {
  const s = span(rows, GROWTH_DAYS, (r) => typeof r[key] === 'number' && r[key] > 0);
  if (!s) return null;
  const rate = Math.log(s.to[key] / s.from[key]) / s.days;
  return rate > 0 ? rate : null;
}

function TitanList({ player, saves }: { player: PlayerData; saves: SaveRecord[] }) {
  const rows = useMemo(() => withRuns(saves), [saves]);
  const stats = adventureStats(player);
  const reached = difficultyReached(player);
  const titans = titanRows(player, stats).filter((t) => t.difficulty <= reached);
  const growth = { power: growthPerDay(rows, 'advPower'), toughness: growthPerDay(rows, 'advToughness'), regen: growthPerDay(rows, 'advRegen') };
  const eta = (short: { power: number; toughness: number; regen: number }) => {
    let days = 0;
    for (const k of ['power', 'toughness', 'regen'] as const) {
      if (short[k] <= 1) continue;
      if (!growth[k]) return null;
      days = Math.max(days, Math.log(short[k]) / growth[k]!);
    }
    return days * DAY_SECONDS;
  };
  const need = (ratio: number, label: string) => (ratio > 1 ? `×${ratio < 10 ? ratio.toFixed(1) : fmtCompact(ratio)} ${label}` : null);
  const firstShort = titans.findIndex((t) => !t.ready && !t.byKills);

  return (
    <section class="card">
      <h2>Titan auto-kill</h2>
      <p class="note">
        With auto-kill on, a titan dies on its own once your adventure stats reach its thresholds. Your stats in this save:
        Power {fmtCompact(stats.power)}, Toughness {fmtCompact(stats.toughness)}, HP regen {fmtCompact(stats.regen)}. They
        include Advanced Training and temporary beard levels, which reset each rebirth.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Titan</th><th scope="col">Power</th><th scope="col">Toughness</th><th scope="col">Regen</th><th scope="col" class="text">Status</th></tr>
          </thead>
          <tbody>
            {titans.map((t, i) => {
              const missing = [need(t.short.power, 'Power'), need(t.short.toughness, 'Toughness'), need(t.short.regen, 'regen')].filter(Boolean);
              const wait = t.ready || t.byKills ? null : eta(t.short);
              const status = t.byKills
                ? 'Auto-kills: more than 4 kills'
                : t.ready
                  ? t.also ?? 'Auto-kills'
                  : `Needs ${missing.join(', ')}${wait === null ? '' : `, in about ${durationText(wait)} at your recent growth`}`;
              return (
                <tr key={`${t.titan}-${t.version}`} class={(t.ready && !t.also) || t.byKills ? 'done' : i === firstShort ? 'changed' : ''}>
                  <td>T{t.titan}{t.version ? `v${t.version}` : ''} {t.name}</td>
                  <td>{fmtCompact(t.need.power)}</td>
                  <td>{fmtCompact(t.need.toughness)}</td>
                  <td>{t.need.regen ? fmtCompact(t.need.regen) : '—'}</td>
                  <td class="text">{status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="note">
        Times extend your Power, Toughness and regen growth over the last {GROWTH_DAYS} days, so they're rough. The highlighted
        row is the next titan to work towards. Titans also need their boss beaten and their spawn timer to come round.
      </p>
    </section>
  );
}

function durationText(seconds: number) {
  const days = seconds / DAY_SECONDS;
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 1) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  return `${Math.max(1, Math.round(seconds / 3600))} hours`;
}
