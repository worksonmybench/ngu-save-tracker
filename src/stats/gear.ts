import type { PlayerData } from '../save/decode';
import {
  accessorySpaces,
  gearBonuses,
  relativeStats,
  resource,
  scaledStat,
  SPECS,
  type RelativeKey,
  type ResourceKey,
} from './formulas';

// Swaps are simulated on a copy of the player data, using stats stored in the save.

export type SlotKey = string;
export type OwnedItem = { ref: string; item: any; location: string }; // ref is unique per copy: "worn:head", "inv:12"
export type Slot = { key: SlotKey; label: string; itemType: number; worn: OwnedItem; newlyUnlocked?: boolean };
export type Choices = Record<SlotKey, string>; // slot key -> item ref; absent slots keep what's worn

const ACCESSORY_TYPE = 5;
const WEAPON_TYPE = 4;
const NAMED_SLOTS: [string, string, number][] = [
  ['weapon', 'Weapon', WEAPON_TYPE],
  ['head', 'Head', 0],
  ['chest', 'Chest', 1],
  ['legs', 'Legs', 2],
  ['boots', 'Boots', 3],
];
const DUAL_WIELD_WISH = 28;
const EMPTY_ITEM = { id: 0 };

export function gearSlots(p: PlayerData): Slot[] {
  const inv = p.inventory ?? {};
  const owned = (key: string, item: any, label: string): OwnedItem => ({ ref: `worn:${key}`, item, location: `Worn: ${label}` });
  const slots: Slot[] = NAMED_SLOTS.map(([key, label, itemType]) => ({ key, label, itemType, worn: owned(key, inv[key], label) }));
  // The second weapon only counts once its wish is unlocked.
  if ((p.wishes?.wishes?.[DUAL_WIELD_WISH]?.level ?? 0) > 0) {
    slots.splice(1, 0, { key: 'weapon2', label: 'Weapon 2', itemType: WEAPON_TYPE, worn: owned('weapon2', inv.weapon2, 'Weapon 2') });
  }
  const stored: any[] = Array.isArray(inv.accs) ? inv.accs : [];
  const count = Math.max(stored.length, accessorySpaces(p));
  for (let i = 0; i < count; i++) {
    const label = `Accessory ${i + 1}`;
    slots.push({
      key: `acc${i}`,
      label,
      itemType: ACCESSORY_TYPE,
      worn: owned(`acc${i}`, stored[i] ?? EMPTY_ITEM, label),
      newlyUnlocked: i >= stored.length,
    });
  }
  return slots;
}

// Everything owned that could go in slots of this type. Daycare items are excluded: they aren't equippable.
export function ownedOfType(p: PlayerData, itemType: number): OwnedItem[] {
  const worn = gearSlots(p).filter((s) => s.itemType === itemType && s.worn.item?.id).map((s) => s.worn);
  const stored: OwnedItem[] = [];
  (p.inventory?.inventory ?? []).forEach((item: any, i: number) => {
    if (item?.id && item.type === itemType) stored.push({ ref: `inv:${i}`, item, location: `Inventory slot ${i + 1}` });
  });
  return [...worn, ...stored];
}

export function applyChoices(p: PlayerData, choices: Choices): PlayerData {
  const slots = gearSlots(p);
  const byRef = new Map<string, any>();
  for (const s of slots) byRef.set(s.worn.ref, s.worn.item);
  (p.inventory?.inventory ?? []).forEach((item: any, i: number) => byRef.set(`inv:${i}`, item));
  const inv = { ...p.inventory, accs: [...(p.inventory?.accs ?? [])] };
  for (const s of slots) {
    const item = byRef.get(choices[s.key] ?? s.worn.ref);
    if (s.key.startsWith('acc')) inv.accs[Number(s.key.slice(3))] = item;
    else inv[s.key] = item;
  }
  return { ...p, inventory: inv };
}

export type StatRow = { key: string; label: string; group: string; value: (p: PlayerData) => number | null; absolute: boolean };

const total = (key: ResourceKey) => (p: PlayerData) => resource(p, key)?.total ?? null;
const relative = (key: RelativeKey) => (p: PlayerData) => relativeStats[key](p);

export const STAT_ROWS: StatRow[] = [
  { key: 'energyPower', label: 'Energy power', group: 'Energy', value: total('energyPower'), absolute: true },
  { key: 'energyCap', label: 'Energy cap', group: 'Energy', value: total('energyCap'), absolute: true },
  { key: 'energyBars', label: 'Energy bars', group: 'Energy', value: total('energyBars'), absolute: true },
  { key: 'magicPower', label: 'Magic power', group: 'Magic', value: total('magicPower'), absolute: true },
  { key: 'magicCap', label: 'Magic cap', group: 'Magic', value: total('magicCap'), absolute: true },
  { key: 'magicBars', label: 'Magic bars', group: 'Magic', value: total('magicBars'), absolute: true },
  { key: 'attack', label: 'Attack (fights)', group: 'Fighting', value: relative('attack'), absolute: false },
  { key: 'defense', label: 'Defense (fights)', group: 'Fighting', value: relative('defense'), absolute: false },
  { key: 'advPower', label: 'Adventure Power', group: 'Adventure', value: relative('advPower'), absolute: false },
  { key: 'advToughness', label: 'Adventure Toughness', group: 'Adventure', value: relative('advToughness'), absolute: false },
  { key: 'advHP', label: 'Adventure HP', group: 'Adventure', value: relative('advHP'), absolute: false },
  { key: 'advRegen', label: 'Adventure HP regen', group: 'Adventure', value: relative('advRegen'), absolute: false },
  { key: 'loot', label: 'Drop chance', group: 'Economy', value: relative('loot'), absolute: false },
  { key: 'nguSpeed', label: 'NGU speed', group: 'Economy', value: relative('nguSpeed'), absolute: false },
];

// Specs already reflected in the rows above; the rest are listed as plain percentages.
const COVERED_SPECS = new Set([1, 3, 5, 8, 9, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 33, 34, 35, 36, 37, 38, 39, 41]);

// Remaining gear effects, grouped by label, as the percentage they add.
export function otherEffects(p: PlayerData): Map<string, number> {
  const out = new Map<string, number>();
  gearBonuses(p).forEach((bonus, type) => {
    if (type === 0 || COVERED_SPECS.has(type)) return;
    const label = SPECS[type][0];
    out.set(label, (out.get(label) ?? 0) + bonus * 100);
  });
  return out;
}

// A goal's value is a plain sum over items, so the best loadout can be picked slot by slot.
export type Goal = { key: string; label: string; specs?: readonly number[]; field?: 'curAttack' | 'curDefense' };
export const GOALS: Goal[] = [
  { key: 'energyPower', label: 'Energy power', specs: [1, 16, 27, 33] },
  { key: 'energyCap', label: 'Energy cap', specs: [20, 29, 37] },
  { key: 'energyBars', label: 'Energy bars', specs: [8, 18, 28, 35] },
  { key: 'magicPower', label: 'Magic power', specs: [3, 17, 27, 34] },
  { key: 'magicCap', label: 'Magic cap', specs: [21, 29, 38] },
  { key: 'magicBars', label: 'Magic bars', specs: [9, 19, 28, 36] },
  { key: 'attack', label: 'Attack and Adventure Power', field: 'curAttack' },
  { key: 'defense', label: 'Defense and Adventure Toughness', field: 'curDefense' },
  { key: 'loot', label: 'Drop chance', specs: [5, 41] },
  { key: 'nguSpeed', label: 'NGU speed', specs: [22, 39] },
];

export function itemShare(p: PlayerData, item: any, goal: Goal) {
  if (!item?.id) return 0;
  if (goal.field) return scaledStat(p, item, item[goal.field]);
  let share = 0;
  for (const n of [1, 2, 3]) {
    const type = item[`spec${n}Type`];
    if (goal.specs?.includes(type)) share += scaledStat(p, item, item[`spec${n}Cur`]) / SPECS[type][1];
  }
  return share;
}

export function bestLoadout(p: PlayerData, goal: Goal): Choices {
  const slots = gearSlots(p);
  const choices: Choices = {};
  for (const itemType of new Set(slots.map((s) => s.itemType))) {
    const group = slots.filter((s) => s.itemType === itemType);
    const wornRefs = new Set(group.map((s) => s.worn.ref));
    // Sort is stable and worn items come first, so ties never suggest a pointless swap.
    const ranked = ownedOfType(p, itemType)
      .map((o) => ({ o, share: itemShare(p, o.item, goal) }))
      .sort((a, b) => b.share - a.share);
    const picks = ranked.slice(0, group.length).filter((r) => r.share > 0).map((r) => r.o);
    const unfilled = group.filter((s) => !picks.some((o) => o.ref === s.worn.ref));
    const incoming = picks.filter((o) => !wornRefs.has(o.ref));
    // A weapon's second slot is scaled down, so the strongest weapon always takes the first.
    if (itemType === WEAPON_TYPE) {
      // If a slot keeps nothing better, it takes what was displaced, so no copy is worn twice.
      const left = group.map((s) => s.worn.ref).filter((r) => !picks.some((o) => o.ref === r));
      const refs = [...picks.map((o) => o.ref), ...left];
      group.forEach((s, i) => {
        if (refs[i] !== s.worn.ref) choices[s.key] = refs[i];
      });
      continue;
    }
    incoming.forEach((o, i) => (choices[unfilled[i].key] = o.ref));
  }
  return choices;
}

const goalValue = (goal: Goal) => STAT_ROWS.find((r) => r.key === goal.key)!.value;

export type SingleSwap = { slot: Slot; candidate: OwnedItem; ratio: number };

export function singleSwaps(p: PlayerData, goal: Goal): SingleSwap[] {
  const value = goalValue(goal);
  const now = value(p);
  if (!now) return [];
  const out: SingleSwap[] = [];
  for (const slot of gearSlots(p)) {
    for (const candidate of ownedOfType(p, slot.itemType)) {
      if (!candidate.ref.startsWith('inv:')) continue;
      const after = value(applyChoices(p, { [slot.key]: candidate.ref }));
      if (after) out.push({ slot, candidate, ratio: after / now });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}
