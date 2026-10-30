import type { PlayerData } from '../save/decode';
import { gearBonuses, resource } from './formulas';

// Augment and gold income rules from the game (build 1260), tested against its methods.
//
// Leaves out the bonuses for maxing the No Augs and Laser Sword challenges (a 50% discount, ×1.25
// speed and a higher tier), because how many clears "max" means isn't in the extracted data.

type Aug = {
  name: string;
  upgradeName: string;
  augDividers: readonly [number, number, number]; // per difficulty
  upgradeDividers: readonly [number, number, number];
  augCost: number;
  upgradeCost: number;
  boost: number;
  augBoss: number;
  upgradeBoss: number;
};

export const AUGMENTS: readonly Aug[] = [
  { name: 'Safety Scissors', upgradeName: 'Danger Scissors', augDividers: [400, 1e15, 1e27], upgradeDividers: [400, 1e15, 1e27], augCost: 1e4, upgradeCost: 1e7, boost: 1, augBoss: 16, upgradeBoss: 36 },
  { name: 'Milk Infusion', upgradeName: 'Drinking the Milk Too', augDividers: [6800, 1.7e16, 1.7e28], upgradeDividers: [4800, 1.2e16, 1.2e28], augCost: 2e5, upgradeCost: 5e8, boost: 25, augBoss: 17, upgradeBoss: 39 },
  { name: 'Cannon Implant', upgradeName: 'Missile Launcher', augDividers: [115600, 2.9e17, 2.9e29], upgradeDividers: [57600, 1.44e17, 1.44e29], augCost: 4e6, upgradeCost: 2.4999999488e10, boost: 625, augBoss: 19, upgradeBoss: 43 },
  { name: 'Shoulder Mounted Minigun', upgradeName: 'Actual Ammunition', augDividers: [1965200, 5e18, 5e30], upgradeDividers: [691200, 1.728e18, 1.72e30], augCost: 8e7, upgradeCost: 1.249999978496e12, boost: 15625, augBoss: 23, upgradeBoss: 45 },
  { name: 'Energy Buster', upgradeName: 'Charge Shot', augDividers: [33408400, 8.5e19, 8.5e31], upgradeDividers: [8294400, 2.074e19, 2.074e31], augCost: 1.6e9, upgradeCost: 6.2499999186944e13, boost: 390625, augBoss: 27, upgradeBoss: 47 },
  { name: 'Advanced Exoskeleton', upgradeName: 'Energy Shield', augDividers: [46771760000, 1.19e23, 1.19e35], upgradeDividers: [6635520000, 1.659e22, 1.659e34], augCost: 1.7999999631622144e16, upgradeCost: 3.1250000626277417e18, boost: 976562500, augBoss: 55, upgradeBoss: 55 },
  { name: 'Laser Sword', upgradeName: 'Quadruple Sided Laser Sword', augDividers: [65480460000000, 1.666e26, 1.666e38], upgradeDividers: [5308416000000, 1.327e25, 1.327e37], augCost: 2.2999999845213667e19, upgradeCost: 1.562499931566176e23, boost: 2441406250000, augBoss: 67, upgradeBoss: 67 },
];

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const TICKS_PER_SECOND = 50;
const ENERGY_DIVISOR = 50000;
const SADISTIC_DIVISOR = 5e7;
const AUG_SPEED_SPEC = 30;
const AUG_SPEED_MACGUFFIN = 12;
const AUG_SPEED_CARD = 4;
const AUG_HACK = 4;
const HACK_EFFECT = 0.002;
const HACK_MILESTONE_EFFECT = 1.01;
const HACK_MILESTONE_LEVELS = 20;
const SADISTIC_PERK = 144;
const SADISTIC_PERK_BONUS = 1.2;
const NO_AUGS_CLEARED_BONUS = 1.1;
const NO_AUGS_EVIL_PER_CLEAR = 0.05;

function augHackBonus(p: PlayerData) {
  if (p.hacks?.disabled || num(p.settings?.rebirthDifficulty) < 1) return 1;
  const level = num(p.hacks?.hacks?.[AUG_HACK]?.level);
  return (1 + level * HACK_EFFECT) * Math.pow(HACK_MILESTONE_EFFECT, Math.max(0, Math.floor(level / HACK_MILESTONE_LEVELS)));
}

// Everything that speeds up both augments and upgrades, apart from energy, power and its divider.
export function augSpeedFactor(p: PlayerData) {
  const noAugs = p.challenges?.noAugsChallenge ?? {};
  const cards = p.cards?.cardsOn ? num(p.cards?.bonuses?.[AUG_SPEED_CARD]) : 1;
  const difficulty = num(p.settings?.rebirthDifficulty);
  const perk = difficulty >= 2 && num(p.adventure?.itopod?.perkLevel?.[SADISTIC_PERK]) >= 1 ? SADISTIC_PERK_BONUS : 1;
  return (
    (1 + gearBonuses(p)[AUG_SPEED_SPEC]) *
    num(p.inventory?.macguffinBonuses?.[AUG_SPEED_MACGUFFIN]) *
    augHackBonus(p) *
    perk *
    cards *
    (1 + num(noAugs.curEvilCompletions) * NO_AUGS_EVIL_PER_CLEAR) *
    (num(noAugs.curCompletions) >= 1 ? NO_AUGS_CLEARED_BONUS : 1)
  );
}

// Progress per tick at level 0 for one unit of energy. Divide by (level + 1) for higher levels.
function perEnergy(p: PlayerData, dividers: readonly [number, number, number]) {
  const difficulty = Math.min(2, Math.max(0, num(p.settings?.rebirthDifficulty)));
  const power = resource(p, 'energyPower')?.total ?? 1;
  const scale = difficulty === 2 ? 1 / SADISTIC_DIVISOR : 1 / ENERGY_DIVISOR;
  return (power * scale * augSpeedFactor(p)) / dividers[difficulty];
}
export const augPerEnergy = (p: PlayerData, id: number) => perEnergy(p, AUGMENTS[id].augDividers);
export const upgradePerEnergy = (p: PlayerData, id: number) => perEnergy(p, AUGMENTS[id].upgradeDividers);

export function augTier(p: PlayerData, id: number) {
  const clears = num(p.challenges?.laserSwordChallenge?.curCompletions);
  const extra = clears >= 1 ? 0.05 + 0.01 * clears : 0;
  return 1 + 0.1 * id + extra * id;
}

export const augBoost = (p: PlayerData, id: number, level: number, upgrade: number) =>
  AUGMENTS[id].boost * Math.max(1 + upgrade * upgrade, 1) * Math.pow(level, augTier(p, id));

export function currentAugBoost(p: PlayerData) {
  const saved: any[] = p.augments?.augs ?? [];
  return AUGMENTS.reduce((sum, _, id) => sum + augBoost(p, id, num(saved[id]?.augLevel), num(saved[id]?.upgradeLevel)), 0);
}

// Gold income: the Time Machine's base gold and every multiplier on it, before digger costs.
const MACHINE_BOSS_OFFSET = 27;
const MAX_BAR_FILLS = 50;
const SPEED_MULTI_OFFSET = 48;
const MIN_GOLD_BLOOD = 1e6;
const GOLD_BEARD = 6;
const CURVE_LEVEL = 1000;
const TIME_MACHINE_NGU = 4;
const NGU_FACTORS = [
  ['level', 0],
  ['evilLevel', 1],
  ['sadisticLevel', 2],
] as const;

function bloodGoldBonus(p: PlayerData) {
  const blood = num(p.bloodMagic?.goldSpellBlood);
  if (blood < MIN_GOLD_BLOOD) return 1;
  return 1 + Math.floor(Math.pow(Math.log2(blood / MIN_GOLD_BLOOD) + 1, 2)) * 0.01;
}

function beardGoldBonus(p: PlayerData) {
  if (p.beards?.disabled) return 1;
  const beard = p.beards?.beards?.[GOLD_BEARD] ?? {};
  const curve = (level: number, per: number) => (level <= CURVE_LEVEL ? 1 + level * per : 1 + Math.pow(level, 0.5) * 31.7 * per);
  return Math.max(1, (beard.active ? curve(num(beard.beardLevel), 0.002) : 1) * curve(num(beard.permLevel), 0.005));
}

export function grossGoldPerSecond(p: PlayerData, nguBoost: (level: number, track: number) => number = timeMachineNgu) {
  if (p.challenges?.timeMachineChallenge?.inChallenge) return 0;
  const machine = p.machine ?? {};
  const speed = num(machine.levelSpeed);
  const difficulty = num(p.settings?.rebirthDifficulty);
  const skill = p.NGU?.magicSkills?.[TIME_MACHINE_NGU] ?? {};
  let ngu = 1;
  if (!p.NGU?.disabled) {
    for (const [key, track] of NGU_FACTORS) if (difficulty >= track) ngu *= nguBoost(num(skill[key]), track);
  }
  return (
    num(machine.realBaseGold) *
    Math.max(num(p.highestBoss) - MACHINE_BOSS_OFFSET, 1) *
    Math.min(1 + speed, MAX_BAR_FILLS) *
    Math.max(1, Math.ceil(speed - SPEED_MULTI_OFFSET)) *
    (1 + num(machine.levelGoldMulti)) *
    bloodGoldBonus(p) *
    beardGoldBonus(p) *
    ngu *
    (1 + num(p.challenges?.timeMachineChallenge?.curCompletions))
  );
}

const TM_NGU_BOOST = [0.002, 0.001, 0.001];
function timeMachineNgu(level: number, track: number) {
  const boost = TM_NGU_BOOST[track];
  return level <= CURVE_LEVEL ? 1 + level * boost : 1 + Math.pow(level, 0.8) * 3.981 * boost;
}

export type PairInput = { hours: number; energy: number; gold: number; goldPerSecond: number; fresh: boolean };
export type PairResult = {
  id: number;
  name: string;
  upgradeName: string;
  level: number;
  upgrade: number;
  upgradeShare: number; // of the energy
  limit: 'gold' | 'energy' | 'locked';
  bonus: number;
  goldSpent: number;
  startBonus: number;
};

const SEARCH_STEPS = 2000;
const GOLD_LIMIT_FRACTION = 0.999;

// With energy E split over time, level L takes L²/(2·c·t) energy, and costs B·L²/2 gold; an upgrade
// U costs B·U³/3. So for each upgrade level, the energy left and gold left fix the best augment level.
function bestPair(p: PlayerData, id: number, input: PairInput): PairResult {
  const aug = AUGMENTS[id];
  const saved = p.augments?.augs?.[id] ?? {};
  const startL = input.fresh ? 0 : num(saved.augLevel);
  const startU = input.fresh ? 0 : num(saved.upgradeLevel);
  const ticks = input.hours * 3600 * TICKS_PER_SECOND;
  const gold = input.gold + input.goldPerSecond * input.hours * 3600;
  const ca = augPerEnergy(p, id);
  const cu = upgradePerEnergy(p, id);
  const boss = num(p.highestBoss);
  const base = { id, name: aug.name, upgradeName: aug.upgradeName, startBonus: augBoost(p, id, startL, startU) };
  if (boss <= aug.augBoss || ticks <= 0 || input.energy <= 0 || ca <= 0) {
    return { ...base, level: startL, upgrade: startU, upgradeShare: 0, limit: boss <= aug.augBoss ? 'locked' : 'energy', bonus: base.startBonus, goldSpent: 0 };
  }
  const upgradeOpen = boss > aug.upgradeBoss;
  const uMaxEnergy = Math.sqrt(startU * startU + 2 * cu * input.energy * ticks);
  const uMaxGold = Math.cbrt(startU ** 3 + (3 * gold) / aug.upgradeCost);
  const uMax = upgradeOpen ? Math.min(uMaxEnergy, uMaxGold) : startU;
  let best = { v: -1, L: startL, U: startU, share: 0, spent: 0, limit: 'energy' as 'gold' | 'energy' };
  const consider = (U: number) => {
    const energyU = cu > 0 ? (U * U - startU * startU) / (2 * cu * ticks) : 0;
    const costU = (aug.upgradeCost * (U ** 3 - startU ** 3)) / 3;
    if (energyU > input.energy || costU > gold) return;
    const byEnergy = Math.sqrt(startL * startL + 2 * ca * (input.energy - energyU) * ticks);
    const byGold = Math.sqrt(startL * startL + (2 * (gold - costU)) / aug.augCost);
    const L = Math.min(byEnergy, byGold);
    const v = augBoost(p, id, L, U);
    if (v > best.v) {
      best = { v, L, U, share: energyU / input.energy, spent: costU + (aug.augCost * (L * L - startL * startL)) / 2, limit: 'energy' };
    }
  };
  for (let i = 0; i <= SEARCH_STEPS; i++) consider(startU + ((uMax - startU) * i) / SEARCH_STEPS);
  // The peak lies between grid points; narrow in on it.
  let width = (uMax - startU) / SEARCH_STEPS;
  for (let round = 0; round < 40 && width > 1e-6; round++) {
    const centre = best.U;
    for (let k = -10; k <= 10; k++) consider(Math.min(uMax, Math.max(startU, centre + (k * width) / 5)));
    width /= 5;
  }
  // Gold is the limit whenever it all gets spent, even if it's the upgrade it holds back.
  const limit = best.spent >= gold * GOLD_LIMIT_FRACTION ? 'gold' : 'energy';
  return { ...base, level: best.L, upgrade: best.U, upgradeShare: best.share, limit, bonus: best.v, goldSpent: best.spent };
}

export function rankPairs(p: PlayerData, input: PairInput): PairResult[] {
  return AUGMENTS.map((_, id) => bestPair(p, id, input)).sort((a, b) => b.bonus - a.bonus);
}
