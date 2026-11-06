import type { PlayerData } from '../save/decode';
import { gearAttack, gearDefense } from './formulas';

// Adventure Power, Toughness and HP regen, as the game totals them (build 1260), checked against
// its own methods. Each is base + gear + infinity cube, times the same long chain of multipliers.

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const STAT_CAP = 1e36;
const MIN_REGEN = Math.fround(0.1);
const MAX_TOTAL = f(1e36);

// The cube adds in full up to the stat it backs, then only its square root above that.
function cube(p: PlayerData, field: 'cubePower' | 'cubeToughness', stat: number) {
  if (p.challenges?.noEquipmentChallenge?.inChallenge) return 0;
  const c = num(p.inventory?.[field]);
  return c > stat ? f(stat + f(Math.pow(c - stat, 0.5))) : c;
}

// Advanced Training: level^0.4 / 10. Index 1 is Power, 0 Toughness.
function training(p: PlayerData, index: number) {
  const level = num(p.advancedTraining?.level?.[index]);
  return level > 0 ? f(f(Math.pow(level, 0.4)) * 0.1) : 0;
}

// The Adventure NGUs: linear to level 1000, then a power curve continuous at 1000.
type Curve = { key: 'level' | 'evilLevel' | 'sadisticLevel'; per: number; power: number; scale: number; difficulty: number };
const ADV_ALPHA: Curve[] = [
  { key: 'level', per: 0.001, power: 0.5, scale: 31.7, difficulty: 0 },
  { key: 'evilLevel', per: 0.0005, power: 0.25, scale: 177.9, difficulty: 1 },
  { key: 'sadisticLevel', per: 0.0004, power: 0.2, scale: 251.19, difficulty: 2 },
];
const ADV_BETA: Curve[] = [
  { key: 'level', per: 0.0003, power: 0.4, scale: 63.13, difficulty: 0 },
  { key: 'evilLevel', per: 0.00015, power: 0.25, scale: 177.83, difficulty: 1 },
  { key: 'sadisticLevel', per: 0.00015, power: 0.12, scale: 436.53, difficulty: 2 },
];
const NGU_CURVE_LEVEL = 1000;

function nguBonus(p: PlayerData, skill: any, curves: Curve[]) {
  if (p.NGU?.disabled) return 1;
  const difficulty = num(p.settings?.rebirthDifficulty);
  let out = 1;
  for (const c of curves) {
    if (difficulty < c.difficulty) continue;
    const level = num(skill?.[c.key]);
    const bonus = level <= NGU_CURVE_LEVEL ? f(1 + f(level * f(c.per))) : f(1 + f(f(f(Math.pow(level, c.power)) * f(c.scale)) * f(c.per)));
    out = f(out * bonus);
  }
  return out;
}

// The BEARd: temporary levels while active, times permanent levels.
const ADV_BEARD = 5;
function beardBonus(p: PlayerData) {
  if (p.beards?.disabled) return 1;
  const b = p.beards?.beards?.[ADV_BEARD] ?? {};
  const temp = num(b.beardLevel);
  const perm = num(b.permLevel);
  const tempBonus = !b.active ? 1 : temp <= 1000 ? f(1 + f(temp * 0.001)) : f(1 + f(f(f(Math.pow(temp, 0.3)) * f(125.9)) * f(0.001)));
  const permBonus = perm <= 1000 ? f(1 + f(perm * 0.0005)) : f(1 + f(f(f(Math.pow(perm, 0.5)) * f(31.7)) * f(0.0005)));
  return Math.max(1, f(f(Math.max(1, tempBonus)) * permBonus));
}

// The Adventure digger, with the bonus from every upgrade level owned.
const ADV_DIGGER = 3;
function diggerBonus(p: PlayerData) {
  const diggers: any[] = Array.isArray(p.diggers?.diggers) ? p.diggers.diggers : [];
  const d = diggers[ADV_DIGGER];
  if (!d?.active) return 1;
  const total = diggers.reduce((s, x) => s + num(x?.maxLevel), 0);
  let levels = total <= 500 ? f(1 + f(total * 0.0005)) : f(1.25 + f(f(Math.pow(total - 500, 0.7)) * 0.0005));
  if (num(p.challenges?.timeMachineChallenge?.curCompletions) >= 1) levels = f(levels + 0.05);
  if (p.inventory?.itemList?.partyComplete) levels = f(levels + 0.05);
  return Math.max(1, f(f(1 + f(0.1 + num(d.curLevel) * 0.005)) * levels));
}

// Basic challenge clears: 5% each and 10% for the first, times 10% per Evil clear.
function challengeBonus(p: PlayerData) {
  const c = p.challenges?.basicChallenge ?? {};
  const clears = num(c.curCompletions);
  return f(f(f(1 + f(clears * 0.05)) + (clears >= 1 ? 0.1 : 0)) * f(1 + f(num(c.curEvilCompletions) * 0.1)));
}

const linear = (level: number, effect: number) => f(1 + f(f(level) * f(effect)));

// [perk index, effect per level, minimum difficulty]. Perks 55 and 83 apply at any difficulty.
const RICH_PERKS: readonly (readonly [number, number, number])[] = [[55, 0.001, 0], [83, 0.001, 0], [150, 0.0005, 1], [152, 0.0005, 2], [154, 0.0005, 2]];

function perkBonus(p: PlayerData) {
  const perks: unknown[] = p.adventure?.itopod?.perkLevel ?? [];
  const difficulty = num(p.settings?.rebirthDifficulty);
  const level = (i: number) => num(perks[i]);
  let out = level(2) >= 1 ? f(1.1) : 1;
  for (const [i, effect, need] of RICH_PERKS) if (difficulty >= need) out = f(out * Math.max(1, linear(level(i), effect)));
  if (level(94) >= 34) out = f(out * f(1.13)); // The Fibonacci Perk
  if (difficulty >= 2 && level(144) >= 1) out = f(out * f(1.15));
  return Math.max(1, out);
}

function quirkBonus(p: PlayerData) {
  const quirks: unknown[] = p.beastQuest?.quirkLevel ?? [];
  const difficulty = num(p.settings?.rebirthDifficulty);
  const level = (i: number) => num(quirks[i]);
  let out = f(linear(level(6), 0.25) * linear(level(8), 0.001));
  if (difficulty >= 1) out = f(out * linear(level(52), 0.001));
  for (const i of [77, 79, 171, 173]) if (difficulty >= 2) out = f(out * Math.max(1, linear(level(i), 0.0003)));
  return Math.max(1, out);
}

// [wish index, effect per level, difficulty]
const ADV_WISHES: readonly (readonly [number, number, number])[] = [[6, 0.03, 1], [29, 0.02, 1], [103, 0.02, 1], [104, 0.01, 2], [188, 0.01, 2], [218, 0.01, 2], [226, 0.01, 2]];
function wishBonus(p: PlayerData) {
  const wishes: any[] = p.wishes?.wishes ?? [];
  const difficulty = num(p.settings?.rebirthDifficulty);
  let out = difficulty >= 1 && num(wishes[0]?.level) >= 1 ? f(1.2) : 1;
  for (const [i, effect, need] of ADV_WISHES) if (difficulty >= need) out = f(out * Math.max(1, linear(num(wishes[i]?.level), effect)));
  return out;
}

// The Adventure hack, from Evil on.
const ADV_HACK = 1;
function hackBonus(p: PlayerData) {
  if (p.hacks?.disabled || num(p.settings?.rebirthDifficulty) < 1) return 1;
  const level = num(p.hacks?.hacks?.[ADV_HACK]?.level);
  const threshold = Math.max(1, 50 - num(p.adventure?.itopod?.perkLevel?.[113]));
  return f(f(1 + f(level * f(0.001))) * f(Math.pow(f(1.02), Math.floor(level / threshold))));
}

const cardBonus = (p: PlayerData) => (p.cards?.cardsOn ? num(p.cards?.bonuses?.[9]) || 1 : 1);

export type AdventureFactors = {
  training: number; ngu: number; beards: number; diggers: number; challenges: number; perks: number;
  quirks: number; macguffin: number; hacks: number; wishes: number; cards: number; sets: number;
};

// Everything both stats share, apart from Advanced Training, which differs between them.
function shared(p: PlayerData): Omit<AdventureFactors, 'training'> {
  return {
    ngu: f(nguBonus(p, p.NGU?.skills?.[4], ADV_ALPHA) * nguBonus(p, p.NGU?.magicSkills?.[6], ADV_BETA)),
    beards: beardBonus(p),
    diggers: diggerBonus(p),
    challenges: challengeBonus(p),
    perks: perkBonus(p),
    quirks: quirkBonus(p),
    macguffin: num(p.inventory?.macguffinBonuses?.[19]),
    hacks: hackBonus(p),
    wishes: wishBonus(p),
    cards: cardBonus(p),
    sets: p.inventory?.itemList?.evilBonusAccComplete ? f(1.2) : 1,
  };
}

function total(base: number, factors: AdventureFactors, extra = 1) {
  const chain = [factors.training, factors.ngu, factors.beards, factors.diggers, factors.challenges, factors.perks, extra,
    factors.quirks, factors.macguffin, factors.hacks, factors.wishes, factors.cards, factors.sets];
  return chain.reduce((acc, x) => f(acc * x), f(base));
}

const clamp = (v: number, min: number) => (!Number.isFinite(v) || v > STAT_CAP ? MAX_TOTAL : Number.isNaN(v) ? 0 : Math.max(min, v));

export type AdventureStats = { power: number; toughness: number; regen: number; factors: AdventureFactors };

export function adventureStats(p: PlayerData): AdventureStats {
  const s = shared(p);
  const attack = f(num(p.adventure?.attack) + gearAttack(p));
  const defense = f(num(p.adventure?.defense) + gearDefense(p));
  const beastMode = p.adventure?.beastModeOn ? (p.inventory?.itemList?.purpleLiquidComplete ? 1.5 : f(1.4)) : 1;
  const powerFactors = { ...s, training: f(1 + training(p, 1)) };
  const toughFactors = { ...s, training: f(1 + training(p, 0)) };
  const cubeT = cube(p, 'cubeToughness', defense);
  return {
    power: clamp(total(f(attack + cube(p, 'cubePower', attack)), powerFactors, beastMode), 1),
    toughness: clamp(total(f(defense + cubeT), toughFactors), 1),
    regen: clamp(total(f(f(num(p.adventure?.regen) + f(gearDefense(p) * f(0.03))) + f(cubeT * f(0.03))), toughFactors), MIN_REGEN),
    factors: powerFactors,
  };
}
