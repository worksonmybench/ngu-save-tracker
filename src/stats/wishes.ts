import { WISHES } from '../data/wishes';
import type { PlayerData } from '../save/decode';

// Wish rules from the game (build 1260), checked against its own methods. A wish levels from all
// three resources, each counting as (total power x amount)^0.17, and never faster than a minimum
// time per level.

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

const RESOURCE_POWER = 0.17;
const MIN_PROGRESS = 1e-8; // anything slower doesn't move at all
// Progress is single precision, so past halfway a step under half its spacing (2^-24) rounds away:
// slower than this, a level never finishes. That's about 7 3/4 days a level.
const MIN_COMPLETING_PROGRESS = 2 ** -25;
const TICKS_PER_SECOND = 50;
const BASE_MIN_SECONDS = 14_400;
const MIN_SECONDS_PER_LEVEL = 24;
const MIN_TIME_PERKS = [109, 110];
const MIN_TIME_QUIRK = 54;
const SLOT_QUIRK = 56;
const SLOT_TROLL_CLEARS = 7;
const MAX_SLOTS = 4;

export const minimumWishSeconds = (p: PlayerData) =>
  BASE_MIN_SECONDS -
  MIN_SECONDS_PER_LEVEL *
    (MIN_TIME_PERKS.reduce((s, i) => s + num(p.adventure?.itopod?.perkLevel?.[i]), 0) + num(p.beastQuest?.quirkLevel?.[MIN_TIME_QUIRK]));

export function wishSlots(p: PlayerData) {
  const slots =
    1 +
    (num(p.challenges?.trollChallenge?.curEvilCompletions) >= SLOT_TROLL_CLEARS ? 1 : 0) +
    (p.inventory?.itemList?.pinkHeartComplete ? 1 : 0) +
    (num(p.beastQuest?.quirkLevel?.[SLOT_QUIRK]) >= 1 ? 1 : 0);
  return Math.min(MAX_SLOTS, slots);
}

// [total power, amount given to the wish] for energy, magic and resource 3.
export type Inputs = { energy: [number, number]; magic: [number, number]; res3: [number, number]; speed: number };

const factor = ([power, amount]: [number, number]) => f(Math.pow(f(power * f(amount)), RESOURCE_POWER));

// Progress per tick towards the next level, before the minimum time cap; 1 is a whole level.
export function rawProgressPerTick(id: number, level: number, inputs: Inputs) {
  const divider = f(f(WISHES[id][3]) * (level + 1));
  return f(f(f(f(factor(inputs.energy) * factor(inputs.magic)) * factor(inputs.res3)) * inputs.speed) / divider);
}

export function progressPerTick(id: number, level: number, inputs: Inputs, minSeconds: number) {
  const raw = rawProgressPerTick(id, level, inputs);
  if (raw < MIN_PROGRESS) return 0;
  return Math.min(raw, 1 / (minSeconds * TICKS_PER_SECOND));
}

export type WishRow = {
  id: number;
  name: string;
  difficulty: number;
  level: number;
  maxLevel: number;
  running: boolean; // has resources on it in the save
  nextSeconds: number | null;
  maxSeconds: number | null;
  stallLevel: number | null; // the level these resources can't finish, if they can't reach max
  atMinimum: boolean; // the next level is capped by the minimum time
  shareNeeded: number; // fraction of the given resources that would still reach the minimum time
};

// Every wish not yet maxed at a difficulty reached, timed with `inputs` on it alone.
export function wishRows(p: PlayerData, inputs: Inputs, difficulty: number): WishRow[] {
  const saved = list(p.wishes?.wishes);
  const minSeconds = minimumWishSeconds(p);
  const cap = 1 / (minSeconds * TICKS_PER_SECOND);
  const out: WishRow[] = [];
  WISHES.forEach(([name, wishDifficulty, maxLevel], id) => {
    const w = saved[id] ?? {};
    const level = num(w.level);
    if (wishDifficulty > difficulty || level >= maxLevel) return;
    let total: number | null = 0;
    let next: number | null = null;
    let stall: number | null = null;
    for (let l = level; l < maxLevel; l++) {
      const perTick = progressPerTick(id, l, inputs, minSeconds);
      const seconds = perTick >= MIN_COMPLETING_PROGRESS ? (l === level ? Math.max(0, 1 - num(w.progress)) : 1) / perTick / TICKS_PER_SECOND : null;
      if (l === level) next = seconds;
      if (seconds === null) {
        total = null;
        stall = l;
        break;
      }
      total += seconds;
    }
    const raw = rawProgressPerTick(id, level, inputs);
    out.push({
      id,
      name,
      difficulty: wishDifficulty,
      level,
      maxLevel,
      running: num(w.energy) + num(w.magic) + num(w.res3) > 0,
      nextSeconds: next,
      maxSeconds: total,
      stallLevel: stall,
      atMinimum: raw >= cap,
      // Scaling all three resources by k scales speed by k^0.51.
      shareNeeded: raw >= cap ? Math.pow(cap / raw, 1 / (3 * RESOURCE_POWER)) : 1,
    });
  });
  return out;
}
