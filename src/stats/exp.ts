import type { PlayerData } from '../save/decode';

// EXP shop rules from the game (build 1260): magic costs 3× energy, and purchases can't be undone.
const POWER_COST = 150;
const BAR_COST = 80;
const CAP_PER_EXP = 250;
const MAGIC_COST_FACTOR = 3;

// Equal-EXP amounts of energy power, cap and bars, for reference when choosing a ratio.
export const EQUAL_EXP_RATIO: Ratio = { power: 1, cap: POWER_COST * CAP_PER_EXP, bars: POWER_COST / BAR_COST };

export type Ratio = { power: number; cap: number; bars: number };
export type PlanInput = { budget: number; energyPerMagic: number; ratio: Ratio };
export type Purchase = { key: string; label: string; current: number; target: number; buy: number; cost: number };
export type Plan = { purchases: Purchase[]; spent: number; unused: number; fullCost: number; fullyBalanced: boolean };

type Stat = { key: string; label: string; current: number; share: number; unitCost: number; step: number };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const availableExp = (p: PlayerData) => num(p.realExp);

function statsOf(p: PlayerData, { energyPerMagic, ratio }: PlanInput): Stat[] {
  // Each stat's target is a share of one scale: its amount per unit of energy power.
  const cap = ratio.cap / ratio.power;
  const bars = ratio.bars / ratio.power;
  const magic = 1 / energyPerMagic;
  return [
    { key: 'energyPower', label: 'Energy power', current: num(p.energyPower), share: 1, unitCost: POWER_COST, step: 1 },
    { key: 'energyCap', label: 'Energy cap', current: num(p.capEnergy), share: cap, unitCost: 1 / CAP_PER_EXP, step: CAP_PER_EXP },
    { key: 'energyBars', label: 'Energy bars', current: num(p.energyBars), share: bars, unitCost: BAR_COST, step: 1 },
    { key: 'magicPower', label: 'Magic power', current: num(p.magic?.magicPower), share: magic, unitCost: POWER_COST * MAGIC_COST_FACTOR, step: 1 },
    { key: 'magicCap', label: 'Magic cap', current: num(p.magic?.capMagic), share: cap * magic, unitCost: MAGIC_COST_FACTOR / CAP_PER_EXP, step: CAP_PER_EXP },
    { key: 'magicBars', label: 'Magic bars', current: num(p.magic?.magicPerBar), share: bars * magic, unitCost: BAR_COST * MAGIC_COST_FACTOR, step: 1 },
  ];
}

const costAt = (stats: Stat[], scale: number) =>
  stats.reduce((sum, s) => sum + Math.max(0, scale * s.share - s.current) * s.unitCost, 0);

// Raises the lowest stats first, since nothing can be sold: at each budget, every stat below the
// common scale is brought up to it and stats above it are left alone.
export function planPurchases(p: PlayerData, input: PlanInput): Plan {
  const stats = statsOf(p, input);
  const balancedScale = Math.max(...stats.map((s) => s.current / s.share));
  const fullCost = costAt(stats, balancedScale);
  let low = 0;
  let high = balancedScale || 1;
  while (costAt(stats, high) < input.budget) high *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    if (costAt(stats, mid) <= input.budget) low = mid;
    else high = mid;
  }
  const purchases = stats.map((s) => {
    const target = low * s.share;
    // The shop sells power and bars whole, and charges for cap in whole EXP.
    const buy = Math.floor(Math.max(0, target - s.current) / s.step) * s.step;
    return { key: s.key, label: s.label, current: s.current, target, buy, cost: Math.round(buy * s.unitCost) };
  });
  const spent = purchases.reduce((sum, b) => sum + b.cost, 0);
  return { purchases, spent, unused: Math.max(0, input.budget - spent), fullCost: Math.ceil(fullCost), fullyBalanced: input.budget >= fullCost };
}

export function applyPurchases(p: PlayerData, plan: Plan): PlayerData {
  const buy = (key: string) => plan.purchases.find((b) => b.key === key)?.buy ?? 0;
  return {
    ...p,
    energyPower: num(p.energyPower) + buy('energyPower'),
    capEnergy: num(p.capEnergy) + buy('energyCap'),
    energyBars: num(p.energyBars) + buy('energyBars'),
    magic: {
      ...p.magic,
      magicPower: num(p.magic?.magicPower) + buy('magicPower'),
      capMagic: num(p.magic?.capMagic) + buy('magicCap'),
      magicPerBar: num(p.magic?.magicPerBar) + buy('magicBars'),
    },
  };
}
