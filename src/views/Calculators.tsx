import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtCompact, fmtDateTime, fmtInt } from '../charts/format';
import { itemName } from '../data/itemNames';
import type { PlayerData } from '../save/decode';
import type { SaveRecord } from '../save/derive';
import { applyPurchases, availableExp, EQUAL_EXP_RATIO, planPurchases, type Ratio } from '../stats/exp';
import { resource, type ResourceKey } from '../stats/formulas';
import { currentAugBoost, grossGoldPerSecond, rankPairs } from '../stats/augments';
import { planDiggers } from '../stats/diggers';
import { difficultyReached } from '../stats/checklists';
import { minimumWishSeconds, wishRows, wishSlots } from '../stats/wishes';
import { HACK_HACK, hacksUnlocked, milestones, nextMilestone, planHackday, readHacks, savedResources } from '../stats/hacks';
import { bestPlan, currentScore, ingredientRows, optimalScore, quality, readDish } from '../stats/cooking';
import { fruitReport, tierSeconds, type FruitRow } from '../stats/fruit';
import { beardFullSeconds, beardTimeFactor, compareLengths, gainsAt, macguffinGain, readRebirth } from '../stats/rebirth';
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
      <DiggerPlanner key={`dig-${saveId}`} player={player} />
      <HackdayPlanner key={`hack-${saveId}`} player={player} />
      <WishPlanner key={`wish-${saveId}`} player={player} />
      <FruitCalculator player={player} />
      <RebirthAdvisor player={player} />
      <CookingSolver player={player} />
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
        <div class="tile" data-stat="seeds"><span class="lbl">Seeds on hand</span><span class="big">{fmtCompact(report.seeds)}</span><span class="chg">Tier cap {report.tierCap}</span></div>
        <div class="tile" data-stat="seeds"><span class="lbl">{report.growthLostAtRebirth ? 'Lost if you rebirth then' : 'Ready to harvest then'}</span><span class="big">{fmtCompact(report.seedsAtStake)} seeds</span><span class="chg">From {ripe.length} ripe fruit{ripe.length === 1 ? '' : 's'}</span></div>
        <div class="tile" data-stat="seeds"><span class="lbl">All growing fruit at max</span><span class="big">{report.secondsToAllMax > 0 ? `in ${duration(report.secondsToAllMax)}` : 'Yes'}</span><span class="chg">One tier per {Math.round(tierSeconds(player) / 60)} minutes</span></div>
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

const amount = (n: number, unit: string) => `${fmtInt(n)} ${unit}`;

function CookingSolver({ player }: { player: PlayerData }) {
  const dish = readDish(player);
  if (!dish) {
    return (
      <section class="card">
        <h2>Cooking</h2>
        <p class="muted">Cooking isn't unlocked in this save.</p>
      </section>
    );
  }
  const plan = bestPlan(dish);
  const best = optimalScore(plan);
  const now = quality(currentScore(dish), best);
  const rows = ingredientRows(dish, plan);
  // Listed pair by pair, the way the dish scores them.
  const ordered = plan.flatMap((p, k) => [p.pair.a, p.pair.b].map((i) => ({ pair: k + 1, row: rows[i] }))).filter((r) => r.row);
  const changes = ordered.filter(({ row }) => row.unlocked && row.best !== row.now).length;

  return (
    <section class="card">
      <h2>Cooking</h2>
      <p class="note">
        The save holds each dish's hidden targets, so these amounts give the best meal efficiency for this dish exactly.
        Each meal brings a new dish with new targets, so import a fresh save after eating.
      </p>
      <section class="tiles calc-tiles" aria-label="Cooking summary">
        <div class="tile"><span class="lbl">Dish</span><span class="big">{dish.name}</span><span class="chg">{changes ? `${changes} ingredient${changes === 1 ? '' : 's'} to change` : 'Nothing to change'}</span></div>
        <div class="tile"><span class="lbl">Meal efficiency now</span><span class="big">{(now * 100).toFixed(now < 1 ? 1 : 0)}%</span><span class="chg">With these amounts: 100%</span></div>
      </section>
      <div class="table-wrap calc-table">
        <table>
          <thead><tr><th scope="col">Ingredient</th><th scope="col">Pair</th><th scope="col">Now</th><th scope="col">Set to</th></tr></thead>
          <tbody>
            {ordered.map(({ pair, row }) => (
              <tr key={row.index} class={row.unlocked && row.best !== row.now ? 'changed' : ''}>
                <td>{row.name}</td>
                <td>{pair}</td>
                <td>{row.unlocked ? amount(row.now, row.unit) : 'Locked'}</td>
                <td>{row.unlocked ? (row.best === row.now ? 'Keep' : amount(row.best, row.unit)) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">Locked ingredients don't count towards the score.</p>
    </section>
  );
}

const pctOfBest = (share: number) => (share >= 0.9995 ? 'Best' : `${(share * 100).toFixed(0)}%`);

function RebirthAdvisor({ player }: { player: PlayerData }) {
  const state = readRebirth(player);
  if (!state.beards.length && !state.guffs.length) {
    return (
      <section class="card">
        <h2>Rebirth length</h2>
        <p class="muted">No active beards or equipped MacGuffins in this save, so rebirth length doesn't change what they bank.</p>
      </section>
    );
  }
  const now = gainsAt(state, state.seconds);
  const rows = compareLengths(state);
  const fruit = fruitReport(player, 0);
  const beardFactor = beardTimeFactor(state.seconds, state.beardPerk);

  return (
    <section class="card">
      <h2>Rebirth length</h2>
      <p class="note">
        What rebirthing banks for good: permanent beard levels and MacGuffin bonuses. Both depend on how long the rebirth
        ran. Beards bank most per day from {+(beardFullSeconds(state.beardPerk) / 3600).toFixed(1)}-hour rebirths, and MacGuffins
        from 30-minute ones{state.sadistic ? ', or longer on Sadistic with your Troll clears' : ''}.
      </p>
      <section class="tiles calc-tiles" aria-label="Rebirthing now">
        <div class="tile"><span class="lbl">This rebirth so far</span><span class="big">{duration(state.seconds)}</span><span class="chg">At the time of this save</span></div>
        {state.beards.length > 0 && (
          <div class="tile"><span class="lbl">Beard levels banked now</span><span class="big">+{fmtInt(now.beardLevels)}</span><span class="chg">Time factor {beardFactor.toFixed(2)} of 8</span></div>
        )}
        {state.guffs.length > 0 && (
          <div class="tile"><span class="lbl">MacGuffin time factor now</span><span class="big">×{now.guffFactor.toFixed(2)}</span><span class="chg">{state.boost > 1 ? `Includes the MacGuffin Booster (×${state.boost.toFixed(1)})` : 'Best per hour at 30 minutes'}</span></div>
        )}
      </section>
      {fruit.growthLostAtRebirth && fruit.seedsAtStake > 0 && (
        <p class="warn" role="status">Rebirthing now also loses {fmtCompact(fruit.seedsAtStake)} seeds from ripe fruit, unless you harvest first.</p>
      )}

      {state.beards.length > 0 && (
        <div class="table-wrap calc-table">
          <table>
            <thead><tr><th scope="col">Active beard</th><th scope="col">Temporary levels</th><th scope="col">Permanent now</th><th scope="col">Banked if you rebirth now</th></tr></thead>
            <tbody>
              {state.beards.map((b) => {
                const gain = gainsAt({ ...state, beards: [b] }, state.seconds).beardLevels;
                return (
                  <tr key={b.index}><td>{b.effect}</td><td>{fmtInt(b.temp)}</td><td>{fmtInt(b.perm)}</td><td>+{fmtInt(gain)}</td></tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {state.guffs.length > 0 && (
        <div class="table-wrap calc-table">
          <table>
            <thead><tr><th scope="col">Equipped MacGuffin</th><th scope="col">Level</th><th scope="col">Bonus now</th><th scope="col">After rebirthing now</th></tr></thead>
            <tbody>
              {state.guffs.map((g) => (
                <tr key={g.itemId}>
                  <td>{itemName(g.itemId)}</td><td>{fmtInt(g.level)}</td><td>×{g.bonus.toFixed(4)}</td>
                  <td>×{(g.bonus + macguffinGain(g.itemId, g.level, now.guffFactor)).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div class="table-wrap calc-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Rebirth length</th>
              {state.beards.length > 0 && <><th scope="col">Beard levels per rebirth</th><th scope="col">Beard levels per day</th></>}
              {state.guffs.length > 0 && <th scope="col">MacGuffin bonus per day</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seconds} class={r.beardShare >= 0.9995 || r.guffShare >= 0.9995 ? 'changed' : ''}>
                <td>{duration(r.seconds)}</td>
                {state.beards.length > 0 && <><td>{fmtInt(r.beardLevels)}</td><td>{fmtInt(r.beardsPerDay)} ({pctOfBest(r.beardShare)})</td></>}
                {state.guffs.length > 0 && <td>{pctOfBest(r.guffShare)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">
        Per day assumes back-to-back rebirths of that length. Beard rows assume temporary levels keep growing at this
        rebirth's average rate, so they're rough; the "rebirth now" figures above are exact. Other things that depend on
        rebirth length, such as fruit tiers and boss progress, aren't counted here.
      </p>
    </section>
  );
}

const ONE_YEAR = 365 * 86_400;
const waitFor = (seconds: number | null) =>
  seconds === null ? 'Not with this income' : seconds < 60 ? 'Under a minute' : seconds > ONE_YEAR ? 'Over a year' : duration(seconds);
const shortTime = (seconds: number) => (seconds < 60 ? `${Math.max(1, Math.round(seconds))}s` : duration(seconds));
const times = (v: number) => `×${v < 100 ? v.toFixed(2) : fmtCompact(v)}`;

function DiggerPlanner({ player }: { player: PlayerData }) {
  const [incomeText, setIncomeText] = useState(String(Math.round(grossGoldPerSecond(player))));
  const income = Math.max(0, Number(incomeText) || 0);
  const plan = planDiggers(player, income);
  if (!plan.rows.some((r) => r.maxLevel > 0)) {
    return (
      <section class="card">
        <h2>Gold diggers</h2>
        <p class="muted">No gold diggers are unlocked in this save.</p>
      </section>
    );
  }
  const share = income > 0 ? plan.drain / income : 0;

  return (
    <section class="card">
      <h2>Gold diggers</h2>
      <p class="note">
        Which digger levels your gold income can keep running, and how long the next upgrades take to afford. Income
        starts from this save's Time Machine; it's usually much lower right after a rebirth, so try a lower figure too.
      </p>
      <div class="filter-row">
        <label class="field">
          Gold per second, before diggers
          <input type="number" min="0" step="any" value={incomeText} onInput={(e) => setIncomeText(e.currentTarget.value)} />
        </label>
      </div>
      <section class="tiles calc-tiles" aria-label="Digger summary">
        <div class="tile"><span class="lbl">Drained by active diggers</span><span class="big">{fmtCompact(plan.drain)}/s</span><span class="chg">{income > 0 ? `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% of income` : 'No income entered'}</span></div>
        <div class="tile"><span class="lbl">Active diggers</span><span class="big">{plan.active} of {plan.slots}</span><span class="chg">Slots unlocked</span></div>
        <div class="tile"><span class="lbl">Bonus from upgrade levels</span><span class="big">×{plan.levels.toFixed(3)}</span><span class="chg">Every upgrade raises all diggers</span></div>
      </section>
      {plan.drain > income && <p class="warn" role="status">Your active diggers drain more than this income, so the game will switch some off.</p>}
      <div class="table-wrap calc-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Digger</th><th scope="col">Upgraded to</th><th scope="col">Running at</th><th scope="col">Bonus now</th>
              <th scope="col">Drain now</th><th scope="col">Highest level you can run</th><th scope="col">Next upgrade</th><th scope="col">Affordable in</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => (
              <tr key={r.index} class={r.maxLevel === 0 ? 'done' : r.active && r.affordable > r.level ? 'changed' : ''}>
                <td>{r.name}</td>
                <td>{r.maxLevel ? fmtInt(r.maxLevel) : 'Locked'}</td>
                <td>{r.active ? fmtInt(r.level) : 'Off'}</td>
                <td>{r.active ? times(r.bonus) : '—'}</td>
                <td>{r.drain ? `${fmtCompact(r.drain)}/s` : '—'}</td>
                <td>{r.maxLevel ? `${fmtInt(r.affordable)} (${times(r.bonusAffordable)})` : '—'}</td>
                <td>{fmtCompact(r.nextCost)}{r.maxLevel ? '' : ' to unlock'}</td>
                <td>{waitFor(r.secondsToNext)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">
        "Highest level you can run" leaves the other active diggers as they are. Highlighted rows could run higher than
        they do now. Upgrade times use the income left after all active diggers, and ignore spending gold on anything
        else.
      </p>
    </section>
  );
}

function HackdayPlanner({ player }: { player: PlayerData }) {
  const saved = savedResources(player);
  const [powerText, setPowerText] = useState(String(saved.power));
  const [capText, setCapText] = useState(String(saved.r3));
  const [speedText, setSpeedText] = useState('100');
  const [targets, setTargets] = useState<Record<number, number>>({});
  if (!hacksUnlocked(player)) {
    return (
      <section class="card">
        <h2>Hackday planner</h2>
        <p class="muted">Hacks aren't unlocked in this save.</p>
      </section>
    );
  }
  const hacks = readHacks(player);
  const res = { r3: Math.max(0, Number(capText) || 0), power: Math.max(0, Number(powerText) || 0), speed: Math.max(0, Number(speedText) || 0) / 100 };
  const plan = planHackday(hacks, targets, res);
  const step = (index: number, up: boolean) => {
    const h = hacks[index];
    const now = plan.rows[index].target;
    const next = up ? nextMilestone(h, now) : Math.max(h.level, (Math.ceil(now / h.threshold) - 1) * h.threshold);
    setTargets({ ...targets, [index]: next });
  };

  return (
    <section class="card">
      <h2>Hackday planner</h2>
      <p class="note">
        How long each hack takes to reach its target with all of resource 3 on it, one hack at a time. Copy the totals
        below from the game's stat breakdowns: they start at this save's base values, which leave out multipliers. Hack
        Hack goes first, since it speeds up the rest.
      </p>
      <div class="filter-row">
        <label class="field">
          Total resource 3 power
          <input type="number" min="0" step="any" value={powerText} onInput={(e) => setPowerText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Total resource 3 cap
          <input type="number" min="0" step="any" value={capText} onInput={(e) => setCapText(e.currentTarget.value)} />
        </label>
        <label class="field">
          Total hack speed (%)
          <input type="number" min="0" step="any" value={speedText} onInput={(e) => setSpeedText(e.currentTarget.value)} />
        </label>
      </div>
      <section class="tiles calc-tiles" aria-label="Hackday summary">
        <div class="tile"><span class="lbl">Total time</span><span class="big">{plan.total === null ? '—' : plan.total === 0 ? 'No targets yet' : shortTime(plan.total)}</span><span class="chg">A hackday usually aims for about a day</span></div>
        <div class="tile"><span class="lbl">Hack Hack speed-up</span><span class="big">×{plan.speedup.toFixed(3)}</span><span class="chg">Applied to every other hack</span></div>
      </section>
      <div class="actions">
        <button class="button" onClick={() => setTargets({})} disabled={!Object.keys(targets).length}>Reset targets</button>
      </div>
      <div class="table-wrap calc-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Hack</th><th scope="col">Level</th><th scope="col">Milestone every</th><th scope="col">Bonus now</th>
              <th scope="col">Target</th><th scope="col">Bonus then</th><th scope="col">Time with all R3</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => {
              const gained = milestones(r, r.target) - milestones(r, r.level);
              return (
                <tr key={r.index} class={r.target > r.level ? 'changed' : ''}>
                  <td>{r.name}{r.index === HACK_HACK ? ' (first)' : ''}</td>
                  <td>{fmtInt(r.level)}</td>
                  <td>{r.threshold}</td>
                  <td>{times(r.bonusNow)}</td>
                  <td>
                    <span class="stepper">
                      <button class="button" aria-label={`Lower the ${r.name} target by a milestone`} onClick={() => step(r.index, false)} disabled={r.target <= r.level}>−</button>
                      <input
                        type="number"
                        min={r.level}
                        max={r.hardCap}
                        aria-label={`Target level for ${r.name}`}
                        value={r.target}
                        onInput={(e) => setTargets({ ...targets, [r.index]: Math.floor(Number(e.currentTarget.value) || 0) })}
                      />
                      <button class="button" aria-label={`Raise the ${r.name} target by a milestone`} onClick={() => step(r.index, true)} disabled={r.target >= r.hardCap}>+</button>
                    </span>
                    {gained > 0 && <div class="note">+{gained} milestone{gained === 1 ? '' : 's'}</div>}
                  </td>
                  <td>{times(r.bonusAfter)}</td>
                  <td>{r.target <= r.level ? '—' : r.seconds === null ? 'Never' : shortTime(r.seconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="note">
        Times assume nothing else changes during the hackday, and that potions stay as they are. The game caps each hack
        at one level per tick.
      </p>
    </section>
  );
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const WISH_SORTS = [
  { key: 'next', label: 'Fastest next level' },
  { key: 'max', label: 'Fastest to max' },
  { key: 'id', label: 'Game order' },
] as const;

function WishPlanner({ player }: { player: PlayerData }) {
  const slots = wishSlots(player);
  const start = (key: ResourceKey, fallback: number) => String(Math.round(resource(player, key)?.total ?? fallback));
  const [fields, setFields] = useState({
    energyPower: start('energyPower', 0),
    magicPower: start('magicPower', 0),
    res3Power: String(num(player.res3?.res3Power)),
    energy: String(Math.round((resource(player, 'energyCap')?.total ?? 0) / slots)),
    magic: String(Math.round((resource(player, 'magicCap')?.total ?? 0) / slots)),
    res3: String(Math.round(num(player.res3?.capRes3) / slots)),
    speed: '100',
  });
  const [sort, setSort] = useState<(typeof WISH_SORTS)[number]['key']>('next');
  const [query, setQuery] = useState('');
  const difficulty = difficultyReached(player);
  if (difficulty < 1) {
    return (
      <section class="card">
        <h2>Wish planner</h2>
        <p class="muted">Wishes unlock in Evil difficulty.</p>
      </section>
    );
  }
  const n = (k: keyof typeof fields) => Math.max(0, Number(fields[k]) || 0);
  const inputs = {
    energy: [n('energyPower'), n('energy')] as [number, number],
    magic: [n('magicPower'), n('magic')] as [number, number],
    res3: [n('res3Power'), n('res3')] as [number, number],
    speed: n('speed') / 100,
  };
  const q = query.trim().toLowerCase();
  const order = (v: number | null) => (v === null ? Infinity : v);
  const rows = wishRows(player, inputs, difficulty)
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => (sort === 'id' ? a.id - b.id : sort === 'max' ? order(a.maxSeconds) - order(b.maxSeconds) : order(a.nextSeconds) - order(b.nextSeconds)));
  const field = (key: keyof typeof fields, label: string) => (
    <label class="field">
      {label}
      <input type="number" min="0" step="any" value={fields[key]} onInput={(e) => setFields({ ...fields, [key]: e.currentTarget.value })} />
    </label>
  );

  return (
    <section class="card">
      <h2>Wish planner</h2>
      <p class="note">
        How long each wish takes with the resources below on it. Powers start from this save, and amounts from your caps
        split across your {slots} wish slot{slots === 1 ? '' : 's'}; copy the game's totals if they differ. Each resource
        counts only to the power of 0.17, so doubling one speeds a wish up by just 12.5%.
      </p>
      <div class="filter-row">
        {field('energyPower', 'Total energy power')}
        {field('magicPower', 'Total magic power')}
        {field('res3Power', 'Total resource 3 power')}
        {field('speed', 'Total wish speed (%)')}
      </div>
      <div class="filter-row">
        {field('energy', 'Energy per wish')}
        {field('magic', 'Magic per wish')}
        {field('res3', 'Resource 3 per wish')}
      </div>
      <section class="tiles calc-tiles" aria-label="Wish summary">
        <div class="tile"><span class="lbl">Wish slots</span><span class="big">{slots}</span><span class="chg">Split evenly, each runs at about {Math.round(Math.pow(1 / slots, 0.51) * 100)}% speed</span></div>
        <div class="tile"><span class="lbl">Minimum time per level</span><span class="big">{duration(minimumWishSeconds(player))}</span><span class="chg">No amount of resources is faster</span></div>
      </section>
      <div class="filter-row calc-table">
        <label class="field">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.currentTarget.value as typeof sort)}>
            {WISH_SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label class="field">
          Find a wish
          <input type="search" value={query} placeholder="e.g. dual wield" onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
      </div>
      <div class="table-wrap calc-table">
        <table>
          <thead>
            <tr><th scope="col" class="text">Wish</th><th scope="col">Level</th><th scope="col">Next level in</th><th scope="col">All levels in</th><th scope="col" class="text">Resources</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} class={r.running ? 'changed' : ''}>
                <td class="text">{r.name}{r.difficulty === 2 ? ' (Sadistic)' : ''}{r.running ? ' · running' : ''}</td>
                <td>{r.level} / {r.maxLevel}</td>
                <td>{r.nextSeconds === null ? 'Never' : duration(r.nextSeconds)}</td>
                <td>{r.maxSeconds !== null ? duration(r.maxSeconds) : r.stallLevel !== null && r.stallLevel > r.level ? `Stalls at level ${r.stallLevel}` : 'Never'}</td>
                <td class="text">{r.atMinimum ? `At the minimum time; ${Math.max(1, Math.ceil(r.shareNeeded * 100))}% of these would do` : r.nextSeconds === null ? 'Too little to finish this level' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">
        Highlighted wishes have resources on them in this save. Times leave out progress from other slots and assume the
        resources stay as entered. Each level of a wish is slower than the last. A level that would take longer than about 7¾
        days never finishes, because the game stores progress too coarsely to count such small steps past
        halfway, so more resources are needed to go further.
      </p>
    </section>
  );
}
