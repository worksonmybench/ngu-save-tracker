import { ITEM_SETS } from '../data/itemSets';
import type { PlayerData } from '../save/decode';

// Challenge and set progress read straight from a save (build 1260).

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export const DIFFICULTY_NAMES = ['Normal', 'Evil', 'Sadistic'] as const;
const COMPLETION_FIELDS = ['curCompletions', 'curEvilCompletions', 'curSadisticCompletions'] as const;

// Completions that give rewards, the same at every difficulty, and what the next clear needs.
// Bosses are as the game numbers them on screen, one more than its internal target.
type ChallengeDef = { key: string; name: string; max: number; goal: (clears: number) => string };
const boss = (n: number) => `Beat boss ${n}`;
export const CHALLENGES: readonly ChallengeDef[] = [
  { key: 'basicChallenge', name: 'Basic', max: 5, goal: () => boss(58) },
  { key: 'noAugsChallenge', name: 'No Augs', max: 5, goal: () => boss(59) },
  { key: 'hour24Challenge', name: '24 Hour', max: 10, goal: (c) => `${boss(Math.min(300, 58 + 26 * c))} within 24 hours` },
  { key: 'levelChallenge10k', name: '100 Levels', max: 5, goal: () => boss(58) },
  { key: 'noEquipmentChallenge', name: 'No Equipment', max: 5, goal: () => boss(66) },
  { key: 'trollChallenge', name: 'Troll', max: 7, goal: (c) => boss(69 + 15 * c) },
  { key: 'noRebirthChallenge', name: 'No Rebirth', max: 10, goal: (c) => boss(40 + 5 * c) },
  { key: 'laserSwordChallenge', name: 'Laser Sword', max: 20, goal: (c) => `Make a ${c + 2}/${c + 2} Laser Sword` },
  { key: 'blindChallenge', name: 'Blind', max: 10, goal: (c) => boss(58 + 10 * c) },
  { key: 'nguChallenge', name: 'No NGU', max: 10, goal: (c) => boss(58 + 10 * c) },
  { key: 'timeMachineChallenge', name: 'No Time Machine', max: 10, goal: (c) => boss(58 + 15 * c) },
];

export type ChallengeRow = { name: string; clears: number[]; max: number; next: string | null };

// The highest difficulty this save has reached, from its current difficulty or any clears there.
export function difficultyReached(p: PlayerData) {
  let reached = num(p.settings?.rebirthDifficulty);
  for (const def of CHALLENGES) {
    COMPLETION_FIELDS.forEach((field, d) => {
      if (num(p.challenges?.[def.key]?.[field]) > 0) reached = Math.max(reached, d);
    });
  }
  return Math.min(2, reached);
}

// The save's per-challenge "unlocked" flag is false even for challenges with clears, so it isn't used.
export const currentDifficulty = (p: PlayerData) => Math.min(2, num(p.settings?.rebirthDifficulty));

export function challengeRows(p: PlayerData): ChallengeRow[] {
  const reached = difficultyReached(p);
  const difficulty = currentDifficulty(p);
  return CHALLENGES.filter((def) => p.challenges?.[def.key]).map((def) => {
    const c = p.challenges[def.key];
    const clears = COMPLETION_FIELDS.slice(0, reached + 1).map((field) => num(c[field]));
    const now = clears[difficulty];
    return { name: def.name, clears, max: def.max, next: now < def.max ? def.goal(now) : null };
  });
}

export type ItemState = { id: number; state: 'maxed' | 'found' | 'missing'; level: number | null };
export type SetRow = { flag: string; name: string; complete: boolean; items: ItemState[] };

// Highest level of each item id held anywhere: worn, inventory or daycare.
function ownedLevels(p: PlayerData) {
  const inv = p.inventory ?? {};
  const all = [
    ...['head', 'chest', 'legs', 'boots', 'weapon', 'weapon2'].map((k) => inv[k]),
    ...list(inv.accs),
    ...list(inv.inventory),
    ...list(inv.daycare),
  ];
  const out = new Map<number, number>();
  for (const item of all) {
    const id = num(item?.id);
    if (id) out.set(id, Math.max(out.get(id) ?? 0, num(item.level)));
  }
  return out;
}

export function setRows(p: PlayerData): SetRow[] {
  const items = p.inventory?.itemList ?? {};
  const dropped = list(items.itemDropped);
  const maxed = list(items.itemMaxxed);
  const owned = ownedLevels(p);
  return ITEM_SETS.map(([flag, name, ids]) => ({
    flag,
    name,
    complete: items[flag] === true,
    items: ids.map((id): ItemState => ({
      id,
      state: maxed[id] === true ? 'maxed' : dropped[id] === true ? 'found' : 'missing',
      level: owned.get(id) ?? null,
    })),
  }));
}

// Sets worth listing: started but not complete. Untouched sets are later content.
export const setsInProgress = (rows: SetRow[]) =>
  rows.filter((s) => !s.complete && s.items.some((i) => i.state !== 'missing'));
