import type { PlayerData } from '../save/decode';

// Cooking rules from the game (build 1260). A dish has four pairs of ingredients. Each
// ingredient has a hidden target level, and each pair a hidden target for its combined level.
// The save stores all of them, so the best levels can be worked out exactly.

// [name, unit, units per level]. Index = the ingredient's propertyIndex.
const INGREDIENTS: readonly (readonly [string, string, number])[] = [
  ['Hot Sauce', 'ml', 50], ['Lobster', 'Kg', 1], ['Toothpaste', 'Tubes', 1], ['Rice', 'Cups', 2], ['MALK', 'Cartons', 1],
  ['Snake Oil', 'Bottle', 1], ['Mystery Meat', 'Handfuls', 1], ['A Pretzel', 'Pretzel', 1], ['Candy Canes', 'Canes', 1],
  ['Carrot', 'Carats', 1], ['Coconut Milk', 'ml', 50], ['Dry Spaghetti', 'Handfuls', 1], ['Eggs', 'Egg', 1], ['Flour', 'Cups', 1],
  ['Garlic', 'Cloves', 1], ['Lemon Juice', 'ml', 50], ['Onion', 'Onions', 1], ['Tomato', 'Tomatoes', 1], ['Bread', 'Loaves', 1],
  ['Coffee Grounds', 'Tbsp', 1],
];

const DISHES: readonly string[] = [
  'A Rock.', 'Apple Pie', 'Beans on Toast', 'Chocolate Fondue', 'East Dakota', 'Filet Mignon', 'Fried Cockroach', 'Fruit Bowl',
  'Gagh', 'Jello', 'Kebabs', 'Korft Denner', 'MacGuffin Stew', 'An Entire Merry-Go-Round', 'An MRE', 'Nutri-paste',
  'A Pie-ish, Cake-ish Thing.', 'Ramen Noodles', 'i', 'Sushi!',
];

const f = Math.fround;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const MAX_INGREDIENT_LEVEL = 20;
const LOCAL_STEP = 0.03;
const LOCAL_POWER = 30;
const PAIRED_STEP = 0.02;
const PAIRED_POWER = 40;
const MIN_QUALITY = 0.01;
const PAIRS = ['pair1', 'pair2', 'pair3', 'pair4'] as const;

type Ingredient = { property: number; level: number; target: number; weight: number; pairedWeight: number; unlocked: boolean };
type Pair = { a: number; b: number; target: number }; // ingredient indexes

export type Dish = { name: string; ingredients: Ingredient[]; pairs: Pair[] };

export function readDish(p: PlayerData): Dish | null {
  const c = p.cooking;
  if (!c?.unlocked || !Array.isArray(c.ingredients)) return null;
  const ingredients: Ingredient[] = c.ingredients.map((i: any) => ({
    property: num(i?.propertyIndex),
    level: num(i?.curLevel),
    target: num(i?.targetLevel),
    weight: num(i?.weight),
    pairedWeight: num(i?.pairedWeight),
    unlocked: !!i?.unlocked,
  }));
  const pairs = PAIRS.map((key) => ({ a: num(c[key]?.[0]), b: num(c[key]?.[1]), target: num(c[`${key}Target`]) }));
  return { name: DISHES[num(c.curDishIndex)] ?? `Dish ${num(c.curDishIndex) + 1}`, ingredients, pairs };
}

const unlocked = (d: Dish, i: number) => !!d.ingredients[i]?.unlocked;

// How close `level` is to ingredient i's target, weighted.
function local(d: Dish, i: number, level: number) {
  const ing = d.ingredients[i];
  if (!ing) return 0;
  return f(f(Math.pow(f(1 - f(LOCAL_STEP * Math.abs(ing.target - level))), LOCAL_POWER)) * ing.weight);
}

// How close the pair's combined level is to its target, weighted by the first ingredient.
function paired(d: Dish, pair: Pair, total: number) {
  return f(f(Math.pow(f(1 - f(PAIRED_STEP * Math.abs(pair.target - total))), PAIRED_POWER)) * (d.ingredients[pair.a]?.pairedWeight ?? 0));
}

// Each unlocked ingredient's level is scored against both targets in its pair.
function pairScore(d: Dish, pair: Pair, levelA: number, levelB: number) {
  let s = 0;
  if (unlocked(d, pair.a)) s = f(s + f(local(d, pair.a, levelA) + local(d, pair.b, levelA)));
  if (unlocked(d, pair.b)) s = f(s + f(local(d, pair.a, levelB) + local(d, pair.b, levelB)));
  if (unlocked(d, pair.a) && unlocked(d, pair.b)) s = f(s + paired(d, pair, levelA + levelB));
  return s;
}

const levelOf = (d: Dish, i: number) => d.ingredients[i]?.level ?? 0;
export const currentScore = (d: Dish) => d.pairs.reduce((s, p) => f(s + pairScore(d, p, levelOf(d, p.a), levelOf(d, p.b))), 0);

export type PairPlan = { pair: Pair; levelA: number; levelB: number; score: number };

// Pairs share no ingredients, so the best dish is the best levels for each pair on its own.
export function bestPlan(d: Dish): PairPlan[] {
  // A locked ingredient's level counts for nothing, so it stays where it is.
  const choices = (i: number) => (unlocked(d, i) ? Array.from({ length: MAX_INGREDIENT_LEVEL + 1 }, (_, l) => l) : [levelOf(d, i)]);
  return d.pairs.map((pair) => {
    let best: PairPlan = { pair, levelA: levelOf(d, pair.a), levelB: levelOf(d, pair.b), score: -1 };
    for (const a of choices(pair.a)) {
      for (const b of choices(pair.b)) {
        const score = pairScore(d, pair, a, b);
        if (score > best.score) best = { pair, levelA: a, levelB: b, score };
      }
    }
    return best;
  });
}

export const optimalScore = (plan: PairPlan[]) => plan.reduce((s, p) => f(s + p.score), 0);

// The game's meal efficiency: current score over the best possible, between 1% and 100%.
export function quality(score: number, optimal: number) {
  if (optimal === 0) return MIN_QUALITY;
  return Math.min(1, Math.max(MIN_QUALITY, score / optimal));
}

export type IngredientRow = { index: number; name: string; unit: string; unlocked: boolean; now: number; best: number };

export function ingredientRows(d: Dish, plan: PairPlan[]): IngredientRow[] {
  const best = new Map<number, number>();
  for (const p of plan) {
    best.set(p.pair.a, p.levelA);
    best.set(p.pair.b, p.levelB);
  }
  return d.ingredients.map((ing, index) => {
    const [name, unit, per] = INGREDIENTS[ing.property] ?? [`Ingredient ${ing.property + 1}`, '', 1];
    return { index, name, unit, unlocked: ing.unlocked, now: ing.level * per, best: (best.get(index) ?? ing.level) * per };
  });
}
