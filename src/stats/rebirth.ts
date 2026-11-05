import type { PlayerData } from '../save/decode';

// What a rebirth banks, by rebirth length: permanent beard levels and MacGuffin bonuses.
// Rules from the game (build 1260), checked against its own methods.

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

const HOUR = 3600;

// Beards: temporary levels turn into permanent ones at rebirth, scaled by a time factor that
// grows by 1/3 an hour to 8. The Five O'Clock Shadow perk takes an hour off per level.
const BEARD_MIN_SECONDS = HOUR;
const BEARD_FACTOR_SECONDS = 3 * HOUR;
const BEARD_FULL_HOURS = 24;
const BEARD_MAX_FACTOR = 8;
const BEARD_TIME_PERK = 21;
export const BEARD_EFFECTS = ['Attack/Defense', 'Drop Chance', 'Number', 'NGU Speed', 'Wandoos', 'Adventure', 'Gold'];

export function beardTimeFactor(seconds: number, perkLevel: number) {
  if (seconds < BEARD_MIN_SECONDS) return 0;
  return Math.min(BEARD_MAX_FACTOR, ((seconds / BEARD_FACTOR_SECONDS) * BEARD_FULL_HOURS) / (BEARD_FULL_HOURS - perkLevel));
}

export const beardGain = (tempLevel: number, factor: number) => Math.min(tempLevel, Math.floor(Math.sqrt(tempLevel) * factor));

// When the beard factor stops growing.
export const beardFullSeconds = (perkLevel: number) => (BEARD_MAX_FACTOR * BEARD_FACTOR_SECONDS * (BEARD_FULL_HOURS - perkLevel)) / BEARD_FULL_HOURS;

// MacGuffins: each equipped one adds to its permanent bonus at rebirth, scaled by a time factor.
const GUFF_MIN_SECONDS = 180;
const GUFF_BEST_SECONDS = 1800;
const GUFF_MAX_FACTOR = 20;
const SAD_DAY = 86_400;
const SAD_LONG_FACTOR = 48;
const SAD_LONG_POWER = 0.4;
const SAD_MAX_FACTOR = 104.86;
const SAD_TROLL_CLEARS = 2;
const SOFTCAP_LEVEL = 100;

// Sadistic rebirths with two Sadistic Troll clears keep gaining past 30 minutes.
export function macguffinTimeFactor(seconds: number, sadistic: boolean) {
  if (seconds < GUFF_MIN_SECONDS) return 0;
  const half = seconds / GUFF_BEST_SECONDS;
  if (seconds <= GUFF_BEST_SECONDS) return f(Math.pow(f(half), 2));
  if (!sadistic) return Math.min(GUFF_MAX_FACTOR, f(Math.pow(f(half), 0.5)));
  const factor = seconds <= SAD_DAY ? f(half) : f(SAD_LONG_FACTOR * f(Math.pow(f(seconds / SAD_DAY), SAD_LONG_POWER)));
  return Math.min(SAD_MAX_FACTOR, factor);
}

// [item id, macguffinBonuses index, gain per level, softcap power above level 100 (0 = none)].
// Above the softcap the level counts as 100^(1 - power) x level^power, continuous at 100.
const MACGUFFINS: readonly (readonly [number, number, number, number])[] = [
  [198, 0, 1e-5, 0.3], [199, 1, 1e-5, 0.2], [200, 2, 1e-5, 0.3], [201, 3, 1e-5, 0.2], [202, 4, 1e-5, 0.2],
  [203, 5, 1e-5, 0.2], [204, 6, 1e-5, 0.2], [205, 7, 1e-5, 0.2], [206, 8, 1e-5, 0.2], [207, 9, 1e-5, 0.2],
  [208, 10, 1e-5, 0.2], [209, 11, 5e-5, 0], [210, 12, 1e-5, 0], [228, 13, 1e-4, 0], [211, 15, 2e-5, 0.25],
  [250, 16, 2e-5, 0.25], [289, 17, 5e-5, 0.25], [290, 18, 3e-5, 0.2], [291, 19, 1e-5, 0.2], [298, 20, 5e-6, 0.3],
  [299, 21, 5e-6, 0.2], [300, 22, 5e-6, 0.2],
];
// The game's rounded coefficients for each softcap power.
const SOFTCAP_SCALE: Record<number, number> = { 0.3: 25.12, 0.2: 39.81, 0.25: 31.63 };

export function macguffinGain(itemId: number, level: number, factor: number) {
  const def = MACGUFFINS.find((m) => m[0] === itemId);
  if (!def) return 0;
  const [, , perLevel, power] = def;
  const l = level + 1;
  const effective = power && l > SOFTCAP_LEVEL ? f(SOFTCAP_SCALE[power] * f(Math.pow(l, power))) : l;
  return f(f(perLevel * effective) * factor);
}

export type RebirthState = {
  seconds: number;
  beardPerk: number;
  sadistic: boolean;
  boost: number; // MacGuffin Booster potion multiplier, 1 when not active
  beards: { index: number; effect: string; temp: number; perm: number }[]; // active beards
  guffs: { itemId: number; level: number; bonus: number }[]; // equipped, with their current total bonus
};

export function readRebirth(p: PlayerData): RebirthState {
  const arb = p.arbitrary ?? {};
  const booster = num(arb.macGuffinBooster1Time?.totalseconds) > 0 && !!arb.macGuffinBooster1InUse;
  const modifier = f(p.inventory?.itemList?.blueHeartComplete ? f(2 * f(1.1)) : 2);
  const bonuses = list(p.inventory?.macguffinBonuses);
  return {
    seconds: num(p.rebirthTime?.totalseconds),
    beardPerk: num(p.adventure?.itopod?.perkLevel?.[BEARD_TIME_PERK]),
    sadistic: num(p.settings?.rebirthDifficulty) >= 2 && num(p.challenges?.trollChallenge?.curSadisticCompletions) >= SAD_TROLL_CLEARS,
    boost: booster ? modifier : 1,
    beards: list(p.beards?.beards)
      .map((b, index) => ({ index, effect: BEARD_EFFECTS[index] ?? `Beard ${index + 1}`, temp: num(b?.beardLevel), perm: num(b?.permLevel), active: !!b?.active }))
      .filter((b) => b.active)
      .map(({ active: _, ...b }) => b),
    guffs: list(p.inventory?.macguffins)
      .filter((g) => MACGUFFINS.some((m) => m[0] === g?.id))
      .map((g) => ({ itemId: g.id, level: num(g.level), bonus: num(bonuses[MACGUFFINS.find((m) => m[0] === g.id)![1]]) })),
  };
}

export type Gains = {
  seconds: number;
  beardLevels: number; // permanent levels across active beards
  guffFactor: number; // MacGuffin time factor, booster included
};

// What a rebirth of `seconds` banks. Temporary beard levels are assumed to keep growing at the
// average rate of the current rebirth, so they scale with its length.
export function gainsAt(s: RebirthState, seconds: number): Gains {
  const factor = beardTimeFactor(seconds, s.beardPerk);
  const scale = s.seconds > 0 ? seconds / s.seconds : 0;
  return {
    seconds,
    beardLevels: s.beards.reduce((sum, b) => sum + beardGain(Math.floor(b.temp * scale), factor), 0),
    guffFactor: macguffinTimeFactor(seconds, s.sadistic) * s.boost,
  };
}

const perDay = (amount: number, seconds: number) => (seconds > 0 ? (amount * SAD_DAY) / seconds : 0);

export type LengthRow = Gains & { beardsPerDay: number; guffsPerDay: number; beardShare: number; guffShare: number };

export const LENGTHS_HOURS = [0.5, 1, 2, 4, 8, 12, 24, 48, 72];

// Gains per day from back-to-back rebirths of each length, and each as a share of the best.
export function compareLengths(s: RebirthState, hours: readonly number[] = LENGTHS_HOURS): LengthRow[] {
  const rows = hours.map((h) => {
    const g = gainsAt(s, h * HOUR);
    return { ...g, beardsPerDay: perDay(g.beardLevels, g.seconds), guffsPerDay: perDay(g.guffFactor, g.seconds) };
  });
  const bestBeards = Math.max(...rows.map((r) => r.beardsPerDay));
  const bestGuffs = Math.max(...rows.map((r) => r.guffsPerDay));
  return rows.map((r) => ({ ...r, beardShare: bestBeards > 0 ? r.beardsPerDay / bestBeards : 0, guffShare: bestGuffs > 0 ? r.guffsPerDay / bestGuffs : 0 }));
}
