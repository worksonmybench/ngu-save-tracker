import type { PlayerData } from '../save/decode';

// Gold digger rules from the game (build 1260), checked against its own methods. A digger runs at
// any level up to its upgrade level, and drains gold per second from the Time Machine to do so.

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// [bonus, base gold drain per second, base upgrade cost, growth per level, starting boost, boost per level]
const DIGGERS: readonly (readonly [string, number, number, number, number, number])[] = [
  ['Drop Chance', 1e12, 1e16, 1.5, 0.5, 0.01],
  ['Wandoos Speed', 1e12, 1e16, 1.5, 0.5, 0.01],
  ['Attack/Defense', 1e12, 1e16, 1.5, 1, 0.01],
  ['Adventure Stats', 1e12, 1e16, 1.5, 0.1, 0.005],
  ['Energy NGU Speed', 1e15, 1e19, 1.75, 0.2, 0.01],
  ['Magic NGU Speed', 1e15, 1e19, 1.75, 0.2, 0.01],
  ['Energy Beard Speed', 1e18, 1e22, 1.75, 0.2, 0.01],
  ['Magic Beard Speed', 1e18, 1e22, 1.75, 0.2, 0.01],
  ['PP', 1e21, 1e25, 1.75, 0.1, 0.01],
  ['Daycare Speed', 1e21, 1e25, 1.75, 0.05, 0.001],
  ['Blood', 1e24, 1e28, 1.75, 0.5, 0.01],
  ['EXP', 1e24, 1e28, 1.75, 0.05, 0.005],
];
const STAT_DIGGER = 2; // its bonus grows with the cube of its level

const LEVEL_BONUS_STEP = 0.0005;
const LEVEL_BONUS_KNEE = 500;
const LEVEL_BONUS_POWER = 0.7;
const LEVEL_BONUS_EXTRA = 0.05; // each for a No Time Machine clear and the Party set
const SLOT_PERKS = [52, 53];
const TM_CLEARS_FOR_SLOT = 5;

export type Digger = { index: number; name: string; maxLevel: number; level: number; active: boolean };

export function readDiggers(p: PlayerData): Digger[] {
  return list(p.diggers?.diggers).slice(0, DIGGERS.length).map((d, index) => ({
    index,
    name: DIGGERS[index][0],
    maxLevel: num(d?.maxLevel),
    level: num(d?.curLevel),
    active: !!d?.active,
  }));
}

// Gold per second a digger takes at this level.
export const drainAt = (index: number, level: number) => (level > 0 ? DIGGERS[index][1] * Math.pow(DIGGERS[index][3], level - 1) : 0);
// Gold to buy the next upgrade level.
export const upgradeCost = (index: number, maxLevel: number) => DIGGERS[index][2] * Math.pow(DIGGERS[index][3], maxLevel);

// Every upgrade level owned, on any digger, raises all digger bonuses.
export function levelBonus(p: PlayerData, diggers: Digger[]) {
  const total = diggers.reduce((s, d) => s + d.maxLevel, 0);
  let bonus = total <= LEVEL_BONUS_KNEE
    ? f(1 + f(total * LEVEL_BONUS_STEP))
    : f(1.25 + f(f(Math.pow(total - LEVEL_BONUS_KNEE, LEVEL_BONUS_POWER)) * LEVEL_BONUS_STEP));
  if (num(p.challenges?.timeMachineChallenge?.curCompletions) >= 1) bonus = f(bonus + LEVEL_BONUS_EXTRA);
  if (p.inventory?.itemList?.partyComplete) bonus = f(bonus + LEVEL_BONUS_EXTRA);
  return bonus;
}

// The multiplier a digger gives while running at `level`.
export function bonusAt(index: number, level: number, levels: number) {
  const [, , , , start, perLevel] = DIGGERS[index];
  const scaled = index === STAT_DIGGER ? level ** 3 : level;
  return Math.max(1, f(f(1 + f(start + scaled * perLevel)) * levels));
}

export function diggerSlots(p: PlayerData) {
  const perks: unknown[] = p.adventure?.itopod?.perkLevel ?? [];
  const slots =
    1 +
    (p.purchases?.hasDiggerSlot1 ? 1 : 0) +
    SLOT_PERKS.filter((i) => num(perks[i]) >= 1).length +
    num(p.arbitrary?.diggerSlots) +
    (p.inventory?.itemList?.jakeNoteComplete ? 1 : 0) +
    (num(p.challenges?.timeMachineChallenge?.curCompletions) >= TM_CLEARS_FOR_SLOT ? 1 : 0);
  return Math.min(DIGGERS.length, slots);
}

export type DiggerRow = Digger & {
  drain: number; // now, if active
  bonus: number; // now, if active
  affordable: number; // highest level the income left after the other active diggers can run
  bonusAffordable: number;
  nextCost: number;
  secondsToNext: number | null; // at the gold income left after all active diggers
};

export type DiggerPlan = { rows: DiggerRow[]; income: number; drain: number; levels: number; slots: number; active: number };

// `income` is gold per second before digger drain.
export function planDiggers(p: PlayerData, income: number): DiggerPlan {
  const diggers = readDiggers(p);
  const levels = levelBonus(p, diggers);
  const running = (d: Digger) => d.active && d.level > 0;
  const drain = diggers.reduce((s, d) => s + (running(d) ? drainAt(d.index, d.level) : 0), 0);
  const net = income - drain;
  const rows = diggers.map((d): DiggerRow => {
    const others = drain - (running(d) ? drainAt(d.index, d.level) : 0);
    const budget = income - others;
    const [, base, , growth] = DIGGERS[d.index];
    const fits = budget >= base ? Math.floor(Math.log(budget / base) / Math.log(growth) + 1e-9) + 1 : 0;
    const affordable = Math.min(d.maxLevel, fits);
    const nextCost = upgradeCost(d.index, d.maxLevel);
    return {
      ...d,
      drain: running(d) ? drainAt(d.index, d.level) : 0,
      bonus: d.active ? bonusAt(d.index, d.level, levels) : 1,
      affordable,
      bonusAffordable: bonusAt(d.index, affordable, levels),
      nextCost,
      secondsToNext: net > 0 ? nextCost / net : null,
    };
  });
  return { rows, income, drain, levels, slots: diggerSlots(p), active: diggers.filter((d) => d.active).length };
}
