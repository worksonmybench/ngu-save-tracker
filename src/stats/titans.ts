import { itemName } from '../data/itemNames';
import type { PlayerData } from '../save/decode';
import type { AdventureStats } from './adventure';

// Titan auto-kill thresholds from the game (build 1260). With auto-kill on, a titan dies on its own
// once Power, Toughness and (from titan 4) HP regen all reach these.

// [titan, version (0 = only one), name, Power, Toughness, Regen, boss that unlocks it]
const TITANS: readonly (readonly [number, number, string, number, number, number, number])[] = [
  [1, 0, 'Gordon Ramsay Bolton', 3000, 2500, 0, 58],
  [2, 0, 'Grand Corrupted Tree', 9000, 7000, 0, 66],
  [3, 0, 'Jake From Accounting', 25_000, 15_000, 0, 82],
  [4, 0, 'UUG, The Unmentionable', 800_000, 400_000, 14_000, 100],
  [5, 0, 'Walderp', 13e6, 7e6, 150_000, 116],
  [6, 1, 'The Beast', 2.5e9, 1.6e9, 2.5e7, 132], [6, 2, 'The Beast', 2.5e10, 1.6e10, 2.5e8, 132],
  [6, 3, 'The Beast', 2.5e11, 1.6e11, 2.5e9, 132], [6, 4, 'The Beast', 2.5e12, 1.6e12, 2.5e10, 132],
  [7, 1, 'Greasy Nerd', 5e14, 2.5e14, 5e12, 125], [7, 2, 'Greasy Nerd', 1e16, 5e15, 1e14, 125],
  [7, 3, 'Greasy Nerd', 2e17, 1e17, 2e15, 125], [7, 4, 'Greasy Nerd', 5e18, 2.5e18, 5e16, 125],
  [8, 1, 'The Godmother', 5e18, 2.5e18, 5e16, 166], [8, 2, 'The Godmother', 1e20, 5e19, 1e18, 166],
  [8, 3, 'The Godmother', 2e21, 1e21, 2e19, 166], [8, 4, 'The Godmother', 5e22, 2.5e22, 5e20, 166],
  [9, 1, 'The Exile', 1e23, 5e22, 1e21, 190], [9, 2, 'The Exile', 2e24, 1e24, 2e22, 190],
  [9, 3, 'The Exile', 4e25, 2e25, 4e23, 190], [9, 4, 'The Exile', 7.5e26, 3.7e26, 7.5e24, 190],
  [10, 1, 'IT HUNGERS', 4e28, 2e28, 4e26, 175], [10, 2, 'IT HUNGERS', 3.2e29, 1.6e29, 1.6e27, 175],
  [10, 3, 'IT HUNGERS', 2e30, 1e30, 1e28, 175], [10, 4, 'IT HUNGERS', 1e31, 5e30, 5e28, 175],
  [11, 1, 'Rock Lobster', 1.8e31, 6e30, 1.2e29, 224], [11, 2, 'Rock Lobster', 9e31, 3e31, 6e29, 224],
  [11, 3, 'Rock Lobster', 3.6e32, 1.2e32, 2.5e30, 224], [11, 4, 'Rock Lobster', 1.1e33, 3.6e32, 7.5e30, 224],
  [12, 1, 'Amalgamate', 3e33, 1e33, 2e31, 248], [12, 2, 'Amalgamate', 1.2e34, 4e33, 8e31, 248],
  [12, 3, 'Amalgamate', 3.6e34, 1.2e34, 2.4e32, 248], [12, 4, 'Amalgamate', 7.2e34, 2.4e34, 4.8e32, 248],
];
// Titans 7 and up unlock in Evil, 10 and up in Sadistic; their bosses are counted in that difficulty.
const DIFFICULTY_FROM = [[10, 2], [7, 1]] as const;
// Titans 10 to 12 also auto-kill once a version has been killed more than 4 times.
const BESTIARY_FIRST = 365;
const BESTIARY_KILLS = 4;
const UUG_RING = 135; // titan 4 auto-kills only once this item is maxed
const WALDERP_KILLS = 3;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export type TitanRow = {
  titan: number;
  version: number;
  name: string;
  need: { power: number; toughness: number; regen: number };
  short: { power: number; toughness: number; regen: number }; // ratio still needed, 1 when met
  ready: boolean; // stats alone are enough
  byKills: boolean; // auto-kills from the bestiary rule, whatever the stats
  difficulty: number;
  bossGate: number;
  also: string | null; // a requirement this page can't fully check
};

export function titanRows(p: PlayerData, stats: AdventureStats): TitanRow[] {
  const kills: any[] = p.bestiary?.enemies ?? [];
  return TITANS.map(([titan, version, name, power, toughness, regen, bossGate], i): TitanRow => {
    const short = {
      power: Math.max(1, power / stats.power),
      toughness: Math.max(1, toughness / stats.toughness),
      regen: regen ? Math.max(1, regen / stats.regen) : 1,
    };
    const byKills = titan >= 10 && num(kills[BESTIARY_FIRST + (i - TITANS.findIndex((t) => t[0] === 10))]?.kills) > BESTIARY_KILLS;
    let also: string | null = null;
    if (titan === 4) also = p.inventory?.itemList?.itemMaxxed?.[UUG_RING] === true ? null : `Needs ${itemName(UUG_RING)} maxed`;
    if (titan === 5) also = num(p.adventure?.boss5Kills) >= WALDERP_KILLS ? null : 'Needs 3 kills first';
    return {
      titan,
      version,
      name,
      need: { power, toughness, regen },
      short,
      ready: short.power === 1 && short.toughness === 1 && short.regen === 1,
      byKills,
      difficulty: DIFFICULTY_FROM.find(([from]) => titan >= from)?.[1] ?? 0,
      bossGate,
      also,
    };
  });
}
