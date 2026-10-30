import { energyPower, type ResourceFactors } from '../stats/formulas';
import type { PlayerData } from './decode';

// Bump when extraction changes: stored saves are re-derived from their raw text on load.
export const METRICS_VERSION = 2;

export type Metrics = {
  metricsVersion: number;
  build: number | null;
  savedAt: number; // epoch ms
  timeSource: 'lastTime' | 'file';
  playHours: number | null;
  lifetimeExp: number | null;
  gearPower: number | null;
  gearToughness: number | null;
  loadout: string; // sorted worn item ids, so stat jumps can be labelled as gear swaps
  energyPower: number | null;
  totalEnergyPower: number | null; // depends on gear worn when the save was made
  energyFactors: ResourceFactors | null;
  energyCap: number | null;
  energyBars: number | null;
  magicPower: number | null;
  nguLevels: number | null;
  setsComplete: number | null;
  challengesDone: number | null;
  fruitTiers: number | null;
  ap: number | null;
  itopodFloor: number | null;
  highestBoss: number | null;
  runBoss: number | null;
  rebirthMultiLog10: number | null;
  rebirthSeconds: number | null;
  inChallenge: string;
  difficulty: number | null;
  seedsOnHand: number | null;
  seedsEarned: number | null;
};

// Seed cost multiplier per fruit, for the first ten fruits (tier T costs T^2 x this).
const FRUIT_SEED_COST = [1, 10, 25, 40, 60, 100, 150, 170, 200, 2000];
const WORN_SLOTS = ['head', 'chest', 'legs', 'boots', 'weapon'];

// NaN shows up in real saves (loot factor at run start); it must never reach a chart.
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const sum = (values: unknown[]) => {
  let total = 0;
  let any = false;
  for (const v of values) {
    const n = finite(v);
    if (n !== null) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
};

// lastTime is Unix seconds inside the save, and survives copying where file dates don't.
function savedAt(p: PlayerData, fileModified: number) {
  const s = finite(p.lastTime);
  const earliest = Date.UTC(2015, 0, 1) / 1000;
  return s !== null && s > earliest
    ? { savedAt: s * 1000, timeSource: 'lastTime' as const }
    : { savedAt: fileModified, timeSource: 'file' as const };
}

export function extractMetrics(p: PlayerData, fileModified: number): Metrics {
  const inv = p.inventory ?? {};
  const worn = [...WORN_SLOTS.map((k) => inv[k]), ...list(inv.accs)].filter((e) => e && e.id);
  const items = inv.itemList ?? {};
  const challenges = Object.entries((p.challenges ?? {}) as Record<string, any>).filter(
    ([, c]) => c && typeof c === 'object',
  );
  const fruits = list(p.yggdrasil?.fruits);
  const seedsOnHand = finite(p.yggdrasil?.seeds);
  let spent = 0;
  FRUIT_SEED_COST.forEach((cost, i) => {
    const maxTier = finite(fruits[i]?.maxTier) ?? 0;
    for (let t = 1; t <= maxTier; t++) spent += t * t * cost;
  });
  const multi = finite(p.attackMulti);
  const playSeconds = finite(p.totalPlaytime?.totalseconds);
  const boss = finite(p.bossID);
  const power = energyPower(p);
  return {
    metricsVersion: METRICS_VERSION,
    build: finite(p.version),
    ...savedAt(p, fileModified),
    playHours: playSeconds === null ? null : playSeconds / 3600,
    lifetimeExp: finite(p.stats?.totalExp),
    gearPower: sum(worn.map((e) => e.curAttack)),
    gearToughness: sum(worn.map((e) => e.curDefense)),
    loadout: worn.map((e) => e.id).sort((a, b) => a - b).join(','),
    energyPower: finite(p.energyPower),
    totalEnergyPower: power?.total ?? null,
    energyFactors: power?.factors ?? null,
    energyCap: finite(p.capEnergy),
    energyBars: finite(p.energyBars),
    magicPower: finite(p.magic?.magicPower),
    nguLevels: sum([...list(p.NGU?.skills), ...list(p.NGU?.magicSkills)].map((s) => s?.level)),
    setsComplete: Object.entries(items).filter(([k, v]) => k.endsWith('Complete') && v === true).length,
    challengesDone: sum(challenges.map(([, c]) => c.curCompletions)),
    fruitTiers: sum(fruits.map((f) => f?.maxTier)),
    ap: finite(p.arbitrary?.curArbitraryPoints),
    itopodFloor: finite(p.adventure?.highestItopodLevel),
    highestBoss: finite(p.highestBoss),
    runBoss: boss === null ? null : Math.max(0, boss - 1), // bossID reads 0 right after a rebirth
    rebirthMultiLog10: multi !== null && multi > 0 ? Math.log10(multi) : null,
    rebirthSeconds: finite(p.rebirthTime?.totalseconds),
    inChallenge: challenges.find(([, c]) => c.inChallenge)?.[0].replace('Challenge', '') ?? '',
    difficulty: finite(p.settings?.rebirthDifficulty),
    seedsOnHand,
    seedsEarned: seedsOnHand === null ? null : seedsOnHand + spent,
  };
}
