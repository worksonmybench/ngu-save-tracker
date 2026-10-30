import type { PlayerData } from '../save/decode';

// Stat formulas reimplemented from the game (build 1260), tested against the predictor on real
// saves. The game computes in float32, hence fround at the same steps.
export const FORMULA_BUILD = 1260;

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
// Unity's Mathf.Min: with a NaN argument (0/0 on an item with no boss requirement) it returns b.
const unityMin = (a: number, b: number) => (a < b ? a : b);
const BOSS_OFFSET_PER_DIFFICULTY = 301;

// Gear effects: spec type -> [label, divisor turning its sum into a fraction]. Index = spec type.
export const SPECS: readonly (readonly [label: string, divisor: number])[] = [
  ['None', 100], ['Energy Power', 100], ['Energy Speed', 100], ['Magic Power', 100], ['Magic Speed', 100],
  ['Drop Chance', 1000], ['Gold Drop Rate', 100], ['Gold Drops', 100], ['Energy Bars', 100], ['Magic Bars', 100],
  ['Boost Recycling', 1000], ['Cooking', 100], ['Wandoos Speed', 10000], ['Advanced Training', 10000], ['Move Cooldowns', 10000],
  ['Seed Gain', 100000], ['Energy Power', 1000], ['Magic Power', 1000], ['Energy Bars', 1000], ['Magic Bars', 1000],
  ['Energy Cap', 10000], ['Magic Cap', 10000], ['NGU Speed', 10000], ['Respawn', 100000], ['EXP', 1000000],
  ['AP', 1000000], ['Beard Speed', 100000], ['Energy and Magic Power', 100000], ['Energy and Magic Bars', 100000], ['Energy and Magic Cap', 1000000],
  ['Augment Speed', 1000000], ['Wandoos Speed', 1000000], ['Advanced Training', 1000000], ['Energy Power', 100000], ['Magic Power', 100000],
  ['Energy Bars', 100000], ['Magic Bars', 100000], ['Energy Cap', 1000000], ['Magic Cap', 1000000], ['NGU Speed', 1000000],
  ['Gold Drops', 100000], ['Drop Chance', 1000000], ['Beard Speed', 1000000], ['Yggdrasil Yield', 10000000], ['Daycare Speed', 10000000],
  ['Quest Drops', 100000000], ['Blood Gain', 100000000], ['Resource 3 Power', 100000000], ['Resource 3 Bars', 100000000], ['Resource 3 Cap', 1000000000],
  ['Hack Speed', 1000000000], ['Wish Speed', 1000000000],
];

const effectiveBoss = (p: PlayerData) => num(p.bossID) + num(p.settings?.rebirthDifficulty) * BOSS_OFFSET_PER_DIFFICULTY;
export const gearDisabled = (p: PlayerData) => !!p.challenges?.noEquipmentChallenge?.inChallenge || !!p.inventory?.disabled;

const DUAL_WIELD_WISHES = [28, 45];
const DUAL_WIELD_EFFECT = 0.05;

function dualWieldFactor(p: PlayerData) {
  const level = (i: number) => num(p.wishes?.wishes?.[i]?.level);
  if (level(DUAL_WIELD_WISHES[0]) <= 0) return 0;
  return unityMin(1, f(DUAL_WIELD_WISHES.reduce((s, i) => s + f(f(level(i)) * f(DUAL_WIELD_EFFECT)), 0)));
}

function wornGear(p: PlayerData): [item: any, scale: number][] {
  const inv = p.inventory ?? {};
  return [
    ...['weapon', 'head', 'chest', 'legs', 'boots'].map((k): [any, number] => [inv[k], 1]),
    [inv.weapon2, dualWieldFactor(p)],
    ...(Array.isArray(inv.accs) ? inv.accs : []).map((e: any): [any, number] => [e, 1]),
  ];
}

// An item's stat at this save's boss: gear that needs a later boss is scaled down.
export const scaledStat = (p: PlayerData, item: any, value: unknown) =>
  Math.floor(f(num(value) * unityMin(f(effectiveBoss(p) / f(num(item?.bossRequired))), 1)));

// Sums per spec type over worn gear. Zero everywhere when gear is disabled.
export function specSums(p: PlayerData): number[] {
  const sums: number[] = SPECS.map(() => 0);
  if (gearDisabled(p)) return sums;
  for (const [item, scale] of wornGear(p)) {
    if (!item?.spec1Type) continue;
    for (const n of [1, 2, 3]) {
      const type = item[`spec${n}Type`];
      if (type > 0 && type < SPECS.length) sums[type] = f(sums[type] + f(scaledStat(p, item, item[`spec${n}Cur`]) * scale));
    }
  }
  return sums;
}

// The fraction each spec type adds. Matches the game's InventoryController.bonuses.
export const gearBonuses = (p: PlayerData) => specSums(p).map((sum, type) => f(sum / SPECS[type][1]));

function additiveGear(p: PlayerData, field: 'curAttack' | 'curDefense') {
  if (gearDisabled(p)) return 0;
  let out = 0;
  for (const [item, scale] of wornGear(p)) if (item) out = f(out + f(scaledStat(p, item, item[field]) * scale));
  return out;
}
export const gearAttack = (p: PlayerData) => additiveGear(p, 'curAttack');
export const gearDefense = (p: PlayerData) => additiveGear(p, 'curDefense');

// Energy and magic totals all share one shape; only their constants differ.
export type ResourceKey = 'energyPower' | 'energyCap' | 'energyBars' | 'magicPower' | 'magicCap' | 'magicBars';
export type ResourceFactors = { base: number; perks: number; gear: number; macguffin: number; quirks: number; wishes: number; potions: number };
export type Resource = { total: number; factors: ResourceFactors };

// [index, effect per level, minimum rebirth difficulty]
type Bonus = readonly [index: number, effect: number, difficulty: number];
type Def = {
  base: (p: PlayerData) => unknown;
  perks: readonly Bonus[];
  flatPerkLevel: number; // ×1.1 from perk 94 at this level
  flatPerkExcluded?: boolean;
  quirks: readonly Bonus[];
  wishes: readonly Bonus[];
  gear: readonly number[];
  macguffin: number;
  potionTimes: readonly string[];
  potionFlags: readonly string[];
  kind: 'power' | 'cap' | 'bars';
};

// The perk, quirk and wish families step through the same effects, offset per stat.
const perks = (i: readonly number[], late: number): readonly Bonus[] => [
  [i[0], 0.01, 0], [i[1], 0.01, 1], [i[2], 0.003, 1], [i[3], 0.002, 1],
  [i[4], late, 2], [i[5], late, 2], [i[6], 0.01, 2],
];
const quirks = (i: readonly number[], late: number): readonly Bonus[] => [
  [i[0], 0.1, 0], [i[1], 0.01, 0], [i[2], 0.01, 1], [i[3], late, 2], [i[4], late, 2], [i[5], 0.01, 2],
];
const wishes = (i: readonly number[], early: number, late: number): readonly Bonus[] => [
  [i[0], early, 1], [i[1], early, 1], [i[2], early, 1], [i[3], early, 1], [i[4], late, 2], [i[5], late, 2], [i[6], late, 2],
];

const DEFS: Record<ResourceKey, Def> = {
  energyPower: {
    base: (p) => p.energyPower, kind: 'power', macguffin: 0, flatPerkLevel: 1, gear: [1, 16, 27, 33],
    perks: perks([6, 57, 74, 116, 126, 135, 220], 0.002), quirks: quirks([0, 35, 41, 61, 80, 177], 0.005),
    wishes: wishes([9, 31, 48, 64, 82, 91, 193], 0.05, 0.02),
    potionTimes: ['energyPotion1Time'], potionFlags: ['energyPotion2InUse'],
  },
  energyCap: {
    base: (p) => p.capEnergy, kind: 'cap', macguffin: 1, flatPerkLevel: 2, gear: [20, 29, 37],
    perks: perks([8, 59, 76, 118, 128, 137, 222], 0.001), quirks: quirks([1, 36, 42, 62, 81, 178], 0.002),
    wishes: wishes([10, 32, 49, 65, 84, 93, 195], 0.03, 0.01),
    potionTimes: [], potionFlags: [],
  },
  energyBars: {
    base: (p) => p.energyBars, kind: 'bars', macguffin: 6, flatPerkLevel: 21, gear: [8, 18, 28, 35],
    perks: perks([7, 58, 75, 117, 127, 136, 221], 0.001), quirks: quirks([2, 37, 43, 63, 82, 179], 0.002),
    wishes: wishes([11, 33, 50, 66, 83, 92, 194], 0.03, 0.01),
    potionTimes: ['energyBarBar1Time'], potionFlags: [],
  },
  magicPower: {
    base: (p) => p.magic?.magicPower, kind: 'power', macguffin: 2, flatPerkLevel: 1, gear: [3, 17, 27, 34],
    perks: perks([9, 60, 77, 119, 129, 138, 223], 0.002), quirks: quirks([3, 38, 44, 64, 83, 180], 0.005),
    wishes: wishes([12, 34, 51, 67, 85, 94, 196], 0.05, 0.02),
    potionTimes: ['magicPotion1Time'], potionFlags: ['magicPotion2InUse'],
  },
  magicCap: {
    base: (p) => p.magic?.capMagic, kind: 'cap', macguffin: 3, flatPerkLevel: 3, gear: [21, 29, 38],
    perks: perks([11, 62, 79, 121, 131, 140, 225], 0.001), quirks: quirks([4, 39, 45, 65, 84, 181], 0.002),
    wishes: wishes([13, 35, 52, 68, 87, 96, 198], 0.03, 0.01),
    potionTimes: [], potionFlags: [],
  },
  magicBars: {
    base: (p) => p.magic?.magicPerBar, kind: 'bars', macguffin: 7, flatPerkLevel: 21, gear: [9, 19, 28, 36],
    perks: perks([10, 61, 78, 120, 130, 139, 224], 0.001), quirks: quirks([5, 40, 46, 66, 85, 182], 0.002),
    wishes: wishes([14, 36, 53, 69, 86, 95, 197], 0.03, 0.01),
    potionTimes: ['magicBarBar1Time'], potionFlags: [],
  },
};

const FLAT_PERK_INDEX = 94;
const FLAT_PERK_BONUS = 1.1;
const FIRST_WISH_BONUS = 1.05;
const FIRST_WISH_DIFFICULTY = 1;
const POWER_BARS_CAP = 1e18;
const CAP_CAP = 9e18;

function product(levels: (i: number) => number, difficulty: number, bonuses: readonly Bonus[]) {
  let out = 1;
  for (const [i, effect, need] of bonuses) {
    if (difficulty >= need) out = f(out * Math.max(1, f(1 + f(f(levels(i)) * f(effect)))));
  }
  return out;
}

export function resource(p: PlayerData, key: ResourceKey): Resource | null {
  const def = DEFS[key];
  const base = def.base(p);
  if (typeof base !== 'number' || !Number.isFinite(base)) return null;
  const difficulty = num(p.settings?.rebirthDifficulty);
  const perkLevels: unknown[] = p.adventure?.itopod?.perkLevel ?? [];
  const quirkLevels: unknown[] = p.beastQuest?.quirkLevel ?? [];
  const wishList: any[] = p.wishes?.wishes ?? [];

  let perk = product((i) => num(perkLevels[i]), difficulty, def.perks);
  if (num(perkLevels[FLAT_PERK_INDEX]) >= def.flatPerkLevel) perk = f(perk * f(FLAT_PERK_BONUS));
  perk = Math.max(1, perk);
  const quirk = Math.max(1, product((i) => num(quirkLevels[i]), difficulty, def.quirks));
  let wish = product((i) => num(wishList[i]?.level), difficulty, def.wishes);
  if (difficulty >= FIRST_WISH_DIFFICULTY && num(wishList[0]?.level) >= 1) wish = f(wish * f(FIRST_WISH_BONUS));

  const bonuses = gearBonuses(p);
  let gear = 1;
  for (const type of def.gear) gear = f(gear + bonuses[type]);
  const macguffin = num(p.inventory?.macguffinBonuses?.[def.macguffin]);

  const modifier = f(p.inventory?.itemList?.blueHeartComplete ? f(2 * f(1.1)) : 2);
  let potions = 1;
  for (const t of def.potionTimes) if (num(p.arbitrary?.[t]?.totalseconds) > 0) potions *= modifier;
  for (const flag of def.potionFlags) if (p.arbitrary?.[flag]) potions *= modifier;

  const raw = f(f(base * perk) * gear) * macguffin * quirk * wish;
  const factors = { base, perks: perk, gear, macguffin, quirks: quirk, wishes: wish, potions };
  if (def.kind === 'cap') return { total: Math.round(Math.min(CAP_CAP, Math.max(1, raw))), factors };
  if (def.kind === 'bars') return { total: Math.max(1, Math.trunc(f(Math.min(POWER_BARS_CAP, raw) * potions))), factors };
  return { total: f(Math.min(POWER_BARS_CAP, Math.max(1, raw)) * potions), factors };
}

export const energyPower = (p: PlayerData) => resource(p, 'energyPower');

// How many accessory slots are unlocked. The save's accs list only grows when the game next
// refreshes it, so it can lag behind this.
const TROLL_THRESHOLDS = [['curCompletions', 2], ['curEvilCompletions', 1], ['curSadisticCompletions', 7]] as const;
const ACC_PERK = 29;
const ACC_QUIRK = 18;
const ACC_WISH = 109;

export function accessorySpaces(p: PlayerData) {
  const troll = p.challenges?.trollChallenge ?? {};
  const flags = [
    p.purchases?.hasAcc3, p.purchases?.hasAcc5,
    ...['hasAcc4', 'hasAcc5', 'hasAcc6', 'hasAcc7', 'hasAcc8', 'hasAcc9'].map((k) => p.arbitrary?.[k]),
    ...TROLL_THRESHOLDS.map(([k, need]) => num(troll[k]) >= need),
    num(p.adventure?.itopod?.perkLevel?.[ACC_PERK]) >= 1,
    num(p.beastQuest?.quirkLevel?.[ACC_QUIRK]) >= 1,
    num(p.wishes?.wishes?.[ACC_WISH]?.level) > 0,
  ];
  return 2 + flags.filter(Boolean).length;
}

// What-if multipliers. Gear enters these stats as one term with everything else multiplied around
// it, so the ratio between two loadouts is exact without porting all their other factors.
function infinityCubeTier(p: PlayerData) {
  const total = f(num(p.inventory?.cubePower) + num(p.inventory?.cubeToughness));
  if (total < 100) return 0;
  return Math.max(0, Math.min(10, Math.trunc(f(Math.log10(total)) - 1)));
}
function cubeLootBonus(p: PlayerData) {
  const tier = infinityCubeTier(p);
  return tier <= 0 ? 0 : tier === 1 ? 0.5 : f(0.5 + f((tier - 1) * f(0.2)));
}
function softCube(p: PlayerData, cube: unknown, stat: number) {
  if (p.challenges?.noEquipmentChallenge?.inChallenge) return 0;
  const c = num(cube);
  return c > stat ? stat + Math.pow(c - stat, 0.5) : c;
}
const advPowerCore = (p: PlayerData) => {
  const stat = num(p.adventure?.attack) + gearAttack(p);
  return { stat, cube: softCube(p, p.inventory?.cubePower, stat) };
};
const advToughnessCore = (p: PlayerData) => {
  const stat = num(p.adventure?.defense) + gearDefense(p);
  return { stat, cube: softCube(p, p.inventory?.cubeToughness, stat) };
};

export const relativeStats = {
  attack: (p: PlayerData) => 1 + gearAttack(p) / 100,
  defense: (p: PlayerData) => 1 + gearDefense(p) / 100,
  advPower: (p: PlayerData) => {
    const c = advPowerCore(p);
    return c.stat + c.cube;
  },
  advToughness: (p: PlayerData) => {
    const c = advToughnessCore(p);
    return c.stat + c.cube;
  },
  advHP: (p: PlayerData) => num(p.adventure?.maxHP) + gearAttack(p) * 3 + advPowerCore(p).cube * 3,
  advRegen: (p: PlayerData) => num(p.adventure?.regen) + (gearDefense(p) + advToughnessCore(p).cube) * 0.03,
  loot: (p: PlayerData) => {
    const b = gearBonuses(p);
    return 1 + b[5] + b[41] + cubeLootBonus(p);
  },
  nguSpeed: (p: PlayerData) => {
    const b = gearBonuses(p);
    return 1 + b[22] + b[39];
  },
};
export type RelativeKey = keyof typeof relativeStats;
