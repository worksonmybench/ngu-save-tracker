import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtCompact, fmtDateTime, fmtInt } from '../charts/format';
import type { PlayerData } from '../save/decode';
import type { SaveRecord } from '../save/derive';
import { applyPurchases, availableExp, EQUAL_EXP_RATIO, planPurchases, type Ratio } from '../stats/exp';
import { resource, type ResourceKey } from '../stats/formulas';
import { currentAugBoost, grossGoldPerSecond, rankPairs } from '../stats/augments';
import { fruitReport, tierSeconds, type FruitRow } from '../stats/fruit';
import { loadDecoded } from '../store/db';

const RATIO_PRESETS: { key: string; label: string; ratio: Ratio }[] = [
  { key: 'round', label: '1 : 37,500 : 1', ratio: { power: 1, cap: 37500, bars: 1 } },
  { key: 'equal', label: '1 : 37,500 : 1.875 (equal EXP on each)', ratio: EQUAL_EXP_RATIO },
];
const DEFAULT_ENERGY_PER_MAGIC = 3;

function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const positive = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function Calculators({ saves }: { saves: SaveRecord[] }) {
  const sorted = useMemo(() => [...saves].sort((a, b) => b.savedAt - a.savedAt), [saves]);
  const [saveId, setSaveId] = useState(sorted[0].id);
  const [player, setPlayer] = useState<PlayerData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    loadDecoded(saveId)
      .then(({ player: p }) => live && setPlayer(p))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [saveId]);

  if (error) return <p class="error" role="alert">Couldn't open this save: {error}</p>;
  if (!player) return <p class="muted">Reading save…</p>;

  return (
    <div class="stack">
      <section class="card">
        <label class="field">
          Save
          <select value={saveId} onChange={(e) => setSaveId(e.currentTarget.value)}>
            {sorted.map((s) => <option key={s.id} value={s.id}>{fmtDateTime(s.savedAt)}</option>)}
          </select>
        </label>
      </section>
      <ExpCalculator key={`exp-${saveId}`} player={player} />
      <AugmentCalculator key={`aug-${saveId}`} player={player} />
      <FruitCalculator player={player} />
    </div>
  );
}

function ExpCalculator({ player }: { player: PlayerData }) {
  const [budgetText, setBudgetText] = useState(String(availableExp(player)));
  const [ratioText, setRatioText] = useState(String(DEFAULT_ENERGY_PER_MAGIC));
  const [presetKey, setPresetKey] = useState(RATIO_PRESETS[0].key);

  const budget = Math.max(0, Number(budgetText) || 0);
  const energyPerMagic = positive(ratioText, DEFAULT_ENERGY_PER_MAGIC);
  const ratio = RATIO_PRESETS.find((r) => r.key === presetKey)!.ratio;
  const plan = planPurchases(player, { budget, energyPerMagic, ratio });
  const after = applyPurchases(player, plan);
  const needsMore = plan.purchases.filter((b) => b.buy > 0);

  return (
    <section class="card">
      <h2>EXP spending and energy/magic balance</h2>
      <p class="note">
        Spends EXP on whichever stats are furthest below your target, because purchases can't be undone. The right ratio
        depends on your stage of the game, so it's your choice. Magic costs 3× energy, so 3 : 1 spends the same EXP on each.
      </p>
      <div class="filter-row">
        <label class="field">
          EXP to spend
          <input type="number" min="0" value={budgetText} onInput={(e) => setBudgetText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Energy per 1 magic
          <input type="number" min="0.01" step="any" value={ratioText} onInput={(e) => setRatioText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Power : cap : bars
          <select value={presetKey} onChange={(e) => setPresetKey(e.currentTarget.value)}>
            {RATIO_PRESETS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
      </div>

      <div class="table-wrap calc-table">
        <table>
          <thead><tr><th scope="col">Stat</th><th scope="col">Base now</th><th scope="col">Buy</th><th scope="col">EXP</th><th scope="col">Total now</th><th scope="col">Total after</th><th scope="col">Change</th></tr></thead>
          <tbody>
            {plan.purchases.map((b) => {
              const before = resource(player, b.key as ResourceKey)?.total ?? null;
              const next = resource(after, b.key as ResourceKey)?.total ?? null;
              return (
                <tr key={b.key} class={b.buy > 0 ? 'changed' : ''}>
                  <td>{b.label}</td>
                  <td>{fmtCompact(b.current)}</td>
                  <td>{b.buy > 0 ? `+${fmtInt(b.buy)}` : '—'}</td>
                  <td>{b.buy > 0 ? fmtInt(b.cost) : '—'}</td>
                  <td>{fmtCompact(before)}</td>
                  <td>{fmtCompact(next)}</td>
                  <td>{before && next && next !== before ? `×${(next / before).toFixed(3)}` : 'Same'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="note">
        {needsMore.length
          ? `Spends ${fmtInt(plan.spent)} EXP, leaving ${fmtInt(plan.unused)}. `
          : budget > 0 ? "This budget is too small to buy a whole unit of what's lowest. " : ''}
        {plan.fullyBalanced
          ? 'That reaches your target ratio everywhere.'
          : `Reaching your target ratio without overbuying takes ${fmtInt(plan.fullCost)} EXP in total.`}
      </p>
    </section>
  );
}

const DEFAULT_RUN_HOURS = 8;
const PAIRS_SHOWN = 4;

function AugmentCalculator({ player }: { player: PlayerData }) {
  const [hoursText, setHoursText] = useState(String(DEFAULT_RUN_HOURS));
  const [energyText, setEnergyText] = useState(String(resource(player, 'energyCap')?.total ?? 0));
  const [incomeText, setIncomeText] = useState(String(Math.round(grossGoldPerSecond(player))));
  const [goldText, setGoldText] = useState('0');
  const [start, setStart] = useState<'fresh' | 'current'>('fresh');

  const nonNegative = (v: string) => Math.max(0, Number(v) || 0);
  const rows = rankPairs(player, {
    hours: nonNegative(hoursText),
    energy: nonNegative(energyText),
    gold: nonNegative(goldText),
    goldPerSecond: nonNegative(incomeText),
    fresh: start === 'fresh',
  });
  const open = rows.filter((r) => r.limit !== 'locked');
  const locked = rows.filter((r) => r.limit === 'locked');
  const best = open[0];

  return (
    <section class="card">
      <h2>Best augment pair</h2>
      <p class="note">
        Finds the augment and upgrade pair giving the biggest bonus over a run, and the energy split to use, for active
        play. Energy and income start from this save, but income is usually much lower right after a rebirth, so try a
        lower figure too.
      </p>
      <div class="filter-row">
        <label class="field">
          Hours on augments
          <input type="number" min="0" step="any" value={hoursText} onInput={(e) => setHoursText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Energy to use
          <input type="number" min="0" step="any" value={energyText} onInput={(e) => setEnergyText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Gold per second
          <input type="number" min="0" step="any" value={incomeText} onInput={(e) => setIncomeText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Gold on hand
          <input type="number" min="0" step="any" value={goldText} onInput={(e) => setGoldText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Starting from
          <select value={start} onChange={(e) => setStart(e.currentTarget.value as 'fresh' | 'current')}>
            <option value="fresh">Level 0 (new rebirth)</option>
            <option value="current">Levels in this save</option>
          </select>
        </label>
      </div>

      {best && best.bonus > 0 && (
        <p class="result">
          Best: <b>{best.name} + {best.upgradeName}</b>, with {(best.upgradeShare * 100).toFixed(best.upgradeShare < 0.1 ? 1 : 0)}% of
          your energy on the upgrade. Limited by {best.limit}.
        </p>
      )}

      <div class="table-wrap calc-table">
        <table>
          <thead><tr><th scope="col">Pair</th><th scope="col">Augment level</th><th scope="col">Upgrade level</th><th scope="col">Energy on upgrade</th><th scope="col">Limited by</th><th scope="col">Bonus</th><th scope="col">Compared with best</th></tr></thead>
          <tbody>
            {open.slice(0, PAIRS_SHOWN).map((r, i) => (
              <tr key={r.id} class={i === 0 ? 'changed' : ''}>
                <td>{r.name} + {r.upgradeName}</td>
                <td>{fmtInt(r.level)}</td>
                <td>{fmtInt(r.upgrade)}</td>
                <td>{(r.upgradeShare * 100).toFixed(r.upgradeShare < 0.1 ? 1 : 0)}%</td>
                <td>{r.limit === 'gold' ? 'Gold' : 'Energy'}</td>
                <td>{fmtCompact(r.bonus)}</td>
                <td>{best && best.bonus > 0 ? `${((r.bonus / best.bonus) * 100).toFixed(0)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">
        Current augments in this save come to {fmtCompact(currentAugBoost(player))} on the same scale, before NGU and
        challenge multipliers. Gold is treated as one pool for the run, so income arriving late is counted as if it were
        available earlier. Offline levelling works differently and may fall short. Digger costs aren't subtracted from
        income, and bonuses for fully clearing No Augs or Laser Sword aren't included.
        {locked.length > 0 && ` Not unlocked yet: ${locked.map((r) => r.name).join(', ')}.`}
      </p>
    </section>
  );
}

const STATE_LABELS: Record<FruitRow['state'], string> = {
  locked: 'Not bought',
  inactive: 'Not active',
  growing: 'Growing',
  ready: 'At max tier',
};

function FruitCalculator({ player }: { player: PlayerData }) {
  const [hoursText, setHoursText] = useState('0');
  const hours = Math.max(0, Number(hoursText) || 0);
  const report = fruitReport(player, hours);
  const owned = report.rows.filter((r) => r.state !== 'locked');
  const locked = report.rows.filter((r) => r.state === 'locked');
  const next = locked[0];
  const ripe = report.rows.filter((r) => r.seedsNow > 0);

  return (
    <section class="card">
      <h2>Fruit timing</h2>
      <p class="note">
        Times count from when the save was made. Seed figures are for harvesting, without poop. Eating gives half those
        seeds plus the fruit's effect, which isn't counted here.
      </p>
      <div class="filter-row">
        <label class="field">
          Hours from this save (for example, until you rebirth)
          <input type="number" min="0" step="any" value={hoursText} onInput={(e) => setHoursText(e.currentTarget.value)} />
        </label>
      </div>

      <section class="tiles calc-tiles" aria-label="Fruit summary">
        <div class="tile"><span class="lbl">Seeds on hand</span><span class="big">{fmtCompact(report.seeds)}</span><span class="chg">Tier cap {report.tierCap}</span></div>
        <div class="tile"><span class="lbl">{report.growthLostAtRebirth ? 'Lost if you rebirth then' : 'Ready to harvest then'}</span><span class="big">{fmtCompact(report.seedsAtStake)} seeds</span><span class="chg">From {ripe.length} ripe fruit{ripe.length === 1 ? '' : 's'}</span></div>
        <div class="tile"><span class="lbl">All growing fruit at max</span><span class="big">{report.secondsToAllMax > 0 ? `in ${duration(report.secondsToAllMax)}` : 'Yes'}</span><span class="chg">One tier per {Math.round(tierSeconds(player) / 60)} minutes</span></div>
      </section>

      {report.growthLostAtRebirth && ripe.length > 0 && (
        <p class="warn" role="status">
          A rebirth resets growth, so collect first: {ripe.map((r) => `${r.name} (tier ${r.tier})`).join(', ')}.
        </p>
      )}

      <div class="table-wrap calc-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Fruit</th><th scope="col">State</th><th scope="col">Tier</th><th scope="col">Next tier in</th><th scope="col">Max in</th>
              <th scope="col">Seeds now</th><th scope="col">Seeds at max</th><th scope="col">Next max tier costs</th><th scope="col">Pays back in</th>
            </tr>
          </thead>
          <tbody>
            {owned.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{STATE_LABELS[r.state]}</td>
                <td>{r.tier} / {r.maxTier}</td>
                <td>{r.secondsToNext === null ? '—' : duration(r.secondsToNext)}</td>
                <td>{r.secondsToMax === null ? '—' : duration(r.secondsToMax)}</td>
                <td>{fmtInt(r.seedsNow)}</td>
                <td>{fmtInt(r.seedsAtMax)}</td>
                <td>{r.nextTierCost === null ? 'At cap' : `${fmtCompact(r.nextTierCost)}${r.affordable ? ' (can afford)' : ''}`}</td>
                <td>{r.paybackHarvests === null ? '—' : `${fmtInt(r.paybackHarvests)} harvest${r.paybackHarvests === 1 ? '' : 's'}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">
        "Pays back in" counts seeds only, at full tier, and ignores what a higher tier adds to the fruit's effect.
        {report.rows.some((r) => r.state === 'inactive') && ' Inactive fruit need activating with energy or magic before they grow.'}
        {next && ` Next fruit to buy: ${next.name}, ${fmtCompact(next.nextTierCost)} seeds, though the game may have other requirements first.`}
      </p>
    </section>
  );
}
