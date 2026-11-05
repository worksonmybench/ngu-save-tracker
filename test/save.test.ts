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
