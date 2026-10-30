import type { PlayerData } from '../save/decode';
import { gearBonuses } from './formulas';

// Yggdrasil fruit rules from the game (build 1260). Seed figures assume no poop is used.

// [name, base seed cost, base seed reward, activation cost]. Index = fruit id.
const FRUITS: readonly (readonly [string, number, number, number])[] = [
  ['Fruit of Gold', 1, 1, 1e5], ['Fruit of Power α', 10, 1, 2e5], ['Fruit of Adventure', 25, 1, 2e5],
  ['Fruit of Knowledge', 40, 1, 1e6], ['Pomegranate', 60, 5, 3e5], ['Fruit of Luck', 100, 1, 5e6],
  ['Fruit of Power β', 150, 1, 3e6], ['Fruit of Arbitrariness', 170, 3, 2e7], ['Fruit of Numbers', 200, 3, 1e7],
  ['Fruit of Rage', 2000, 5, 5e8], ['Fruit of MacGuffin α', 15000, 6, 5e8], ['Fruit of Power δ', 30000, 7, 5e9],
  ['Watermelon', 50000, 30, 2e10], ['Fruit of MacGuffin β', 100000, 8, 1e11], ['Fruit of Quirks', 25000, 7, 4e10],
  ['Fruit of Angry Mayo', 250000, 10, 1e16], ['Fruit of Sad Mayo', 250000, 10, 1e16], ['Fruit of Moldy Mayo', 250000, 10, 1e16],
  ['Fruit of Ayy Lmayo', 250000, 10, 1e16], ['Fruit of Cinco De Mayo', 250000, 10, 1e16], ['Fruit of Pretty Mayo', 250000, 10, 1e16],
];

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const SECONDS_PER_TIER = 3600;
const TIER_SECONDS_PER_QUIRK = 60;
const MAX_TIER_SECONDS_SAVED = 180;
const TIER_TIME_QUIRK = 13;
const BASE_TIER_CAP = 10;
const RAISED_TIER_CAP = 24;
const TROLL_CLEARS_FOR_RAISED_CAP = 3;
const SEED_GAIN_SPEC = 15;
const HARVEST_MULTIPLIER = 2;

export const tierSeconds = (p: PlayerData) =>
  SECONDS_PER_TIER - Math.min(num(p.beastQuest?.quirkLevel?.[TIER_TIME_QUIRK]) * TIER_SECONDS_PER_QUIRK, MAX_TIER_SECONDS_SAVED);

export const tierCap = (p: PlayerData) =>
  num(p.challenges?.trollChallenge?.curCompletions) >= TROLL_CLEARS_FOR_RAISED_CAP ? RAISED_TIER_CAP : BASE_TIER_CAP;

const tierFactor = (tier: number) => Math.ceil(f(Math.pow(tier, 1.5)));

// The Yggdrasil NGU: linear to level 400, then a power curve. One entry per difficulty.
const YGGDRASIL_NGU = [
  { levelKey: 'level', boost: 0.001, power: 0.33, scale: 55.4 },
  { levelKey: 'evilLevel', boost: 0.0005, power: 0.1, scale: 219.72 },
  { levelKey: 'sadisticLevel', boost: 0.0004, power: 0.08, scale: 247.69 },
];
const NGU_CURVE_LEVEL = 400;

function yggdrasilNguBonus(p: PlayerData) {
  if (p.NGU?.disabled) return 1;
  const skill = p.NGU?.magicSkills?.[0] ?? {};
  const difficulty = num(p.settings?.rebirthDifficulty);
  let out = 1;
  YGGDRASIL_NGU.forEach(({ levelKey, boost, power, scale }, i) => {
    if (difficulty < i) return;
    const level = num(skill[levelKey]);
    const bonus = level <= NGU_CURVE_LEVEL ? 1 + f(level * f(boost)) : 1 + f(f(f(Math.pow(level, f(power))) * f(scale)) * f(boost));
    out = f(out * f(bonus));
  });
  return out;
}

const SEED_PERK = 24;
const SEED_PERK_EFFECT = 0.05;
const SEED_QUIRK = 12;
const SEED_QUIRK_EFFECT = 0.01;
const FIRST_HARVEST_PERK = 51;
const FIRST_HARVEST_PERK_EFFECT = 0.1;
const FIRST_HARVEST_MAX = 1.5;

export function harvestSeeds(p: PlayerData, id: number, tier: number) {
  const perks: unknown[] = p.adventure?.itopod?.perkLevel ?? [];
  const seedPerk = Math.max(1, f(1 + f(f(num(perks[SEED_PERK])) * f(SEED_PERK_EFFECT))));
  const seedQuirk = Math.max(1, f(1 + f(f(num(p.beastQuest?.quirkLevel?.[SEED_QUIRK])) * f(SEED_QUIRK_EFFECT))));
  // This perk only raises the first harvest of each fruit in a rebirth.
  const firstHarvest =
    num(p.yggdrasil?.fruits?.[id]?.harvests) > 0
      ? 1
      : Math.max(1, Math.min(FIRST_HARVEST_MAX, f(1 + f(f(num(perks[FIRST_HARVEST_PERK])) * f(FIRST_HARVEST_PERK_EFFECT)))));
  const gear = f(1 + gearBonuses(p)[SEED_GAIN_SPEC]);
  const base = FRUITS[id][2] * tierFactor(tier) * HARVEST_MULTIPLIER;
  return Math.ceil(f(f(f(f(f(base * seedPerk) * seedQuirk) * gear) * yggdrasilNguBonus(p)) * firstHarvest));
}

const tierAt = (seconds: number, perTier: number, maxTier: number) => Math.min(Math.floor(f(seconds / perTier)), maxTier);

export type FruitRow = {
  id: number;
  name: string;
  state: 'locked' | 'inactive' | 'growing' | 'ready';
  maxTier: number;
  tier: number;
  secondsToNext: number | null;
  secondsToMax: number | null;
  seedsNow: number;
  seedsAtMax: number;
  nextTierCost: number | null;
  affordable: boolean;
  paybackHarvests: number | null;
  activationCost: number;
};

export type FruitReport = {
  rows: FruitRow[];
  seeds: number;
  tierCap: number;
  seedsAtStake: number; // seeds available from ripe fruit, lost if not collected before a rebirth
  growthLostAtRebirth: boolean;
  secondsToAllMax: number;
};

// hoursAhead projects growth forward from the save; fruit keeps growing at one second per second.
export function fruitReport(p: PlayerData, hoursAhead = 0): FruitReport {
  const perTier = tierSeconds(p);
  const cap = tierCap(p);
  const seeds = num(p.yggdrasil?.seeds);
  const saved: any[] = p.yggdrasil?.fruits ?? [];
  const rows = FRUITS.map(([name, seedCost, , activationCost], id): FruitRow => {
    const fruit = saved[id] ?? {};
    const maxTier = num(fruit.maxTier);
    const maxSeconds = maxTier * perTier;
    const active = !!fruit.activated;
    const seconds = active ? Math.min(num(fruit.seconds) + hoursAhead * 3600, Math.max(num(fruit.seconds), maxSeconds)) : 0;
    const tier = tierAt(seconds, perTier, maxTier);
    const full = active && tier >= maxTier;
    const nextTierCost = maxTier < cap ? seedCost * Math.ceil(f(Math.pow(maxTier + 1, 2))) : null;
    const seedsNow = tier > 0 ? harvestSeeds(p, id, tier) : 0;
    const seedsAtMax = maxTier > 0 ? harvestSeeds(p, id, maxTier) : 0;
    const gain = nextTierCost !== null && maxTier > 0 ? harvestSeeds(p, id, maxTier + 1) - seedsAtMax : 0;
    return {
      id,
      name,
      state: maxTier === 0 ? 'locked' : !active ? 'inactive' : full ? 'ready' : 'growing',
      maxTier,
      tier,
      secondsToNext: active && !full ? perTier - (seconds % perTier) : null,
      secondsToMax: active && !full ? maxSeconds - seconds : null,
      seedsNow,
      seedsAtMax,
      nextTierCost,
      affordable: nextTierCost !== null && seeds >= nextTierCost,
      paybackHarvests: nextTierCost !== null && gain > 0 ? Math.ceil(nextTierCost / gain) : null,
      activationCost,
    };
  });
  return {
    rows,
    seeds,
    tierCap: cap,
    seedsAtStake: rows.reduce((sum, r) => sum + r.seedsNow, 0),
    // A reset multiplies growth by the floor of this factor, capped at 1.
    growthLostAtRebirth: num(p.yggdrasil?.resetFactor) < 1,
    secondsToAllMax: Math.max(0, ...rows.map((r) => r.secondsToMax ?? 0)),
  };
}
