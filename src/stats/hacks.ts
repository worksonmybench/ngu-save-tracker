import type { PlayerData } from '../save/decode';

// Hack rules from the game (build 1260), checked against its own methods. A hackday puts all of
// resource 3 on one hack at a time; this works out how long each target takes that way.

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// [name, base divider, effect per level, milestone effect, levels per milestone, hard cap level,
//  milestone reducer: p = ITOPOD perk, q = quirk, w = wish, then its index]
const HACKS: readonly (readonly [string, number, number, number, number, number, 'p' | 'q' | 'w', number])[] = [
  ['Attack/Defense', 1e8, 0.025, 1.025, 10, 7720, 'q', 57],
  ['Adventure Stats', 2e8, 0.001, 1.02, 50, 7632, 'p', 113],
  ['Time Machine Speed', 4e8, 0.002, 1.02, 50, 7544, 'q', 175],
  ['Drop Chance', 4e8, 0.0025, 1.03, 40, 7544, 'p', 217],
  ['Augment Speed', 8e8, 0.002, 1.01, 20, 7456, 'p', 218],
  ['Energy NGU Speed', 2e9, 0.001, 1.015, 30, 7340, 'q', 174],
  ['Magic NGU Speed', 2e9, 0.001, 1.015, 30, 7340, 'p', 219],
  ['Blood Gain', 4e9, 0.001, 1.04, 50, 7252, 'p', 114],
  ['QP Gain', 8e9, 0.0005, 1.008, 50, 7164, 'w', 76],
  ['Daycare Speed', 2e10, 0.0002, 1.005, 45, 7048, 'p', 115],
  ['EXP', 4e10, 0.00025, 1.01, 75, 6960, 'q', 59],
  ['Number', 8e10, 0.05, 1.04, 40, 6873, 'w', 77],
  ['PP Gain', 2e11, 0.0005, 1.005, 25, 6757, 'q', 58],
  ['Hack Speed', 2e11, 0.0005, 1.1, 100, 6757, 'w', 78],
  ['Wish Speed', 1e13, 0.0001, 1.005, 50, 6262, 'q', 60],
];
export const HACK_HACK = 13;
const LEVEL_GROWTH = 1.0078;
const TICKS_PER_SECOND = 50;

export type HackState = { index: number; name: string; level: number; progress: number; threshold: number; hardCap: number };

function reducer(p: PlayerData, kind: 'p' | 'q' | 'w', index: number) {
  if (kind === 'p') return num(p.adventure?.itopod?.perkLevel?.[index]);
  if (kind === 'q') return num(p.beastQuest?.quirkLevel?.[index]);
  return num(p.wishes?.wishes?.[index]?.level);
}

export function readHacks(p: PlayerData): HackState[] {
  const saved = list(p.hacks?.hacks);
  return HACKS.map(([name, , , , every, hardCap, kind, index], i) => ({
    index: i,
    name,
    level: num(saved[i]?.level),
    progress: num(saved[i]?.progress),
    threshold: Math.max(1, every - reducer(p, kind, index)),
    hardCap,
  }));
}

const levelDivider = (level: number) => f(Math.pow(LEVEL_GROWTH, level) * (level + 1));

// Progress per tick towards the next level, where 1 is a whole level.
export const progressPerTick = (index: number, level: number, r3: number, power: number, speed: number) =>
  f(f(f(f(r3) * power) * speed) / f(HACKS[index][1] * levelDivider(level)));

export const milestones = (h: HackState, level: number) => Math.floor(level / h.threshold);
export const hackBonus = (h: HackState, level: number) => {
  const [, , perLevel, milestoneEffect] = HACKS[h.index];
  return f(f(1 + f(level * perLevel)) * f(Math.pow(milestoneEffect, milestones(h, level))));
};

// The next milestone after `level`, or the hard cap.
export const nextMilestone = (h: HackState, level: number) => Math.min(h.hardCap, (milestones(h, level) + 1) * h.threshold);

export type Resources = { r3: number; power: number; speed: number }; // speed as a multiplier, 1 = 100%

// Seconds to reach `target` with all of resource 3 on this hack, from its saved level and progress.
// A hack gains at most one level a tick.
export function secondsTo(h: HackState, target: number, res: Resources): number | null {
  let seconds = 0;
  for (let level = h.level; level < Math.min(target, h.hardCap); level++) {
    const perTick = progressPerTick(h.index, level, res.r3, res.power, res.speed);
    if (perTick <= 0) return null;
    const needed = level === h.level ? Math.max(0, 1 - h.progress) : 1;
    seconds += Math.max(1, needed / perTick) / TICKS_PER_SECOND;
  }
  return seconds;
}

export const hacksUnlocked = (p: PlayerData) => list(p.hacks?.hacks).length > 0 && num(p.res3?.capRes3) > 0;

export const savedResources = (p: PlayerData): Resources => ({ r3: num(p.res3?.capRes3), power: num(p.res3?.res3Power), speed: 1 });

export type PlanRow = HackState & { target: number; seconds: number | null; bonusNow: number; bonusAfter: number };
export type Plan = { rows: PlanRow[]; total: number | null; speedup: number };

// Hack Hack goes first: its bonus is part of total hack speed, so reaching its target speeds up the
// rest by the ratio of its new bonus to its current one.
export function planHackday(hacks: HackState[], targets: Record<number, number>, res: Resources): Plan {
  const target = (h: HackState) => Math.max(h.level, Math.min(h.hardCap, targets[h.index] ?? h.level));
  const hackHack = hacks.find((h) => h.index === HACK_HACK);
  const speedup = hackHack ? hackBonus(hackHack, target(hackHack)) / hackBonus(hackHack, hackHack.level) : 1;
  const rows = hacks.map((h) => {
    const t = target(h);
    const speed = h.index === HACK_HACK ? res.speed : res.speed * speedup;
    return { ...h, target: t, seconds: secondsTo(h, t, { ...res, speed }), bonusNow: hackBonus(h, h.level), bonusAfter: hackBonus(h, t) };
  });
  const total = rows.some((r) => r.seconds === null) ? null : rows.reduce((s, r) => s + (r.seconds ?? 0), 0);
  return { rows, total, speedup };
}
