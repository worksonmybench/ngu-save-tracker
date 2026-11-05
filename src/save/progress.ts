import type { NguLevels } from './metrics';
import type { Row } from './derive';

// Rates, time-to-target estimates and milestones, all measured from the saves themselves,
// so none of them depend on porting a feature's speed formula.

const DAY_MS = 86_400_000;
const MIN_SPAN_MS = 12 * 3_600_000; // shorter gaps give rates that swing too much
const LEVELS_PER_SECOND_CAP = 50; // one level per tick

export type Milestone = { time: number; rowId: string; label: string };

// "tutorialCube" -> "tutorial cube", but acronyms like "HSB" stay as they are.
const words = (key: string) =>
  key.replace(/^twoD$/, '2D').replace(/([a-z])([A-Z0-9])/g, '$1 $2').split(' ').map((w) => (w === w.toUpperCase() ? w : w.toLowerCase())).join(' ');
// Save keys with "Challenge..." stripped, as named on the game's Challenges screen.
const CHALLENGE_NAMES: Record<string, string> = {
  basic: 'Basic', noAugs: 'No Augs', hour24: '24 Hour', level: '100 Levels', noEquipment: 'No Equipment',
  noRebirth: 'No Rebirth', troll: 'Troll', laserSword: 'Laser Sword', blind: 'Blind', ngu: 'No NGU', timeMachine: 'No Time Machine',
};
const challengeName = (key: string) => {
  const [difficulty, name] = key.includes(':') ? key.split(':') : ['', key];
  const title = CHALLENGE_NAMES[name] ?? words(name);
  return difficulty ? `${difficulty.charAt(0).toUpperCase()}${difficulty.slice(1)} ${title}` : title;
};
const DIFFICULTY_NAMES = ['Normal', 'Evil', 'Sadistic'];

// What each save reached for the first time. The first save is the baseline. Progress is compared
// with the best seen so far, so an older backup save can't make a milestone happen twice. A
// milestone happened somewhere between a save and the one before it, not at the save's own time.
export function milestones(rows: Row[]): Milestone[] {
  const out: Milestone[] = [];
  const first = rows[0];
  if (!first) return out;
  const sets = new Set(first.setsDone ?? []);
  const clears: Record<string, number> = { ...(first.challengeClears ?? {}) };
  let maxDifficulty = first.difficulty ?? 0;
  for (const row of rows.slice(1)) {
    const add = (label: string) => out.push({ time: row.savedAt, rowId: row.id, label });
    for (const set of row.setsDone ?? []) {
      if (sets.has(set)) continue;
      sets.add(set);
      add(`Maxed the ${words(set)} set`);
    }
    for (const [key, n] of Object.entries(row.challengeClears ?? {})) {
      if (n <= (clears[key] ?? 0)) continue;
      clears[key] = n;
      add(`${challengeName(key)} challenge, clear ${n}`);
    }
    if (row.difficulty !== null && row.difficulty > maxDifficulty) {
      maxDifficulty = row.difficulty;
      add(`Reached ${DIFFICULTY_NAMES[row.difficulty] ?? `difficulty ${row.difficulty}`} difficulty`);
    }
  }
  return out;
}

export const milestonesByRow = (list: Milestone[]) => {
  const out = new Map<string, string[]>();
  for (const m of list) out.set(m.rowId, [...(out.get(m.rowId) ?? []), m.label]);
  return out;
};

type Span = { from: Row; to: Row; days: number };

// The latest save and the earliest one within `days` of it, if they're far enough apart.
export function span(rows: Row[], days: number, has: (r: Row) => boolean = () => true): Span | null {
  const usable = rows.filter(has);
  const to = usable[usable.length - 1];
  if (!to) return null;
  const from = usable.find((r) => r.savedAt >= to.savedAt - days * DAY_MS);
  if (!from || to.savedAt - from.savedAt < MIN_SPAN_MS) return null;
  return { from, to, days: (to.savedAt - from.savedAt) / DAY_MS };
}

export function perDay(rows: Row[], value: (r: Row) => number | null, days: number) {
  const s = span(rows, days, (r) => value(r) !== null);
  return s && (value(s.to)! - value(s.from)!) / s.days;
}

export const NGU_NAMES: readonly [readonly string[], readonly string[]] = [
  ['Augments', 'Wandoos', 'Respawn', 'Gold', 'Adventure α', 'Power α', 'Drop Chance', 'Magic NGU', 'PP'],
  ['Yggdrasil', 'Exp', 'Power β', 'Number', 'Time Machine', 'Energy NGU', 'Adventure β'],
];
export const NGU_HARDCAP = 1e9;
const TARGET_STEPS = [1e3, 1e4, 1e5, 1e6, 1e7, 1e8, NGU_HARDCAP];
export const defaultTarget = (level: number) => TARGET_STEPS.find((t) => t > level) ?? NGU_HARDCAP;

// Level N to N+1 costs N+1 units, so reaching level L from 0 costs L(L+1)/2.
const cost = (level: number) => (level * (level + 1)) / 2;

export type NguRate = {
  resource: 0 | 1; // energy, magic
  index: number;
  name: string;
  level: number;
  perDay: number | null;
  fullSpeed: boolean;
  unitsPerSecond: number | null; // cost units gained per second over the window
};

export function nguRates(rows: Row[], difficulty: keyof NguLevels, days: number): NguRate[] {
  const range = span(rows, days, (r) => !!r.nguLevelsByDifficulty);
  const latest = rows[rows.length - 1]?.nguLevelsByDifficulty;
  if (!latest) return [];
  const out: NguRate[] = [];
  ([0, 1] as const).forEach((resource) => {
    NGU_NAMES[resource].forEach((name, index) => {
      const level = latest[difficulty][resource][index] ?? 0;
      let rate: number | null = null;
      let units: number | null = null;
      let fullSpeed = false;
      if (range) {
        const before = range.from.nguLevelsByDifficulty[difficulty][resource][index] ?? 0;
        const after = range.to.nguLevelsByDifficulty[difficulty][resource][index] ?? 0;
        const seconds = range.days * 86_400;
        rate = (after - before) / range.days;
        units = (cost(after) - cost(before)) / seconds;
        // Within 2% of one level per tick across the whole window.
        fullSpeed = after - before >= LEVELS_PER_SECOND_CAP * seconds * 0.98;
      }
      out.push({ resource, index, name, level, perDay: rate, fullSpeed, unitsPerSecond: units });
    });
  });
  return out;
}

// Seconds to reach `target` if the NGU keeps getting the same energy or magic as in the window.
// Never faster than one level per tick.
export function secondsToTarget(rate: NguRate, target: number): number | null {
  if (target <= rate.level) return 0;
  const atCap = (target - rate.level) / LEVELS_PER_SECOND_CAP;
  if (rate.fullSpeed) return atCap;
  if (!rate.unitsPerSecond || rate.unitsPerSecond <= 0) return null;
  return Math.max(atCap, (cost(target) - cost(rate.level)) / rate.unitsPerSecond);
}
