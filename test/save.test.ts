import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeSave } from '../src/save/decode';
import { byDay, withRuns, type Row, type SaveRecord } from '../src/save/derive';
import { defaultTarget, milestones, nguRates, perDay, secondsToTarget, span } from '../src/save/progress';
import { diffSaves } from '../src/save/diff';
import { extractMetrics } from '../src/save/metrics';
import { ITEM_NAMES, itemName } from '../src/data/itemNames';
import { Reader } from '../src/save/nrbf';
import { accessorySpaces, energyPower, gearBonuses, relativeStats, resource, type RelativeKey, type ResourceKey } from '../src/stats/formulas';
import { applyPurchases, availableExp, planPurchases } from '../src/stats/exp';
import { augBoost, AUGMENTS, augTier, augPerEnergy, grossGoldPerSecond, rankPairs, upgradePerEnergy, currentAugBoost, TICKS_PER_SECOND } from '../src/stats/augments';
import { minimumWishSeconds, progressPerTick as wishProgressPerTick, rawProgressPerTick, wishRows, wishSlots } from '../src/stats/wishes';
import { WISHES } from '../src/data/wishes';
import { hackBonus, nextMilestone, planHackday, progressPerTick, readHacks, secondsTo, HACK_HACK } from '../src/stats/hacks';
import { bonusAt, diggerSlots, drainAt, levelBonus, planDiggers, readDiggers, upgradeCost } from '../src/stats/diggers';
import { beardGain, beardTimeFactor, compareLengths, gainsAt, macguffinGain, macguffinTimeFactor, readRebirth } from '../src/stats/rebirth';
import { challengeRows, difficultyReached, setRows, setsInProgress } from '../src/stats/checklists';
import { ITEM_SETS } from '../src/data/itemSets';
import { bestPlan, currentScore, ingredientRows, optimalScore, quality, readDish } from '../src/stats/cooking';
import { fruitReport, harvestSeeds, tierCap, tierSeconds } from '../src/stats/fruit';
import { applyChoices, bestLoadout, gearSlots, GOALS, otherEffects, ownedOfType, singleSwaps, STAT_ROWS } from '../src/stats/gear';
import { encodeSave, nrbf } from './encode';

// Private reference data and real saves live outside the repo. Suites that need them skip when absent.
const EXTRACTED = process.env.NGU_REFERENCE_DIR ?? join(__dirname, '../../rea-test/extracted');
const PY_DECODER = join(EXTRACTED, 'ngu_save_decode.py');
const SAMPLE_CSV = join(EXTRACTED, 'webapp_handoff/reference/sample_ngu_progress.csv');
const ORACLE = join(EXTRACTED, 'stats_oracle.json'); // from rea-test/extracted/export_oracle.py
const SWAP_ORACLE = join(EXTRACTED, 'swap_oracle.json');
const FRUIT_ORACLE = join(EXTRACTED, 'fruit_oracle.json');
const AUG_ORACLE = join(EXTRACTED, 'aug_oracle.json');
const REBIRTH_ORACLE = join(EXTRACTED, 'rebirth_oracle.json'); // beard and MacGuffin time factors from the game's methods
const GUFF_ORACLE = join(EXTRACTED, 'guff_oracle.json'); // MacGuffin bonus added per rebirth
const COOK_ORACLE = join(EXTRACTED, 'cook_oracle.json');
const WISH_ORACLE = join(EXTRACTED, 'wish_oracle.json'); // random wish states run through the game's methods
const HACK_ORACLE = join(EXTRACTED, 'hack_oracle.json'); // random hack states run through the game's methods
const DIGGER_ORACLE = join(EXTRACTED, 'digger_oracle.json'); // random digger states run through the game's methods // random dishes scored by the game's CookingController
const REAL_SAVES = process.env.NGU_SAVES_DIR ?? join(__dirname, '../../NGU Idle -saves/NGU Idle');

const player = {
  playerName: 'Test Player',
  version: 1260,
  lastTime: 1793387184,
  attackMulti: 1e45,
  energyPower: 11.5,
  capEnergy: 260000,
  energyBars: 4,
  bossID: 54,
  highestBoss: 65,
  stats: { totalExp: 3424 },
  totalPlaytime: { totalseconds: 7200 },
  rebirthTime: { totalseconds: 300 },
  magic: { magicPower: 1.5 },
  arbitrary: { curArbitraryPoints: 55 },
  adventure: { highestItopodLevel: 95 },
  settings: { rebirthDifficulty: 0 },
  NGU: { skills: [{ level: 3 }, { level: 4 }], magicSkills: [{ level: 2 }] },
  yggdrasil: { seeds: 10, fruits: [{ maxTier: 2 }, { maxTier: 1 }] },
  challenges: {
    basicChallenge: { inChallenge: false, curCompletions: 2 },
    noAugsChallenge: { inChallenge: true, curCompletions: 1 },
  },
  inventory: {
    head: { id: 5, curAttack: 10, curDefense: 1 },
    chest: { id: 0, curAttack: 999, curDefense: 999 },
    legs: null,
    boots: null,
    weapon: { id: 2, curAttack: 20, curDefense: 2 },
    accs: [{ id: 9, curAttack: 0, curDefense: 3 }],
    itemList: { forestComplete: true, caveComplete: false },
  },
};

describe('save decoding', () => {
  it('round-trips the game envelope and flattens lists', () => {
    const { player: p, checksum } = decodeSave(encodeSave(player));
    expect(checksum).toBeTruthy();
    expect(p.playerName).toBe('Test Player');
    expect(p.NGU.skills.map((s: any) => s.level)).toEqual([3, 4]);
  });

  it('reads boolean arrays, as the item dropped and maxed flags are stored', () => {
    const { player: p } = decodeSave(encodeSave({ ...player, flags: [true, false, true] }));
    expect(p.flags).toEqual([true, false, true]);
  });

  it('rejects a tampered save', () => {
    const inner = nrbf(player);
    const text = nrbf({ playerData: inner.toString('base64'), checksum: 'AAAA' }, 'SaveData').toString('base64');
    expect(() => decodeSave(text)).toThrow(/checksum/);
  });

  it('rejects things that are not saves', () => {
    expect(() => decodeSave('hello world')).toThrow(/not an NGU Idle save/);
    expect(() => decodeSave(Buffer.from('not nrbf at all').toString('base64'))).toThrow(/not an NGU Idle save/);
  });

  it('survives truncation at every length without hanging', () => {
    const bytes = nrbf(player);
    for (let n = 0; n < bytes.length; n += 7) {
      try {
        new Reader(bytes.subarray(0, n)).parse();
      } catch {
        // Throwing is fine. Hanging or exhausting memory is what this guards.
      }
    }
  });

  it('refuses arrays claiming impossible sizes', () => {
    const b = Buffer.from([15, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f, 6]);
    expect(() => new Reader(b).parse()).toThrow(/too large/);
  });

  it('does not let field names reach the prototype', () => {
    const bytes = nrbf(JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}'));
    const out = new Reader(bytes).parse() as any;
    expect(({} as any).polluted).toBeUndefined();
    expect(out.a).toBe(1);
  });

  it.skipIf(!existsSync(PY_DECODER))('agrees with the Python decoder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngu-'));
    const file = join(dir, 'save.txt');
    writeFileSync(file, encodeSave(player));
    const py = JSON.parse(execFileSync('python3', ['-I', PY_DECODER, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(JSON.parse(JSON.stringify(decodeSave(encodeSave(player)).player))).toEqual(py);
  });
});

describe('metrics', () => {
  const m = extractMetrics(decodeSave(encodeSave(player)).player, 123);

  it('derives the documented values', () => {
    expect(m.savedAt).toBe(1793387184000);
    expect(m.timeSource).toBe('lastTime');
    expect(m.lifetimeExp).toBe(3424);
    expect(m.rebirthMultiLog10).toBeCloseTo(45);
    expect(m.nguLevels).toBe(9);
    expect(m.gearPower).toBe(30); // id 0 slots are empty
    expect(m.gearToughness).toBe(6);
    expect(m.loadout).toBe('2,5,9');
    expect(m.setsComplete).toBe(1);
    expect(m.challengesDone).toBe(3);
    expect(m.inChallenge).toBe('noAugs');
    expect(m.seedsEarned).toBe(10 + (1 + 4) + 10);
    expect(m.runBoss).toBe(53);
  });

  it('falls back to the file date and turns NaN into null', () => {
    const x = extractMetrics({ lastTime: 0, energyPower: NaN }, 123);
    expect(x.savedAt).toBe(123);
    expect(x.timeSource).toBe('file');
    expect(x.energyPower).toBeNull();
  });

  it('never carries the player name', () => {
    expect(JSON.stringify(m)).not.toContain('Test Player');
  });
});

describe('diff', () => {
  it('reports changes by section and hides the player name', () => {
    const a = { playerName: 'A', exp: 1, stats: { totalExp: 1, same: 2 }, list: [1, 2] };
    const b = { playerName: 'B', exp: 2, stats: { totalExp: 5, same: 2 }, list: [1, 3] };
    const s = diffSaves(a, b);
    expect(s.map((x) => x.name)).toEqual(['exp', 'list', 'stats']);
    expect(s[1].changes[0]).toEqual({ path: 'list[1]', before: 2, after: 3 });
  });
});

function parseCsv(path: string) {
  const [head, ...lines] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

describe.skipIf(!existsSync(SAMPLE_CSV))('against the reference CSV', () => {
  const csv = existsSync(SAMPLE_CSV) ? parseCsv(SAMPLE_CSV) : [];
  const saves = csv.map((r, i) => {
    const savedAt = new Date(r.saved_at).getTime();
    return {
      id: String(i),
      savedAt,
      rebirthSeconds: (savedAt - new Date(r.run_start).getTime()) / 1000,
      runBoss: Number(r.run_boss),
      lifetimeExp: Number(r.lifetime_exp),
    } as SaveRecord;
  });

  it('reproduces the prototype run grouping and peaks', () => {
    const rows = withRuns(saves);
    expect(rows.map((r) => r.runId)).toEqual(csv.map((r) => Number(r.run_id)));
    expect(rows.map((r) => r.runPeakBoss)).toEqual(csv.map((r) => Number(r.run_peak_boss)));
  });

  it('keeps one row per day', () => {
    const days = byDay(withRuns(saves));
    expect(new Set(days.map((d) => d.day)).size).toBe(days.length);
    expect(days[0].expPerDay).toBeNull();
  });
});

// Runs when the real saves folder is present; it is never bundled.
const realSaves = existsSync(REAL_SAVES) ? readdirSync(REAL_SAVES).filter((f) => f.endsWith('.txt')) : [];
describe.skipIf(!realSaves.length)('against real saves', () => {
  const drift: [string, number][] = [];
  afterAll(() => {
    const abs = drift.map(([, d]) => Math.abs(d)).sort((a, b) => a - b);
    console.log('lastTime vs mtime, seconds: median', abs[abs.length >> 1], 'max', abs.at(-1), drift.filter(([, d]) => Math.abs(d) > 120).slice(0, 8));
  });
  it.each(realSaves)('%s', (name) => {
    const file = join(REAL_SAVES, name);
    const { player: p } = decodeSave(readFileSync(file, 'utf8'));
    const py = JSON.parse(execFileSync('python3', ['-I', PY_DECODER, file], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\bNaN\b/g, 'null').replace(/-?\bInfinity\b/g, 'null'));
    expect(JSON.parse(JSON.stringify(p))).toEqual(py);
    const m = extractMetrics(p, statSync(file).mtimeMs);
    expect(m.timeSource).toBe('lastTime');
    expect(m.lifetimeExp).toBeGreaterThan(0);
    drift.push([name, Math.round((m.savedAt - statSync(file).mtimeMs) / 1000)]);
  }, 60_000);
});

const ROUNDING_SAVES = new Set(
  ['October-11-23-15', 'October-11-23-25', 'October-11-23-40', 'October-12-00-39', 'October-12-01-05', 'October-12-20-46'].map(
    (d) => `NGUSave-Build-1260-${d}.txt`,
  ),
);

describe.skipIf(!realSaves.length || !existsSync(ORACLE))('energy power against the predictor', () => {
  const oracle = JSON.parse(existsSync(ORACLE) ? readFileSync(ORACLE, 'utf8') : '{}');
  const close = (a: number, b: number) => expect(Math.abs(a - b) / Math.max(Math.abs(b), 1e-9)).toBeLessThan(2e-5);

  it.each(realSaves)('%s', (name) => {
    const o = oracle[name];
    const r = energyPower(decodeSave(readFileSync(join(REAL_SAVES, name), 'utf8')).player)!;
    close(r.factors.perks, o.perks);
    close(r.factors.quirks, o.quirks);
    close(r.factors.wishes, o.wishes);
    const b = o.bonuses;
    const gear = 1 + (b[1] ?? 0) + (b[16] ?? 0) + (b[27] ?? 0) + (b[33] ?? 0);
    if (ROUNDING_SAVES.has(name)) {
      // One floored spec differs by a single 0.001 step: 580 * 17/58 is 169.999... in the
      // predictor's doubles but 170 in float32. Everything else must still agree exactly.
      expect(Math.abs(r.factors.gear - gear)).toBeLessThan(0.0011);
      close(r.total / r.factors.gear, o.energyPower / gear);
    } else {
      close(r.factors.gear, gear);
      close(r.total, o.energyPower);
    }
  });
});

describe('energy power rules', () => {
  const base = { energyPower: 10, inventory: { macguffinBonuses: [2] }, settings: { rebirthDifficulty: 0 } };

  it('applies the MacGuffin multiplier with nothing else owned', () => {
    expect(energyPower(base)!.total).toBeCloseTo(20);
  });

  it('applies difficulty-gated perks only at that difficulty', () => {
    const perkLevel = Array(232).fill(0);
    perkLevel[57] = 100;
    const at = (d: number) => energyPower({ ...base, settings: { rebirthDifficulty: d }, adventure: { itopod: { perkLevel } } })!.factors.perks;
    expect(at(0)).toBe(1);
    expect(at(1)).toBeCloseTo(2);
  });

  it('ignores gear in the No Equipment challenge', () => {
    const inventory = { ...base.inventory, head: { spec1Type: 1, spec1Cur: 500, bossRequired: 0 } };
    expect(energyPower({ ...base, inventory })!.factors.gear).toBeCloseTo(6);
    expect(energyPower({ ...base, inventory, challenges: { noEquipmentChallenge: { inChallenge: true } } })!.factors.gear).toBe(1);
  });

  it('counts gear with no boss requirement right after a rebirth', () => {
    const inventory = { ...base.inventory, head: { spec1Type: 1, spec1Cur: 500, bossRequired: 0 } };
    expect(energyPower({ ...base, bossID: 0, inventory })!.factors.gear).toBeCloseTo(6);
  });

  it('never goes below 1, and returns null without a base value', () => {
    expect(energyPower({ ...base, energyPower: 0.1, inventory: { macguffinBonuses: [1] } })!.total).toBe(1);
    expect(energyPower({})).toBeNull();
  });
});

// Boss 0 with a no-requirement item: 0/0 is NaN. Unity's Mathf.Min then returns 1, so the item counts
// in full, but the predictor's NaN zeroes those bonuses (it reports an energy cap of 9e18).
const PREDICTOR_NAN_SAVES = new Set(['October-11-22-16', 'October-13-13-09'].map((d) => `NGUSave-Build-1260-${d}.txt`));
const RESOURCES: ResourceKey[] = ['energyPower', 'energyCap', 'energyBars', 'magicPower', 'magicCap', 'magicBars'];
const ratioClose = (a: number, b: number, tol = 2e-5) => expect(Math.abs(a / b - 1)).toBeLessThan(tol);

describe.skipIf(!realSaves.length || !existsSync(ORACLE))('all resources against the predictor', () => {
  const oracle = JSON.parse(existsSync(ORACLE) ? readFileSync(ORACLE, 'utf8') : '{}');
  it.each(realSaves)('%s', (name) => {
    const o = oracle[name];
    const p = decodeSave(readFileSync(join(REAL_SAVES, name), 'utf8')).player;
    const bonuses = gearBonuses(p);
    if (PREDICTOR_NAN_SAVES.has(name)) {
      expect(p.bossID).toBe(0);
      expect(bonuses[20]).toBeGreaterThan(0); // the no-requirement accessory still counts
      expect(resource(p, 'energyCap')!.total).toBeLessThan(1e9);
      return;
    }
    if (!ROUNDING_SAVES.has(name)) {
      for (let type = 1; type < bonuses.length; type++) expect(Math.abs(bonuses[type] - (o.bonuses[type] ?? 0))).toBeLessThan(2e-5);
    }
    for (const key of RESOURCES) {
      const got = resource(p, key)!.total;
      if (ROUNDING_SAVES.has(name)) expect(Math.abs(got / o[key] - 1)).toBeLessThan(2e-3);
      else if (key.endsWith('Bars')) expect(Math.abs(got - o[key])).toBeLessThanOrEqual(Math.max(1, o[key] * 2e-5));
      else ratioClose(got, o[key]);
    }
    expect(accessorySpaces(p)).toBeGreaterThanOrEqual(o.accessorySpaces);
  });
});

describe.skipIf(!realSaves.length || !existsSync(SWAP_ORACLE))('gear what-if on the latest real save', () => {
  const p = realSaves.length ? decodeSave(readFileSync(join(REAL_SAVES, 'NGUSaveSteam.txt'), 'utf8')).player : {};
  const cases = existsSync(SWAP_ORACLE) ? JSON.parse(readFileSync(SWAP_ORACLE, 'utf8')) : [];
  const base = existsSync(ORACLE) ? JSON.parse(readFileSync(ORACLE, 'utf8'))['NGUSaveSteam.txt'] : {};
  const slotOf = (c: any) => (c.accIndex === null ? c.slot : `acc${c.accIndex}`);
  const RELATIVE: [RelativeKey, string][] = [['attack', 'attack'], ['defense', 'defense'], ['advPower', 'advAttack'], ['advToughness', 'advDefense'], ['advHP', 'advHP'], ['advRegen', 'advRegen'], ['loot', 'lootFactor'], ['nguSpeed', 'nguSpeed']];

  it('matches the predictor on all resources for every swap', () => {
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) {
      const t = applyChoices(p, { [slotOf(c)]: `inv:${c.inventoryIndex}` });
      for (const key of RESOURCES) {
        const got = resource(t, key)!.total;
        if (key.endsWith('Bars')) expect(Math.abs(got - c.stats[key])).toBeLessThanOrEqual(Math.max(1, c.stats[key] * 2e-5));
        else ratioClose(got, c.stats[key]);
      }
    }
  });

  it.each(RELATIVE)('matches the predictor change in %s for every swap', (key, oracleKey) => {
    for (const c of cases) {
      const t = applyChoices(p, { [slotOf(c)]: `inv:${c.inventoryIndex}` });
      ratioClose(relativeStats[key](t) / relativeStats[key](p), c.stats[oracleKey] / base[oracleKey], 1e-4);
    }
  });

  it('matches the game bonus for every effect on every swap', () => {
    for (const c of cases) {
      const b = gearBonuses(applyChoices(p, { [slotOf(c)]: `inv:${c.inventoryIndex}` }));
      for (let type = 1; type < b.length; type++) expect(Math.abs(b[type] - (c.stats.bonuses[type] ?? 0))).toBeLessThan(2e-5);
    }
  });

  it('changes nothing when no choices are made, and does not modify the save', () => {
    const before = JSON.stringify(p);
    for (const row of STAT_ROWS) expect(row.value(applyChoices(p, {}))).toBe(row.value(p));
    applyChoices(p, { head: 'inv:0' });
    expect(JSON.stringify(p)).toBe(before);
  });

  it.each(GOALS.map((g) => [g.key, g] as const))('finds the true best loadout for %s, checked by trying every combination', (_, goal) => {
    const value = STAT_ROWS.find((r) => r.key === goal.key)!.value;
    const slots = gearSlots(p);
    let best = 0;
    const search = (i: number, choices: Record<string, string>, used: Set<string>) => {
      if (i === slots.length) {
        best = Math.max(best, value(applyChoices(p, choices))!);
        return;
      }
      for (const o of ownedOfType(p, slots[i].itemType)) {
        if (used.has(o.ref)) continue;
        search(i + 1, { ...choices, [slots[i].key]: o.ref }, new Set(used).add(o.ref));
      }
    };
    search(0, {}, new Set());
    const chosen = value(applyChoices(p, bestLoadout(p, goal)))!;
    expect(Math.abs(chosen / best - 1)).toBeLessThan(1e-5);
    const refs = Object.values(bestLoadout(p, goal));
    expect(new Set(refs).size).toBe(refs.length);
  }, 300_000);

  it('ranks single swaps best first', () => {
    const swaps = singleSwaps(p, GOALS[0]);
    expect(swaps.length).toBe(cases.length);
    for (let i = 1; i < swaps.length; i++) expect(swaps[i - 1].ratio).toBeGreaterThanOrEqual(swaps[i].ratio);
  });

  it('lists effects the stat rows do not cover', () => {
    expect([...otherEffects(p).keys()]).toContain('EXP');
    expect([...otherEffects(p).keys()]).not.toContain('Energy Power');
  });
});

describe('accessory slots', () => {
  it('counts each unlock, and offers slots the save has not added yet', () => {
    expect(accessorySpaces({})).toBe(2);
    const p = {
      purchases: { hasAcc3: true },
      arbitrary: { hasAcc4: true },
      challenges: { trollChallenge: { curCompletions: 2, curEvilCompletions: 0, curSadisticCompletions: 6 } },
      adventure: { itopod: { perkLevel: Array(30).fill(0).map((_, i) => (i === 29 ? 1 : 0)) } },
      inventory: { accs: [{ id: 1, type: 5 }, { id: 2, type: 5 }], inventory: [{ id: 3, type: 5, spec1Type: 1, spec1Cur: 500, bossRequired: 0 }], macguffinBonuses: [1] },
      energyPower: 10,
    };
    expect(accessorySpaces(p)).toBe(6);
    const accs = gearSlots(p).filter((s) => s.itemType === 5);
    expect(accs.length).toBe(6);
    expect(accs.filter((s) => s.newlyUnlocked).length).toBe(4);
    const c = bestLoadout(p, GOALS[0]);
    expect(resource(applyChoices(p, c), 'energyPower')!.factors.gear).toBeCloseTo(6);
    expect(Object.keys(c)).toEqual(['acc0']);
  });

  it('never offers fewer slots than the save already has', () => {
    const accs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(gearSlots({ inventory: { accs } }).filter((s) => s.itemType === 5).length).toBe(3);
  });
});

describe('gear what-if rules', () => {
  const weapon = (id: number, power: number) => ({ id, type: 4, bossRequired: 0, spec1Type: 1, spec1Cur: power });
  const base = (wish: number) => ({
    energyPower: 10,
    wishes: { wishes: Array.from({ length: 46 }, (_, i) => ({ level: i === 28 ? wish : 0 })) },
    inventory: { macguffinBonuses: [1], weapon: weapon(1, 100), weapon2: weapon(2, 900), head: { id: 0 }, chest: { id: 0 }, legs: { id: 0 }, boots: { id: 0 }, accs: [], inventory: [weapon(3, 500)] },
  });

  it('only offers the second weapon slot once unlocked', () => {
    expect(gearSlots(base(0)).some((s) => s.key === 'weapon2')).toBe(false);
    expect(gearSlots(base(1)).some((s) => s.key === 'weapon2')).toBe(true);
  });

  it('puts the strongest weapon first and never doubles a copy', () => {
    const c = bestLoadout(base(1), GOALS[0]);
    expect(c.weapon).toBe('worn:weapon2');
    expect(c.weapon2).toBe('inv:0');
  });
});

describe.skipIf(!realSaves.length || !existsSync(FRUIT_ORACLE))('fruit against the predictor', () => {
  const oracle = existsSync(FRUIT_ORACLE) ? JSON.parse(readFileSync(FRUIT_ORACLE, 'utf8')) : {};
  it.each(realSaves)('%s', (name) => {
    const o = oracle[name];
    const p = decodeSave(readFileSync(join(REAL_SAVES, name), 'utf8')).player;
    expect(tierSeconds(p)).toBe(o.threshold);
    expect(tierCap(p)).toBe(o.capTier);
    const rows = fruitReport(p).rows;
    o.fruits.forEach((fruit: any, id: number) => {
      expect(rows[id].tier).toBe(fruit.harvestTier);
      if (PREDICTOR_NAN_SAVES.has(name)) return;
      for (const [tier, seeds] of Object.entries(fruit.rewards)) expect(harvestSeeds(p, id, Number(tier))).toBe(seeds);
    });
  });
});

describe('fruit timing', () => {
  const fruit = (over: object) => ({ seconds: 0, activated: true, maxTier: 2, harvests: 1, ...over });
  const save = (fruits: object[], extra: object = {}) => ({ yggdrasil: { seeds: 100, resetFactor: 0, fruits }, ...extra });

  it('reports tier and time left from growth so far', () => {
    const r = fruitReport(save([fruit({ seconds: 5400 })])).rows[0];
    expect(r.tier).toBe(1);
    expect(r.secondsToNext).toBe(1800);
    expect(r.secondsToMax).toBe(1800);
    expect(r.state).toBe('growing');
  });

  it('projects growth forward but stops at max tier', () => {
    const r = fruitReport(save([fruit({ seconds: 3600 })]), 100).rows[0];
    expect(r.tier).toBe(2);
    expect(r.state).toBe('ready');
    expect(r.secondsToMax).toBeNull();
  });

  it('does not grow inactive fruit', () => {
    const r = fruitReport(save([fruit({ activated: false, seconds: 9000 })]), 5).rows[0];
    expect(r.tier).toBe(0);
    expect(r.state).toBe('inactive');
  });

  it('shortens tiers with the quirk, up to its limit', () => {
    const quirkLevel = Array(14).fill(0);
    quirkLevel[13] = 10;
    expect(tierSeconds({ beastQuest: { quirkLevel } })).toBe(3420);
  });

  it('counts next tier cost and affordability', () => {
    const r = fruitReport(save([fruit({}), fruit({ maxTier: 4 })])).rows;
    expect(r[0].nextTierCost).toBe(9);
    expect(r[0].affordable).toBe(true);
    expect(r[1].nextTierCost).toBe(250);
    expect(r[1].affordable).toBe(false);
  });

  it('stops offering tiers at the cap, and raises the cap after 3 Troll clears', () => {
    expect(fruitReport(save([fruit({ maxTier: 10 })])).rows[0].nextTierCost).toBeNull();
    const raised = save([fruit({ maxTier: 10 })], { challenges: { trollChallenge: { curCompletions: 3 } } });
    expect(fruitReport(raised).rows[0].nextTierCost).toBe(121);
  });

  it('flags growth as lost at rebirth unless the reset factor keeps it', () => {
    expect(fruitReport(save([fruit({})])).growthLostAtRebirth).toBe(true);
    const kept = { yggdrasil: { seeds: 0, resetFactor: 1, fruits: [fruit({})] } };
    expect(fruitReport(kept).growthLostAtRebirth).toBe(false);
  });
});

describe('EXP spending', () => {
  const ratio = { power: 1, cap: 37500, bars: 1 };
  const save = { realExp: 5000, energyPower: 300, capEnergy: 11250000, energyBars: 300, magic: { magicPower: 6, capMagic: 225000, magicPerBar: 6 } };
  const buy = (plan: any, key: string) => plan.purchases.find((x: any) => x.key === key).buy;

  it('reads the spendable EXP, not the stale field', () => {
    expect(availableExp({ exp: 0, realExp: 4661 })).toBe(4661);
  });

  it('uses the game prices, with magic at 3× energy', () => {
    const plan = planPurchases({ ...save, magic: { magicPower: 10, capMagic: 375000, magicPerBar: 10 } }, { budget: 1e6, energyPerMagic: 1, ratio });
    for (const b of plan.purchases) {
      const unit = { energyPower: 150, energyCap: 1 / 250, energyBars: 80, magicPower: 450, magicCap: 3 / 250, magicBars: 240 }[b.key]!;
      expect(b.cost).toBe(Math.round(b.buy * unit));
    }
  });

  it('never overspends, at any budget', () => {
    for (const budget of [0, 1, 7, 100, 449, 450, 5000, 123456, 1e7, 1e10]) {
      const plan = planPurchases(save, { budget, energyPerMagic: 3, ratio });
      expect(plan.spent).toBeLessThanOrEqual(budget);
      expect(plan.spent + plan.unused).toBeCloseTo(budget);
    }
  });

  it('raises only what is below target first', () => {
    const plan = planPurchases(save, { budget: 5000, energyPerMagic: 3, ratio });
    expect(buy(plan, 'energyPower')).toBe(0);
    expect(buy(plan, 'energyCap')).toBe(0);
    expect(buy(plan, 'magicPower')).toBeGreaterThan(0);
    expect(plan.fullyBalanced).toBe(false);
  });

  it('reaches the exact ratio when the budget covers it, and prices that correctly', () => {
    const needed = planPurchases(save, { budget: 0, energyPerMagic: 3, ratio }).fullCost;
    // Magic must rise from 6 to 100 power (94 × 450), 225k to 3.75M cap, and 6 to 100 bars (94 × 240).
    expect(needed).toBe(94 * 450 + (3525000 * 3) / 250 + 94 * 240);
    const plan = planPurchases(save, { budget: needed + 1, energyPerMagic: 3, ratio });
    expect(plan.fullyBalanced).toBe(true);
    expect(buy(plan, 'magicPower')).toBe(94);
    expect(buy(plan, 'magicCap')).toBe(3525000);
    expect(buy(plan, 'magicBars')).toBe(94);
  });

  it('applies purchases to a copy of the base stats', () => {
    const plan = planPurchases(save, { budget: 5000, energyPerMagic: 3, ratio });
    const after = applyPurchases(save, plan);
    expect(after.magic.magicPower).toBe(6 + buy(plan, 'magicPower'));
    expect(save.magic.magicPower).toBe(6);
  });
});

describe('item names', () => {
  it('keeps names clean of rich-text markup but keeps hearts', () => {
    expect(ITEM_NAMES.some((n) => /<\/?(b|i|color)\b|\n/.test(n))).toBe(false);
    expect(itemName(119)).toBe('My Red Heart <3');
    expect(itemName(278)).toBe('[QUEST ITEM] Bits of String');
    expect(itemName(130)).toBe('Mega Helmet');
  });

  it('falls back to the id for empty or unknown items', () => {
    expect(itemName(0)).toBe('Item 0');
    expect(itemName(99999)).toBe('Item 99999');
  });

  it('holds short names, never description text', () => {
    expect(Math.max(...ITEM_NAMES.map((n) => n.length))).toBeLessThan(80);
    expect(ITEM_NAMES.join(' ')).not.toContain('Drag this item');
  });

  it.skipIf(!realSaves.length)('names every item in the real saves', () => {
    for (const name of realSaves) {
      const inv = decodeSave(readFileSync(join(REAL_SAVES, name), 'utf8')).player.inventory;
      const items = [inv.weapon, inv.head, inv.chest, inv.legs, inv.boots, inv.weapon2, ...inv.accs, ...inv.inventory, ...inv.daycare];
      for (const e of items) if (e?.id) expect(ITEM_NAMES[e.id], `${name} item ${e.id}`).toBeTruthy();
    }
  });
});

// The predictor defaults maxCompletions to 0, so "clears >= max" is always true for it. That wrongly
// grants ×1.25 speed and +0.05 tier per augment id. These saves have no clears of either challenge.
const PREDICTOR_MAX_CLEARS_SPEED = 1.25;
const PREDICTOR_MAX_CLEARS_TIER = 0.05;

describe.skipIf(!realSaves.length || !existsSync(AUG_ORACLE))('augments and gold against the game methods', () => {
  const oracle = existsSync(AUG_ORACLE) ? JSON.parse(readFileSync(AUG_ORACLE, 'utf8')) : {};
  it.each(realSaves)('%s', (name) => {
    const base = decodeSave(readFileSync(join(REAL_SAVES, name), 'utf8')).player;
    if (PREDICTOR_NAN_SAVES.has(name)) return;
    for (const difficulty of [0, 1, 2]) {
      const p: any = { ...base, settings: { ...base.settings, rebirthDifficulty: difficulty } };
      if (difficulty) {
        p.hacks = { ...base.hacks, hacks: base.hacks.hacks.map((h: any, i: number) => (i === 4 ? { ...h, level: 45 } : h)) };
        p.NGU = { ...base.NGU, magicSkills: base.NGU.magicSkills.map((s: any, i: number) => (i === 4 ? { ...s, evilLevel: 1500, sadisticLevel: 300 } : s)) };
      }
      const o = oracle[name][difficulty];
      ratioClose(grossGoldPerSecond(p) || 1, o.gold || 1, 1e-4);
      o.pairs.forEach((pair: any, id: number) => {
        const saved = base.augments.augs[id];
        if (pair.boost) ratioClose(augBoost(p, id, saved.augLevel, saved.upgradeLevel) * Math.pow(saved.augLevel, PREDICTOR_MAX_CLEARS_TIER * id), pair.boost, 1e-4);
        if (pair.aug) ratioClose(augPerEnergy(p, id) * 1e6 * PREDICTOR_MAX_CLEARS_SPEED, pair.aug, 1e-3);
        if (pair.upgrade) ratioClose(upgradePerEnergy(p, id) * 1e6 * PREDICTOR_MAX_CLEARS_SPEED, pair.upgrade, 1e-3);
      });
    }
  });
});

describe('augment pair ranking', () => {
  const save: any = {
    energyPower: 100, highestBoss: 200, bossID: 200,
    inventory: { macguffinBonuses: Array(24).fill(1) }, settings: { rebirthDifficulty: 0 },
    augments: { augs: AUGMENTS.map(() => ({ augLevel: 0, upgradeLevel: 0 })) },
  };
  const plan = (over: object) => rankPairs(save, { hours: 8, energy: 1e7, gold: 0, goldPerSecond: 1e40, fresh: true, ...over });
  const byId = (rows: any[], id: number) => rows.find((r) => r.id === id);

  it('splits energy 2 : tier when only energy limits', () => {
    for (const id of [0, 3, 6]) {
      // Needs high levels: below upgrade level 1 or so, 1 + U² isn't yet growing like U².
      const r = byId(plan({ energy: 1e24, goldPerSecond: 1e80 }), id);
      const tier = 1 + 0.1 * id;
      expect(augTier(save, id)).toBeCloseTo(tier);
      expect(r.limit).toBe('energy');
      expect(r.upgradeShare).toBeCloseTo(2 / (2 + tier), 2);
    }
  });

  it('reaches the closed-form levels', () => {
    const r = byId(plan({}), 3);
    const t = 8 * 3600 * TICKS_PER_SECOND;
    expect(r.level).toBeCloseTo(Math.sqrt(2 * augPerEnergy(save, 3) * 1e7 * (1 - r.upgradeShare) * t), 3);
    expect(r.upgrade).toBeCloseTo(Math.sqrt(2 * upgradePerEnergy(save, 3) * 1e7 * r.upgradeShare * t), 3);
  });

  it('never spends more gold or energy than available', () => {
    for (const gold of [0, 1e8, 1e12, 1e18]) {
      for (const r of rankPairs(save, { hours: 4, energy: 1e7, gold, goldPerSecond: 1e10, fresh: true })) {
        expect(r.goldSpent).toBeLessThanOrEqual((gold + 1e10 * 4 * 3600) * (1 + 1e-9));
        expect(r.upgradeShare).toBeLessThanOrEqual(1);
      }
    }
  });

  it('shifts energy away from upgrades as gold runs short', () => {
    const rich = byId(plan({}), 2);
    const poor = byId(rankPairs(save, { hours: 8, energy: 1e7, gold: 0, goldPerSecond: 1e11, fresh: true }), 2);
    expect(poor.limit).toBe('gold');
    expect(poor.upgradeShare).toBeLessThan(rich.upgradeShare);
  });

  it('ranks best first, and leaves pairs locked by boss at the bottom', () => {
    const early = { ...save, highestBoss: 30 };
    const rows = rankPairs(early, { hours: 8, energy: 1e7, gold: 0, goldPerSecond: 1e40, fresh: true });
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].bonus).toBeGreaterThanOrEqual(rows[i].bonus);
    expect(byId(rows, 6).limit).toBe('locked');
    expect(byId(rows, 3).upgrade).toBe(0); // augment open at boss 23, upgrade needs 45
  });

  it('continues from current levels when not fresh', () => {
    const s = { ...save, augments: { augs: AUGMENTS.map((_, i) => ({ augLevel: i === 1 ? 500 : 0, upgradeLevel: i === 1 ? 100 : 0 })) } };
    const r = byId(rankPairs(s, { hours: 1, energy: 1e7, gold: 0, goldPerSecond: 1e40, fresh: false }), 1);
    expect(r.level).toBeGreaterThanOrEqual(500);
    expect(r.upgrade).toBeGreaterThanOrEqual(100);
    expect(r.bonus).toBeGreaterThanOrEqual(currentAugBoost(s));
  });
});

describe('progress metrics', () => {
  const later = {
    ...player,
    adventure: { ...player.adventure, itopod: { lifetimePoints: 500 } },
    beastQuest: { lifetimePoints: 40 },
    res3: { res3Power: 12 },
    hacks: { hacks: [{ level: 3 }, { level: 7 }] },
    wishes: { wishes: [{ level: 1 }, { level: 0 }, { level: 2 }] },
    beards: { beards: [{ permLevel: 10, beardLevel: 99 }, { permLevel: 5 }] },
    stats: { ...player.stats, titansDefeated: 6 },
    NGU: { skills: [{ level: 3, evilLevel: 8 }, { level: 4 }], magicSkills: [{ level: 2, sadisticLevel: 1 }] },
    inventory: { ...player.inventory, macguffins: [{ id: 200, level: 4 }, { id: 0, level: 50 }, { id: 201, level: 6 }] },
  };
  const m = extractMetrics(later, 0);

  it('sums permanent progress and leaves out temporary levels and empty slots', () => {
    expect(m.ppLifetime).toBe(500);
    expect(m.qpLifetime).toBe(40);
    expect(m.res3Power).toBe(12);
    expect(m.hackLevels).toBe(10);
    expect(m.wishLevels).toBe(3);
    expect(m.beardPermLevels).toBe(15);
    expect(m.macguffinLevels).toBe(10);
    expect(m.titanKills).toBe(6);
    expect(m.nguLevels).toBe(9);
    expect(m.nguEvilLevels).toBe(8);
    expect(m.nguSadisticLevels).toBe(1);
    expect(m.nguLevelsByDifficulty.evil).toEqual([[8, 0], [0]]);
  });

  it('records milestone sources by name', () => {
    expect(m.setsDone).toEqual(['forest']);
    expect(m.challengeClears).toEqual({ basic: 2, noAugs: 1 });
  });

  it('gives nulls rather than zeros before a feature exists', () => {
    const early = extractMetrics({ version: 1260 }, 0);
    expect([early.ppLifetime, early.qpLifetime, early.res3Power, early.hackLevels, early.titanKills, early.nguEvilLevels]).toEqual([null, null, null, null, null, null]);
  });
});

describe('milestones', () => {
  const at = (day: number, extra: Partial<Row>): Row =>
    ({ id: `s${day}`, savedAt: day * 86_400_000, difficulty: 0, setsDone: [], challengeClears: {}, ...extra }) as Row;

  it('reports what each save reached first, against the best seen so far', () => {
    const rows = [
      at(1, { setsDone: ['forest'], challengeClears: { basic: 1 } }),
      at(2, { setsDone: ['forest', 'HSB'], challengeClears: { basic: 2, 'evil:troll': 1 } }),
      // An older backup imported later: nothing here is new.
      at(3, { setsDone: ['forest'], challengeClears: { basic: 1 } }),
      at(4, { setsDone: ['forest', 'HSB', 'tutorialCube'], challengeClears: { basic: 2, level: 1 }, difficulty: 1 }),
    ];
    expect(milestones(rows).map((m) => `${m.rowId} ${m.label}`)).toEqual([
      's2 Maxed the HSB set',
      's2 Basic challenge, clear 2',
      's2 Evil Troll challenge, clear 1',
      's4 Maxed the tutorial cube set',
      's4 100 Levels challenge, clear 1',
      's4 Reached Evil difficulty',
    ]);
  });

  it('treats the first save as the baseline', () => {
    expect(milestones([at(1, { setsDone: ['forest'] })])).toEqual([]);
    expect(milestones([])).toEqual([]);
  });
});

describe('rates and NGU targets', () => {
  const DAY = 86_400_000;
  const ngus = (normal: number[]) => ({ normal: [normal, []], evil: [[], []], sadistic: [[], []] });
  const row = (t: number, extra: Partial<Row>): Row => ({ id: String(t), savedAt: t, ...extra }) as Row;

  it('measures per day across the period, and needs 12 hours between saves', () => {
    const rows = [row(0, { ppLifetime: 100 }), row(DAY, { ppLifetime: 150 }), row(3 * DAY, { ppLifetime: 250 })];
    expect(perDay(rows, (r) => r.ppLifetime, 7)).toBe(50);
    expect(perDay(rows, (r) => r.ppLifetime, 2)).toBe(50); // day 1 to day 3
    expect(span([row(0, {}), row(DAY / 4, {})], 7)).toBeNull();
  });

  it('projects time to a target from the levels gained, with costs rising one unit per level', () => {
    const rows = [row(0, { nguLevelsByDifficulty: ngus([0]) as any }), row(DAY, { nguLevelsByDifficulty: ngus([10]) as any })];
    const [augments] = nguRates(rows, 'normal', 7);
    expect(augments.perDay).toBe(10);
    expect(augments.fullSpeed).toBe(false);
    // Levels 0 to 10 cost 55 units in a day; 10 to 20 cost 155.
    expect(secondsToTarget(augments, 20)! / 86_400).toBeCloseTo(155 / 55);
    expect(secondsToTarget(augments, 5)).toBe(0);
  });

  it('caps at one level per tick, and reports NGUs that are not moving', () => {
    const rows = [row(0, { nguLevelsByDifficulty: ngus([0, 7]) as any }), row(DAY, { nguLevelsByDifficulty: ngus([50 * 86_400, 7]) as any })];
    const [fast, idle] = nguRates(rows, 'normal', 7);
    expect(fast.fullSpeed).toBe(true);
    expect(secondsToTarget(fast, fast.level + 5000)).toBe(100);
    expect(secondsToTarget(idle, 1000)).toBeNull();
  });

  it('suggests the next round target, up to the hard cap', () => {
    expect(defaultTarget(0)).toBe(1000);
    expect(defaultTarget(1000)).toBe(10_000);
    expect(defaultTarget(2e9)).toBe(1e9);
  });
});

describe('cooking solver', () => {
  const ing = (propertyIndex: number, curLevel: number, targetLevel: number, unlocked = true) =>
    ({ propertyIndex, curLevel, targetLevel, weight: 10, pairedWeight: 20, unlocked });
  const cooking = (ingredients: any[]) => ({
    cooking: {
      unlocked: true,
      curDishIndex: 1,
      ingredients,
      pair1: [0, 1], pair2: [2, 3], pair3: [4, 5], pair4: [6, 7],
      pair1Target: 20, pair2Target: 10, pair3Target: 30, pair4Target: 0,
    },
  });
  const p = cooking([ing(0, 0, 5), ing(14, 0, 15), ing(3, 7, 4), ing(1, 2, 6), ing(2, 0, 18), ing(4, 0, 12), ing(5, 3, 0, false), ing(6, 3, 0, false)]);
  const dish = readDish(p)!;

  it('reads the dish, with names and amounts in the game units', () => {
    expect(dish.name).toBe('Apple Pie');
    const rows = ingredientRows(dish, bestPlan(dish));
    expect(rows[0]).toMatchObject({ name: 'Hot Sauce', unit: 'ml', now: 0 });
    expect(rows[2]).toMatchObject({ name: 'Rice', unit: 'Cups', now: 14 }); // 2 cups per level
  });

  it('finds levels that hit every target when they agree', () => {
    const [first] = bestPlan(dish);
    // Targets 5 and 15 add up to the pair target of 20, so both can be met at once.
    expect([first.levelA, first.levelB]).toEqual([5, 15]);
  });

  it('scores the best plan at 100%, and the current levels below it', () => {
    const plan = bestPlan(dish);
    const best = optimalScore(plan);
    const levels = new Map(plan.flatMap((x) => [[x.pair.a, x.levelA], [x.pair.b, x.levelB]] as const));
    const solved = { ...dish, ingredients: dish.ingredients.map((i, k) => ({ ...i, level: levels.get(k) ?? i.level })) };
    expect(quality(currentScore(solved), best)).toBe(1);
    expect(quality(currentScore(dish), best)).toBeLessThan(1);
  });

  it('beats every other combination for each pair', () => {
    const plan = bestPlan(dish);
    for (const x of plan.slice(0, 3)) {
      for (let a = 0; a <= 20; a++) {
        for (let b = 0; b <= 20; b++) {
          const trial = { ...dish, pairs: [x.pair], ingredients: dish.ingredients.map((i, k) => ({ ...i, level: k === x.pair.a ? a : k === x.pair.b ? b : i.level })) };
          expect(currentScore(trial)).toBeLessThanOrEqual(x.score);
        }
      }
    }
  });

  it('leaves locked ingredients alone, and a fully locked pair scores nothing', () => {
    const last = bestPlan(dish)[3];
    expect([last.levelA, last.levelB, last.score]).toEqual([3, 3, 0]);
  });

  it('keeps quality between 1% and 100%', () => {
    expect(quality(0, 0)).toBe(0.01);
    expect(quality(0, 50)).toBe(0.01);
    expect(quality(60, 50)).toBe(1);
  });

  it('returns nothing before cooking is unlocked', () => {
    expect(readDish({})).toBeNull();
    expect(readDish({ cooking: { unlocked: false, ingredients: [] } })).toBeNull();
  });
});

describe.skipIf(!existsSync(COOK_ORACLE))('cooking against the game code', () => {
  const cases: any[] = existsSync(COOK_ORACLE) ? JSON.parse(readFileSync(COOK_ORACLE, 'utf8')) : [];
  it.each(cases.map((c, i): [number, any] => [i, c]))('dish %i', (_, c) => {
    const p = {
      cooking: {
        unlocked: true,
        ingredients: c.ingredients,
        ...Object.fromEntries(c.pairs.map((pair: number[], k: number) => [`pair${k + 1}`, pair])),
        ...Object.fromEntries(c.targets.map((t: number, k: number) => [`pair${k + 1}Target`, t])),
      },
    };
    const dish = readDish(p)!;
    const best = optimalScore(bestPlan(dish));
    expect(currentScore(dish)).toBeCloseTo(c.cur, 4);
    expect(best).toBeCloseTo(c.opt, 4);
    expect(quality(currentScore(dish), best)).toBeCloseTo(c.pct, 6);
  });
});

describe('checklists', () => {
  it('lists clears per difficulty reached, and the next clear at the current one', () => {
    const p = {
      settings: { rebirthDifficulty: 1 },
      challenges: {
        basicChallenge: { curCompletions: 5, curEvilCompletions: 2 },
        trollChallenge: { curCompletions: 7, curEvilCompletions: 3 },
        hour24Challenge: { curCompletions: 10, curEvilCompletions: 9 },
        laserSwordChallenge: { curCompletions: 20, curEvilCompletions: 20 },
      },
    };
    expect(difficultyReached(p)).toBe(1);
    expect(challengeRows(p)).toEqual([
      { name: 'Basic', clears: [5, 2], max: 5, next: 'Beat boss 58' },
      { name: '24 Hour', clears: [10, 9], max: 10, next: 'Beat boss 292 within 24 hours' },
      { name: 'Troll', clears: [7, 3], max: 7, next: 'Beat boss 114' },
      { name: 'Laser Sword', clears: [20, 20], max: 20, next: null },
    ]);
  });

  it('counts a difficulty as reached once any challenge was cleared there', () => {
    expect(difficultyReached({ challenges: { blindChallenge: { curSadisticCompletions: 1 } } })).toBe(2);
    expect(difficultyReached({})).toBe(0);
  });

  it('caps the 24 Hour target at boss 300', () => {
    const [row] = challengeRows({ challenges: { hour24Challenge: { curCompletions: 9 } } });
    expect(row.next).toBe('Beat boss 292 within 24 hours');
    const [late] = challengeRows({ settings: { rebirthDifficulty: 2 }, challenges: { hour24Challenge: { curSadisticCompletions: 9 } } });
    expect(late.next).toBe('Beat boss 292 within 24 hours');
  });

  it('marks set items as maxed, found or missing, with the best level held anywhere', () => {
    const dropped: boolean[] = [];
    const maxxed: boolean[] = [];
    // Sewers: 40-46. 40 maxed, 41 and 42 found, the rest not yet.
    dropped[40] = dropped[41] = dropped[42] = true;
    maxxed[40] = true;
    const p = {
      inventory: {
        head: { id: 41, level: 12 },
        inventory: [{ id: 41, level: 30 }],
        daycare: [{ id: 40, level: 100 }],
        accs: [],
        itemList: { itemDropped: dropped, itemMaxxed: maxxed, trainingComplete: true },
      },
    };
    const rows = setRows(p);
    const sewers = rows.find((s) => s.flag === 'sewersComplete')!;
    expect(sewers.items.slice(0, 4)).toEqual([
      { id: 40, state: 'maxed', level: 100 },
      { id: 41, state: 'found', level: 30 },
      { id: 42, state: 'found', level: null },
      { id: 43, state: 'missing', level: null },
    ]);
    expect(setsInProgress(rows).map((s) => s.flag)).toEqual(['sewersComplete']);
    expect(rows.find((s) => s.flag === 'trainingComplete')!.complete).toBe(true);
  });

  it('names every item in every set', () => {
    expect(ITEM_SETS.length).toBe(68);
    for (const [, name, ids] of ITEM_SETS) {
      expect(name).toBeTruthy();
      for (const id of ids) expect(ITEM_NAMES[id], `item ${id}`).toBeTruthy();
    }
  });
});

describe.skipIf(!existsSync(REBIRTH_ORACLE) || !existsSync(GUFF_ORACLE))('rebirth gains against the game code', () => {
  const rebirth = existsSync(REBIRTH_ORACLE) ? JSON.parse(readFileSync(REBIRTH_ORACLE, 'utf8')) : { beards: [], macguffin: [] };
  const guff = existsSync(GUFF_ORACLE) ? JSON.parse(readFileSync(GUFF_ORACLE, 'utf8')) : { bonus: [] };

  it('matches the beard time factor and permanent levels gained', () => {
    for (const r of rebirth.beards) {
      const factor = beardTimeFactor(r.hours * 3600, r.perk);
      expect(factor).toBeCloseTo(r.timeFactor, 9);
      expect(beardGain(r.level, factor)).toBe(r.added);
    }
  });

  it('matches the MacGuffin time factor', () => {
    for (const r of rebirth.macguffin) expect(macguffinTimeFactor(r.seconds, false)).toBeCloseTo(r.timeFactor, 5);
  });

  it('matches the bonus each MacGuffin adds, including its softcap', () => {
    for (const r of guff.bonus) {
      const gain = macguffinGain(r.item, r.level, macguffinTimeFactor(r.seconds, false));
      expect(gain / r.added).toBeCloseTo(1, 5);
    }
  });
});

describe('rebirth length', () => {
  it('banks no MacGuffin bonus before 3 minutes, peaks per hour at 30, and caps at 20', () => {
    expect(macguffinTimeFactor(179, false)).toBe(0);
    expect(macguffinTimeFactor(900, false)).toBeCloseTo(0.25);
    expect(macguffinTimeFactor(1800, false)).toBe(1);
    expect(macguffinTimeFactor(1e9, false)).toBe(20);
  });

  it('keeps growing on Sadistic with two Sadistic Troll clears', () => {
    expect(macguffinTimeFactor(86_400, true)).toBeCloseTo(48);
    expect(macguffinTimeFactor(2 * 86_400, true)).toBeCloseTo(48 * 2 ** 0.4, 4);
    expect(macguffinTimeFactor(1e9, true)).toBeCloseTo(104.86, 4);
  });

  it('reaches the full beard factor sooner with the perk', () => {
    expect(beardTimeFactor(3599, 0)).toBe(0);
    expect(beardTimeFactor(24 * 3600, 0)).toBe(8);
    expect(beardTimeFactor(21 * 3600, 3)).toBe(8);
  });

  const save = {
    rebirthTime: { totalseconds: 12 * 3600 },
    beards: { beards: [{ beardLevel: 40_000, permLevel: 500, active: true }, { beardLevel: 9_000, active: false }] },
    inventory: { macguffins: [{ id: 198, level: 9 }, { id: 0 }], macguffinBonuses: [1.5] },
    arbitrary: { macGuffinBooster1Time: { totalseconds: 600 }, macGuffinBooster1InUse: true },
  };

  it('reads active beards, equipped MacGuffins and the booster', () => {
    const s = readRebirth(save);
    expect(s.beards).toEqual([{ index: 0, effect: 'Attack/Defense', temp: 40_000, perm: 500 }]);
    expect(s.guffs).toEqual([{ itemId: 198, level: 9, bonus: 1.5 }]);
    expect(s.boost).toBe(2);
  });

  it('banks exactly what the game would on rebirthing now', () => {
    const now = gainsAt(readRebirth(save), 12 * 3600);
    expect(now.beardLevels).toBe(Math.floor(200 * 4)); // sqrt(40000) x factor 4
    expect(now.guffFactor).toBeCloseTo(Math.sqrt(24) * 2, 5);
  });

  it('favours 30 minutes for MacGuffins and a full day for beards', () => {
    const rows = compareLengths(readRebirth(save));
    const best = (key: 'guffShare' | 'beardShare') => rows.find((r) => r[key] === 1)!.seconds / 3600;
    expect(best('guffShare')).toBe(0.5);
    expect(best('beardShare')).toBe(24);
  });
});

describe.skipIf(!existsSync(DIGGER_ORACLE))('gold diggers against the game code', () => {
  const cases: any[] = existsSync(DIGGER_ORACLE) ? JSON.parse(readFileSync(DIGGER_ORACLE, 'utf8')) : [];
  it.each(cases.map((c, i): [number, any] => [i, c]))('state %i', (_, c) => {
    const p = {
      diggers: { diggers: c.diggers },
      challenges: { timeMachineChallenge: { curCompletions: c.tm } },
      inventory: { itemList: { partyComplete: c.party } },
    };
    const diggers = readDiggers(p);
    const levels = levelBonus(p, diggers);
    expect(levels).toBeCloseTo(c.levelBonus, 5);
    diggers.forEach((d, i) => {
      expect(upgradeCost(i, d.maxLevel) / c.upgradeCost[i]).toBeCloseTo(1, 9);
      expect(d.active ? bonusAt(i, d.level, levels) / c.bonus[i] : c.bonus[i]).toBeCloseTo(1, 4);
    });
  });
});

describe('gold diggers', () => {
  const diggers = Array.from({ length: 12 }, () => ({ maxLevel: 0, curLevel: 0, active: false }));
  diggers[0] = { maxLevel: 20, curLevel: 10, active: true };
  diggers[2] = { maxLevel: 8, curLevel: 3, active: true };
  diggers[4] = { maxLevel: 5, curLevel: 0, active: false };
  const p = { diggers: { diggers }, purchases: { hasDiggerSlot1: true }, adventure: { itopod: { perkLevel: Object.assign([], { 52: 1 }) } } };

  it('drains more per level, and nothing at level 0', () => {
    expect(drainAt(0, 0)).toBe(0);
    expect(drainAt(0, 1)).toBe(1e12);
    expect(drainAt(0, 3)).toBe(1e12 * 1.5 ** 2);
    expect(drainAt(4, 2)).toBe(1e15 * 1.75);
  });

  it('counts slots from purchases and perks', () => {
    expect(diggerSlots(p)).toBe(3);
    expect(diggerSlots({})).toBe(1);
  });

  it('finds the highest level the gold left over can run, up to the upgrade level', () => {
    const income = drainAt(0, 10) + drainAt(2, 3) + 1;
    const plan = planDiggers(p, income);
    expect(plan.drain).toBe(drainAt(0, 10) + drainAt(2, 3));
    const [drop, , stat, , energyNgu] = plan.rows;
    // Exactly what it runs at now fits, with 1 gold to spare.
    expect(drop.affordable).toBe(10);
    expect(stat.affordable).toBe(3);
    // The Energy NGU digger would need 1e15 a second for level 1.
    expect(energyNgu.affordable).toBe(0);
    expect(planDiggers(p, 1e30).rows[0].affordable).toBe(20);
  });

  it('gives the Stat digger the cube of its level, and inactive diggers nothing', () => {
    const plan = planDiggers(p, 1e30);
    expect(plan.rows[2].bonus).toBeCloseTo((2 + 27 * 0.01) * plan.levels, 4);
    expect(plan.rows[4].bonus).toBe(1);
    expect(plan.levels).toBeCloseTo(1 + 33 * 0.0005, 6);
  });

  it('times the next upgrade at the income left after drain', () => {
    const plan = planDiggers(p, drainAt(0, 10) + drainAt(2, 3) + 1e14);
    expect(plan.rows[0].secondsToNext).toBeCloseTo(upgradeCost(0, 20) / 1e14, 0);
    expect(planDiggers(p, 0).rows[0].secondsToNext).toBeNull();
  });
});

describe.skipIf(!existsSync(HACK_ORACLE))('hacks against the game code', () => {
  const cases: any[] = existsSync(HACK_ORACLE) ? JSON.parse(readFileSync(HACK_ORACLE, 'utf8')) : [];
  const where: Record<string, (p: any, i: number, v: number) => void> = {
    p: (p, i, v) => (p.adventure.itopod.perkLevel[i] = v),
    q: (p, i, v) => (p.beastQuest.quirkLevel[i] = v),
    w: (p, i, v) => (p.wishes.wishes[i] = { level: v }),
  };
  it.each(cases.map((c, i): [number, any] => [i, c]))('state %i', (_, c) => {
    const p: any = { hacks: { hacks: c.hacks }, adventure: { itopod: { perkLevel: [] } }, beastQuest: { quirkLevel: [] }, wishes: { wishes: [] } };
    for (const [key, v] of Object.entries(c.reducers)) where[key[0]](p, Number(key.slice(1)), v as number);
    readHacks(p).forEach((h, i) => {
      expect(h.threshold).toBe(c.threshold[i]);
      // The game computes in single precision, which drifts in the 5th digit at high levels.
      expect(hackBonus(h, h.level) / c.bonus[i]).toBeCloseTo(1, 4);
      const tick = progressPerTick(i, h.level, c.hacks[i].res3, c.power, c.speed);
      if (c.perTick[i] === 0) expect(tick).toBe(0);
      else expect(tick / c.perTick[i]).toBeCloseTo(1, 5);
    });
  });
});

describe('hackday planner', () => {
  const p = {
    hacks: { hacks: Array.from({ length: 16 }, (_, i) => ({ level: i === 0 ? 18 : 0, progress: i === 0 ? 0.5 : 0 })) },
    beastQuest: { quirkLevel: Object.assign([], { 57: 2 }) },
  };
  const hacks = readHacks(p);
  const res = { r3: 1e5, power: 10, speed: 1 };

  it('reduces milestone sizes and steps to the next milestone', () => {
    expect(hacks[0].threshold).toBe(8);
    expect(nextMilestone(hacks[0], 18)).toBe(24);
    expect(nextMilestone(hacks[0], 24)).toBe(32);
    expect(hackBonus(hacks[0], 24)).toBeCloseTo((1 + 24 * 0.025) * 1.025 ** 3, 5);
  });

  it('times each level from its cost, starting from the saved progress', () => {
    // Attack/Defense level 18 with half its progress done, then 19.
    const slow = { r3: 1e5, power: 10, speed: 1 };
    const tick = (level: number) => progressPerTick(0, level, slow.r3, slow.power, slow.speed);
    expect(tick(19)).toBeLessThan(1);
    const expected = (0.5 / tick(18) + 1 / tick(19)) / 50;
    expect(secondsTo(hacks[0], 20, slow)! / expected).toBeCloseTo(1, 9);
    expect(secondsTo(hacks[0], 18, res)).toBe(0);
    expect(secondsTo(hacks[1], 5, { ...res, r3: 0 })).toBeNull();
  });

  it('never gains more than one level a tick', () => {
    expect(secondsTo(hacks[1], 100, { r3: 1e30, power: 1, speed: 1 })).toBeCloseTo(100 / 50);
  });

  it('runs Hack Hack first and speeds the others up by its gain', () => {
    const target = nextMilestone(hacks[HACK_HACK], 0);
    const plan = planHackday(hacks, { [HACK_HACK]: target, 0: 24 }, res);
    expect(plan.speedup).toBeCloseTo(hackBonus(hacks[HACK_HACK], target) / hackBonus(hacks[HACK_HACK], 0), 6);
    expect(plan.rows[0].seconds!).toBeCloseTo(secondsTo(hacks[0], 24, { ...res, speed: plan.speedup })!, 6);
    expect(plan.total).toBeCloseTo(plan.rows[0].seconds! + plan.rows[HACK_HACK].seconds!, 6);
  });
});

describe.skipIf(!existsSync(WISH_ORACLE))('wishes against the game code', () => {
  const cases: any[] = existsSync(WISH_ORACLE) ? JSON.parse(readFileSync(WISH_ORACLE, 'utf8')) : [];
  it.each(cases.map((c, i): [number, any] => [i, c]))('state %i', (_, c) => {
    const p = { adventure: { itopod: { perkLevel: Object.assign([], { 109: c.perks['109'], 110: c.perks['110'] }) } }, beastQuest: { quirkLevel: Object.assign([], { 54: c.quirk54 }) } };
    const minSeconds = minimumWishSeconds(p);
    expect(1 / (minSeconds * 50)).toBeCloseTo(c.minTime, 12);
    for (const w of c.wishes) {
      const inputs = { energy: [c.energyPower, w.energy], magic: [c.magicPower, w.magic], res3: [c.res3Power, w.res3], speed: c.speed } as any;
      const raw = rawProgressPerTick(w.id, w.level, inputs);
      // The game's single-precision maths rounds the very smallest speeds to 0.
      if (w.raw !== 0) expect(raw / w.raw).toBeCloseTo(1, 4);
      expect(wishProgressPerTick(w.id, w.level, inputs, minSeconds)).toBeCloseTo(w.perTick, 12);
    }
  });
});

describe('wish planner', () => {
  const big = { energy: [1e15, 1e15], magic: [1e14, 1e14], res3: [1e9, 1e12], speed: 1 } as any;

  it('lowers the minimum time 24 seconds per perk or quirk level', () => {
    expect(minimumWishSeconds({})).toBe(14_400);
    expect(minimumWishSeconds({ adventure: { itopod: { perkLevel: Object.assign([], { 109: 5, 110: 2 }) } }, beastQuest: { quirkLevel: Object.assign([], { 54: 3 }) } })).toBe(14_400 - 240);
  });

  it('counts wish slots, up to four', () => {
    expect(wishSlots({})).toBe(1);
    expect(wishSlots({ challenges: { trollChallenge: { curEvilCompletions: 7 } }, inventory: { itemList: { pinkHeartComplete: true } }, beastQuest: { quirkLevel: Object.assign([], { 56: 1 }) } })).toBe(4);
  });

  it('lists only unmaxed wishes at difficulties reached, and caps each level at the minimum time', () => {
    const p = { wishes: { wishes: [{ level: 1 }, { level: 2, progress: 0.5, energy: 10 }] } };
    const rows = wishRows(p, big, 1);
    expect(rows.every((r) => r.difficulty === 1)).toBe(true);
    expect(rows.some((r) => r.id === 0)).toBe(false); // wish 0 has one level, already bought
    const second = rows.find((r) => r.id === 1)!;
    expect(second.running).toBe(true);
    expect(second.atMinimum).toBe(true);
    // Half a level left at the 4 hour minimum, then 7 more whole levels.
    expect(second.nextSeconds).toBeCloseTo(7200);
    expect(second.maxSeconds).toBeCloseTo(7200 + 7 * 14_400);
    expect(second.shareNeeded).toBeLessThan(1);
    expect(wishRows(p, big, 2).length).toBeGreaterThan(rows.length);
  });

  it('says how much less would still hit the minimum time', () => {
    const [row] = wishRows({}, big, 1).filter((r) => r.id === 1);
    const scaled = { energy: [1e15, 1e15 * row.shareNeeded], magic: [1e14, 1e14 * row.shareNeeded], res3: [1e9, 1e12 * row.shareNeeded], speed: 1 } as any;
    expect(rawProgressPerTick(1, 0, scaled) * 14_400 * 50).toBeCloseTo(1, 3);
  });

  it('stalls a level slower than about 7 and three quarter days, as single precision progress does', () => {
    // Pick resources so wish 1's first level takes just over and just under that.
    const at = (scale: number) => ({ energy: [1e10, 1e10 * scale], magic: [1e9, 1e9 * scale], res3: [1e5, 1e6 * scale], speed: 1 }) as any;
    const limit = 1 / (2 ** -25 * 50);
    const rawSeconds = (scale: number) => 1 / rawProgressPerTick(1, 0, at(scale)) / 50;
    let scale = 1e-9;
    expect(rawSeconds(scale)).toBeGreaterThan(limit);
    while (rawSeconds(scale) > limit) scale *= 1.01;
    expect(wishRows({}, at(scale), 1).find((r) => r.id === 1)!.nextSeconds).not.toBeNull();
    expect(wishRows({}, at(scale / 1.1), 1).find((r) => r.id === 1)!.nextSeconds).toBeNull();
    // The guide measured 7d 17h 12m in game; 2^-25 a tick gives 7d 18h 24m.
    expect(limit / 86_400).toBeCloseTo(7.77, 2);
  });

  it('reports wishes that would never move', () => {
    const tiny = { energy: [1, 1], magic: [1, 1], res3: [1, 1], speed: 1 } as any;
    const row = wishRows({}, tiny, 1).find((r) => r.id === 1)!;
    expect(row.nextSeconds).toBeNull();
    expect(row.maxSeconds).toBeNull();
    expect(row.stallLevel).toBe(0);
  });

  it('has a name and limits for every wish', () => {
    expect(WISHES.length).toBe(231);
    for (const [name, difficulty, max, divider] of WISHES) {
      expect(name).toBeTruthy();
      expect([1, 2]).toContain(difficulty);
      expect(max).toBeGreaterThan(0);
      expect(divider).toBeGreaterThan(0);
    }
  });
});
