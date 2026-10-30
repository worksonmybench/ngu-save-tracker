import { useEffect, useMemo, useState } from 'preact/hooks';
import { fmtCompact, fmtDateTime } from '../charts/format';
import { itemName } from '../data/itemNames';
import type { PlayerData } from '../save/decode';
import type { SaveRecord } from '../save/derive';
import { gearDisabled } from '../stats/formulas';
import {
  applyChoices,
  bestLoadout,
  gearSlots,
  GOALS,
  itemShare,
  otherEffects,
  ownedOfType,
  singleSwaps,
  STAT_ROWS,
  type Choices,
  type Goal,
  type OwnedItem,
} from '../stats/gear';
import { loadDecoded } from '../store/db';

const SWAP_LIST_SIZE = 5;
const MEANINGFUL_GAIN = 1.0005;
const SAME = 0.00005;

const times = (r: number) => `×${r.toFixed(r < 10 ? 3 : 2)}`;
const pct = (v: number) => `${v.toFixed(v < 10 ? 2 : 1)}%`;

function describe(p: PlayerData, o: OwnedItem, goal: Goal) {
  const share = itemShare(p, o.item, goal);
  const shown = goal.field ? fmtCompact(share) : share.toFixed(2);
  return [itemName(o.item.id), `Lv ${o.item.level ?? 0}`, `+${shown} ${goal.label.toLowerCase()}`, o.location].join(' · ');
}

export function GearWhatIf({ saves }: { saves: SaveRecord[] }) {
  const sorted = useMemo(() => [...saves].sort((a, b) => b.savedAt - a.savedAt), [saves]);
  const [saveId, setSaveId] = useState(sorted[0].id);
  const [goalKey, setGoalKey] = useState(GOALS[0].key);
  const [player, setPlayer] = useState<PlayerData | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [error, setError] = useState('');
  const goal = GOALS.find((g) => g.key === goalKey)!;

  useEffect(() => {
    let live = true;
    setError('');
    loadDecoded(saveId)
      .then(({ player: p }) => {
        if (!live) return;
        setPlayer(p);
        setChoices({});
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [saveId]);

  const swaps = useMemo(() => (player ? singleSwaps(player, goal) : []), [player, goal]);

  if (error) return <p class="error" role="alert">Couldn't open this save: {error}</p>;
  if (!player) return <p class="muted">Reading save…</p>;

  const slots = gearSlots(player);
  const trial = applyChoices(player, choices);
  const boss = (player.bossID ?? 0) + (player.settings?.rebirthDifficulty ?? 0) * 301;
  const scaled = slots.some((s) => s.worn.item?.id && s.worn.item.bossRequired > boss);
  const refOf = (key: string, worn: string) => choices[key] ?? worn;
  const changed = slots.filter((s) => refOf(s.key, s.worn.ref) !== s.worn.ref);
  const gains = swaps.filter((s) => s.ratio > MEANINGFUL_GAIN).slice(0, SWAP_LIST_SIZE);
  const newSlots = slots.filter((s) => s.newlyUnlocked).length;

  const statRows = STAT_ROWS.map((row) => {
    const before = row.value(player);
    const after = row.value(trial);
    return { row, before, after, ratio: before && after ? after / before : 1 };
  });
  const othersBefore = otherEffects(player);
  const othersAfter = otherEffects(trial);
  const otherRows = [...othersBefore.keys()]
    .map((label) => ({ label, before: othersBefore.get(label)!, after: othersAfter.get(label)! }))
    .filter((r) => r.before > 0 || r.after > 0);

  return (
    <div class="stack">
      <section class="card">
        <h2>Try different gear</h2>
        <p class="note">
          Choose items below to see what they'd do across your stats. Nothing changes in your game.
        </p>
        <div class="filter-row">
          <label class="field">
            Save
            <select value={saveId} onChange={(e) => setSaveId(e.currentTarget.value)}>
              {sorted.map((s) => <option key={s.id} value={s.id}>{fmtDateTime(s.savedAt)}</option>)}
            </select>
          </label>
          <label class="field">
            Optimize for
            <select value={goalKey} onChange={(e) => setGoalKey(e.currentTarget.value)}>
              {GOALS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </label>
          <div class="actions">
            <button class="button primary" onClick={() => setChoices(bestLoadout(player, goal))}>Use best gear for this</button>
            <button class="button" onClick={() => setChoices({})} disabled={!changed.length}>Reset</button>
          </div>
        </div>
      </section>

      {gearDisabled(player) && <p class="warn" role="status">Gear has no effect in this save, because it's in the No Equipment challenge or gear is disabled.</p>}
      {scaled && <p class="warn">This save is at boss {boss}, so gear that needs a later boss is scaled down. Results change as a run progresses.</p>}

      <section class="card">
        <h2>Your gear</h2>
        <div class="table-wrap">
          <table class="gear-table">
            <thead><tr><th scope="col">Slot</th><th scope="col">Item</th></tr></thead>
            <tbody>
              {slots.map((s) => {
                const current = refOf(s.key, s.worn.ref);
                const usedElsewhere = new Set(slots.filter((x) => x.key !== s.key).map((x) => refOf(x.key, x.worn.ref)));
                const options = ownedOfType(player, s.itemType);
                if (!options.some((o) => o.ref === s.worn.ref)) options.unshift(s.worn);
                const selected = options.find((o) => o.ref === current);
                const mergeRisk = selected && current !== s.worn.ref && selected.item.id === s.worn.item?.id;
                return (
                  <tr key={s.key} class={current !== s.worn.ref ? 'changed' : ''}>
                    <td>{s.label}</td>
                    <td>
                      <select
                        aria-label={`Item for ${s.label}`}
                        value={current}
                        onChange={(e) => setChoices({ ...choices, [s.key]: e.currentTarget.value })}
                      >
                        {options.map((o) => (
                          <option key={o.ref} value={o.ref} disabled={usedElsewhere.has(o.ref)}>
                            {o.item?.id ? describe(player, o, goal) : 'Empty'}
                          </option>
                        ))}
                      </select>
                      {mergeRisk && <div class="note">Same item as the one worn. Dragging it on would merge them, so unequip first.</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p class="note">
          {slots.filter((s) => s.itemType === 5).length} accessory slots unlocked in this save
          {newSlots > 0 && `, including ${newSlots} the game hadn't added to the save yet`}. Daycare items aren't offered,
          because they can't be worn from there.
        </p>
      </section>

      <section class="card">
        <h2>Effect on your stats</h2>
        <p class="note">Compared with the gear worn in this save. Fighting, adventure, drop chance and NGU speed show the change only.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">Stat</th><th scope="col">Now</th><th scope="col">With these choices</th><th scope="col">Change</th></tr></thead>
            <tbody>
              {statRows.map(({ row, before, after, ratio }) => (
                <tr key={row.key} class={Math.abs(ratio - 1) > SAME ? 'changed' : ''}>
                  <td>{row.label}</td>
                  <td>{row.absolute ? fmtCompact(before) : '—'}</td>
                  <td>{row.absolute ? fmtCompact(after) : '—'}</td>
                  <td>{Math.abs(ratio - 1) > SAME ? times(ratio) : 'Same'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <h2>Other gear effects</h2>
        <p class="note">What the gear itself adds to everything else.</p>
        {otherRows.length ? (
          <div class="table-wrap">
            <table>
              <thead><tr><th scope="col">Effect</th><th scope="col">Now</th><th scope="col">With these choices</th></tr></thead>
              <tbody>
                {otherRows.map((r) => (
                  <tr key={r.label} class={Math.abs(r.after - r.before) > 1e-6 ? 'changed' : ''}>
                    <td>{r.label}</td><td>+{pct(r.before)}</td><td>+{pct(r.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">Neither loadout has any other effects.</p>
        )}
      </section>

      <section class="card">
        <h2>Best single swaps for {goal.label.toLowerCase()}</h2>
        {gains.length ? (
          <div class="table-wrap">
            <table>
              <thead><tr><th scope="col">Item</th><th scope="col">Goes in</th><th scope="col">Change</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {gains.map((g) => (
                  <tr key={g.slot.key + g.candidate.ref}>
                    <td>{describe(player, g.candidate, goal)}</td>
                    <td>{g.slot.label}</td>
                    <td>{times(g.ratio)}</td>
                    <td><button class="link" onClick={() => setChoices({ [g.slot.key]: g.candidate.ref })}>Try</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">No item in your inventory raises this on its own.</p>
        )}
      </section>
    </div>
  );
}
