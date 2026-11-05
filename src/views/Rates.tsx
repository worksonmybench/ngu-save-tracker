import { useMemo, useState } from 'preact/hooks';
import { fmtCompact, fmtDateTime, fmtInt } from '../charts/format';
import { withRuns, type Row, type SaveRecord } from '../save/derive';
import type { NguLevels } from '../save/metrics';
import { defaultTarget, milestones, NGU_HARDCAP, nguRates, perDay, secondsToTarget, span } from '../save/progress';

const WINDOWS = [7, 30];
const MILESTONES_SHOWN = 100;

// Kept through rebirths, so the change between two saves is real progress.
const GAINS: { key: keyof Row; label: string }[] = [
  { key: 'lifetimeExp', label: 'Lifetime EXP' },
  { key: 'nguLevels', label: 'NGU levels (Normal)' },
  { key: 'nguEvilLevels', label: 'NGU levels (Evil)' },
  { key: 'nguSadisticLevels', label: 'NGU levels (Sadistic)' },
  { key: 'ppLifetime', label: 'PP earned' },
  { key: 'qpLifetime', label: 'QP earned' },
  { key: 'titanKills', label: 'Titan kills' },
  { key: 'seedsEarned', label: 'Seeds earned (at least)' },
  { key: 'res3Power', label: 'Resource 3 power' },
  { key: 'hackLevels', label: 'Hack levels' },
  { key: 'wishLevels', label: 'Wish levels' },
  { key: 'beardPermLevels', label: 'Permanent beard levels' },
  { key: 'macguffinLevels', label: 'MacGuffin levels' },
];

const DIFFICULTIES: { key: keyof NguLevels; label: string; level: number }[] = [
  { key: 'normal', label: 'Normal', level: 0 },
  { key: 'evil', label: 'Evil', level: 1 },
  { key: 'sadistic', label: 'Sadistic', level: 2 },
];

const numeric = (key: keyof Row) => (r: Row) => {
  const v = r[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

function duration(seconds: number | null) {
  if (seconds === null) return 'Not levelling';
  if (seconds <= 0) return 'Reached';
  const days = seconds / 86_400;
  if (days >= 365) return `${fmtCompact(days / 365)} years`;
  if (days >= 1) return `${days.toFixed(days < 10 ? 1 : 0)} days`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function Rates({ saves }: { saves: SaveRecord[] }) {
  const rows = useMemo(() => withRuns(saves), [saves]);
  const [days, setDays] = useState(WINDOWS[0]);
  const latest = rows[rows.length - 1];
  const range = span(rows, days);

  const gains = GAINS.map((g) => ({ ...g, now: numeric(g.key)(latest), rate: perDay(rows, numeric(g.key), days) }))
    .filter((g) => (g.now ?? 0) > 0);

  return (
    <div class="stack">
      <div class="filter-row">
        <p class="muted">
          {range
            ? `Measured from ${fmtDateTime(range.from.savedAt)} to ${fmtDateTime(range.to.savedAt)}.`
            : `Needs two saves at least 12 hours apart within the last ${days} days.`}
        </p>
        <div class="segmented" role="group" aria-label="Measure over">
          {WINDOWS.map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>Last {d} days</button>
          ))}
        </div>
      </div>

      <section class="card">
        <h2>Gains per day</h2>
        <p class="note">Change between the first and last save in the period, divided by the days between them.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">Stat</th><th scope="col">Now</th><th scope="col">Per day</th></tr></thead>
            <tbody>
              {gains.map((g) => (
                <tr key={g.key}>
                  <td>{g.label}</td>
                  <td>{fmtCompact(g.now)}</td>
                  <td>{g.rate === null ? '—' : `${g.rate >= 0 ? '+' : '−'}${fmtCompact(Math.abs(g.rate))}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <NguTargets rows={rows} days={days} />
      <MilestoneList rows={rows} />
    </div>
  );
}

function NguTargets({ rows, days }: { rows: Row[]; days: number }) {
  const reached = Math.max(0, ...rows.map((r) => r.difficulty ?? 0));
  const options = DIFFICULTIES.filter((d) => d.level <= reached);
  const [difficulty, setDifficulty] = useState<keyof NguLevels>(options[options.length - 1].key);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const list = nguRates(rows, difficulty, days).filter((r) => r.level > 0 || (r.perDay ?? 0) > 0);

  return (
    <section class="card">
      <h2>NGU time to target</h2>
      <p class="note">
        Assumes each NGU keeps getting the energy or magic it got over the period, and that each level costs one more
        unit than the last. More resources, or moving them between NGUs, changes the estimate. An NGU at full speed
        gains 50 levels a second, and may slow down later as levels get more expensive.
      </p>
      <div class="filter-row">
        <label class="field">
          Difficulty
          <select value={difficulty} onChange={(e) => setDifficulty(e.currentTarget.value as keyof NguLevels)}>
            {options.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </label>
      </div>
      {list.length ? (
        <div class="table-wrap calc-table">
          <table>
            <thead><tr><th scope="col">NGU</th><th scope="col">Level</th><th scope="col">Levels per day</th><th scope="col">Target</th><th scope="col">Time to target</th></tr></thead>
            <tbody>
              {list.map((r) => {
                const id = `${difficulty}:${r.resource}:${r.index}`;
                const text = targets[id] ?? String(defaultTarget(r.level));
                const target = Math.min(NGU_HARDCAP, Math.max(0, Number(text) || 0));
                return (
                  <tr key={id}>
                    <td>{r.name}{r.resource ? ' (magic)' : ' (energy)'}</td>
                    <td>{fmtInt(r.level)}</td>
                    <td>{r.perDay === null ? '—' : r.fullSpeed ? `${fmtCompact(r.perDay)} (full speed)` : fmtCompact(r.perDay)}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max={NGU_HARDCAP}
                        aria-label={`Target level for ${r.name}`}
                        value={text}
                        onInput={(e) => setTargets({ ...targets, [id]: e.currentTarget.value })}
                      />
                    </td>
                    <td>{r.perDay === null ? '—' : duration(secondsToTarget(r, target))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">No NGU levels at this difficulty yet.</p>
      )}
    </section>
  );
}

function MilestoneList({ rows }: { rows: Row[] }) {
  const list = useMemo(() => milestones(rows).reverse(), [rows]);
  return (
    <section class="card">
      <h2>Milestones</h2>
      <p class="note">
        Sets maxed, challenge clears and new difficulties, dated by the first save that shows them. They happened
        between that save and the one before.
      </p>
      {list.length ? (
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">First seen</th><th scope="col" class="text">Milestone</th></tr></thead>
            <tbody>
              {list.slice(0, MILESTONES_SHOWN).map((m, i) => (
                <tr key={`${m.rowId}-${i}`}><td>{fmtDateTime(m.time)}</td><td class="text">{m.label}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">Nothing new between your saves yet. Import saves from different days to see milestones.</p>
      )}
    </section>
  );
}
