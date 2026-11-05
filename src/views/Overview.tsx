import { useMemo, useState } from 'preact/hooks';
import { BarChart } from '../charts/BarChart';
import { fmtCompact, fmtDateTime, fmtDay, fmtDec, fmtInt, fmtPow10 } from '../charts/format';
import { LineChart } from '../charts/LineChart';
import { byDay, withRuns, type Row, type SaveRecord } from '../save/derive';
import { milestones, milestonesByRow } from '../save/progress';
import { FORMULA_BUILD, type ResourceFactors } from '../stats/formulas';

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All', days: null },
];

const pow = (v: number) => `10^${Math.round(v)}`;
const whole = (v: number) => fmtInt(v);

export function Overview({ saves }: { saves: SaveRecord[] }) {
  const [days, setDays] = useState<number | null>(null);
  // Runs and daily rates come from all saves, so a range only changes what is shown.
  const all = useMemo(() => withRuns(saves), [saves]);
  const allDays = useMemo(() => byDay(all), [all]);
  const marks = useMemo(() => milestonesByRow(milestones(all)), [all]);
  // Features unlock over the game, so a chart only appears once any save has data for it.
  const has = (key: keyof Row) => all.some((r) => typeof r[key] === 'number' && (r[key] as number) > 0);
  const latest = all[all.length - 1];
  const since = days === null ? -Infinity : latest.savedAt - days * 86_400_000;
  const rows = all.filter((r) => r.savedAt >= since);
  const dayRows = allDays.filter((d) => d.time >= since);
  const start = rows[0];

  const delta = (v: number | null, base: number | null) =>
    v === null || base === null || rows.length < 2 ? null : v - base;
  const plus = (d: number | null, f: (v: number) => string) =>
    d === null ? 'No earlier save in range' : `${d >= 0 ? '+' : '−'}${f(Math.abs(d))} since ${fmtDay(start.savedAt)}`;

  return (
    <div class="stack">
      <div class="filter-row">
        <p class="muted">
          Latest save {fmtDateTime(latest.savedAt)} · {all.length} saves · build {latest.build ?? '?'}
          {latest.build !== FORMULA_BUILD && ` · Computed stats use build ${FORMULA_BUILD} formulas and may be off`}
        </p>
        <div class="segmented" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r.label} aria-pressed={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>
          ))}
        </div>
      </div>

      <section class="tiles" aria-label="Latest figures">
        <div class="tile" data-stat="exp"><span class="lbl">Lifetime EXP</span><span class="big">{fmtCompact(latest.lifetimeExp)}</span><span class="chg">{plus(delta(latest.lifetimeExp, start.lifetimeExp), fmtCompact)}</span></div>
        <div class="tile" data-stat="energy"><span class="lbl">Total energy power</span><span class="big">{fmtCompact(latest.totalEnergyPower)}</span><span class="chg">{plus(delta(latest.totalEnergyPower, start.totalEnergyPower), fmtCompact)}</span></div>
        <div class="tile" data-stat="rebirth"><span class="lbl">Rebirth multiplier</span><span class="big">{fmtPow10(latest.rebirthMultiLog10)}</span><span class="chg">{plus(delta(latest.rebirthMultiLog10, start.rebirthMultiLog10), (v) => `${v.toFixed(1)} orders`)}</span></div>
        <div class="tile" data-stat="boss"><span class="lbl">Best boss</span><span class="big">{fmtInt(latest.highestBoss)}</span><span class="chg">{plus(delta(latest.highestBoss, start.highestBoss), fmtInt)}</span></div>
        <div class="tile" data-stat="ngu"><span class="lbl">NGU levels</span><span class="big">{fmtCompact(latest.nguLevels)}</span><span class="chg">{plus(delta(latest.nguLevels, start.nguLevels), fmtCompact)}</span></div>
      </section>

      <section class="grid-charts">
        <Card title="EXP gained per day" note="Between the last saves of consecutive days, averaged when days are skipped.">
          <BarChart title="EXP gained per day" days={dayRows} />
        </Card>
        <Card title="Lifetime EXP" note="Every save.">
          <LineChart title="Lifetime EXP" rows={rows} series={[{ key: 'lifetimeExp', label: 'EXP', slot: 1 }]} fmt={fmtCompact} milestones={marks} />
        </Card>
        <Card title="Rebirth multiplier" note="Power of ten, locked in at each rebirth, so flat within a run. Grey bands are runs; tinted bands are challenges.">
          <LineChart title="Rebirth multiplier" rows={rows} series={[{ key: 'rebirthMultiLog10', label: 'Multiplier', slot: 1 }]} fmt={pow} fromMin bands />
        </Card>
        <Card title="Bosses" note="Best boss ever, and the highest reached in each run among your saves.">
          <LineChart title="Bosses" rows={rows} series={[{ key: 'highestBoss', label: 'Best ever', slot: 1 }, { key: 'runPeakBoss', label: 'Run peak', slot: 2 }]} fmt={whole} bands milestones={marks} />
        </Card>
        <Card title="Total energy power" note="Log scale. Includes the gear worn in each save, so swapping loadouts moves it without real progress. Hover to see where gear changed.">
          <LineChart title="Total energy power" rows={rows} series={[{ key: 'totalEnergyPower', label: 'Total energy power', slot: 1 }]} fmt={fmtCompact} log markGearSwaps />
        </Card>
        <Card title="Where your energy power comes from" note={`Latest save. These multiply together to give ${fmtDec(latest.totalEnergyPower)}.`}>
          <FactorTable factors={latest.energyFactors} />
        </Card>
        <Card title="Base energy power" note="Log scale. The stored base value, before gear and other multipliers, so loadout swaps don't move it.">
          <LineChart title="Base energy power" rows={rows} series={[{ key: 'energyPower', label: 'Energy power', slot: 1 }]} fmt={fmtCompact} log />
        </Card>
        <Card title="Base magic power" note="Log scale. The stored base value, before gear and other multipliers.">
          <LineChart title="Base magic power" rows={rows} series={[{ key: 'magicPower', label: 'Magic power', slot: 1 }]} fmt={fmtCompact} log />
        </Card>
        <Card title="NGU levels" note="Sum of energy and magic NGU levels, at each difficulty you've reached.">
          <LineChart
            title="NGU levels"
            rows={rows}
            series={[
              { key: 'nguLevels', label: 'Normal', slot: 1 },
              ...(has('nguEvilLevels') ? [{ key: 'nguEvilLevels' as const, label: 'Evil', slot: 2 }] : []),
              ...(has('nguSadisticLevels') ? [{ key: 'nguSadisticLevels' as const, label: 'Sadistic', slot: 3 }] : []),
            ]}
            fmt={fmtCompact}
          />
        </Card>
        <Card title="Seeds" note="On hand, and a lower bound on total earned: on hand plus what fruit tiers cost.">
          <LineChart title="Seeds" rows={rows} series={[{ key: 'seedsEarned', label: 'Earned', slot: 1 }, { key: 'seedsOnHand', label: 'On hand', slot: 2 }]} fmt={fmtCompact} />
        </Card>
        <Card title="Arbitrary Points" note="On hand, so drops are purchases.">
          <LineChart title="Arbitrary Points" rows={rows} series={[{ key: 'ap', label: 'AP', slot: 1 }]} fmt={fmtCompact} />
        </Card>
        {has('titanKills') && (
          <Card title="Titan kills" note="Lifetime, across every titan and version.">
            <LineChart title="Titan kills" rows={rows} series={[{ key: 'titanKills', label: 'Kills', slot: 1 }]} fmt={whole} />
          </Card>
        )}
        {PERMANENT.filter((c) => has(c.key)).map((c) => (
          <Card key={c.key} title={c.title} note={c.note}>
            <LineChart title={c.title} rows={rows} series={[{ key: c.key, label: c.title, slot: 1 }]} fmt={fmtCompact} log={c.log} />
          </Card>
        ))}
      </section>

      <section class="card">
        <h2>Day by day</h2>
        <p class="note">Last save of each day: the same values the charts show.</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                {['Day', 'Lifetime EXP', 'EXP / day', 'Multiplier', 'Best boss', 'Run peak', 'Total energy', 'Base energy', 'Base magic', 'NGU lvls', 'Sets', 'Challenges', 'Fruit tiers', 'Seeds', 'AP'].map((h) => <th key={h} scope="col">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...dayRows].reverse().map(({ day, row: r, expPerDay }) => (
                <tr key={day}>
                  <td>{day}</td><td>{fmtInt(r.lifetimeExp)}</td><td>{fmtInt(expPerDay)}</td><td>{fmtPow10(r.rebirthMultiLog10)}</td>
                  <td>{fmtInt(r.highestBoss)}</td><td>{fmtInt(r.runPeakBoss)}</td><td>{fmtDec(r.totalEnergyPower)}</td><td>{fmtDec(r.energyPower)}</td><td>{fmtDec(r.magicPower)}</td>
                  <td>{fmtInt(r.nguLevels)}</td><td>{fmtInt(r.setsComplete)}</td><td>{fmtInt(r.challengesDone)}</td><td>{fmtInt(r.fruitTiers)}</td>
                  <td>{fmtInt(r.seedsOnHand)}</td><td>{fmtInt(r.ap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// Progress that's kept through rebirths, so its rate is meaningful from save to save.
const PERMANENT: { key: keyof Row; title: string; note: string; log?: boolean }[] = [
  { key: 'ppLifetime', title: 'PP earned', note: 'Lifetime ITOPOD PP, including what has been spent.' },
  { key: 'qpLifetime', title: 'QP earned', note: 'Lifetime quest points, including what has been spent.' },
  { key: 'res3Power', title: 'Resource 3 power', note: 'Log scale. The stored base value, before other multipliers.', log: true },
  { key: 'hackLevels', title: 'Hack levels', note: 'Sum of all hack levels.' },
  { key: 'wishLevels', title: 'Wish levels', note: 'Sum of all wish levels.' },
  { key: 'beardPermLevels', title: 'Permanent beard levels', note: 'Sum over all beards. Temporary levels reset each rebirth and are left out.' },
  { key: 'macguffinLevels', title: 'MacGuffin levels', note: 'Sum of the MacGuffins in your MacGuffin slots.' },
];

const FACTOR_LABELS: [keyof ResourceFactors, string][] = [
  ['base', 'Base'],
  ['perks', 'ITOPOD perks'],
  ['gear', 'Gear worn'],
  ['macguffin', 'MacGuffins'],
  ['quirks', 'Beast quirks'],
  ['wishes', 'Wishes'],
  ['potions', 'Potions'],
];

function FactorTable({ factors }: { factors: ResourceFactors | null }) {
  if (!factors) return <div class="chart-empty">No data in this save</div>;
  return (
    <table>
      <tbody>
        {FACTOR_LABELS.map(([key, label]) => (
          <tr key={key}>
            <td>{label}</td>
            <td>{key === 'base' ? fmtDec(factors[key]) : `×${factors[key].toFixed(2)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Card({ title, note, children }: { title: string; note: string; children: preact.ComponentChildren }) {
  return (
    <div class="card">
      <h2>{title}</h2>
      <p class="note">{note}</p>
      {children}
    </div>
  );
}
