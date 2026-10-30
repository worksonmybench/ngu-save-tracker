import type { Metrics } from './metrics';

export type SaveRecord = Metrics & { id: string; fileName: string; fileModified: number };
export type Row = SaveRecord & { runId: number; runPeakBoss: number | null };

export type DayRow = {
  day: string;
  time: number;
  row: Row;
  expPerDay: number | null;
};

const RUN_START_TOLERANCE_MS = 180_000;

// Saves share a run when their computed run start is within 3 minutes of the previous one.
export function withRuns(saves: SaveRecord[]): Row[] {
  const sorted = [...saves].sort((a, b) => a.savedAt - b.savedAt);
  let run = 0;
  let prev: number | null = null;
  const rows: Row[] = sorted.map((s) => {
    const start = s.savedAt - (s.rebirthSeconds ?? 0) * 1000;
    if (prev === null || Math.abs(start - prev) > RUN_START_TOLERANCE_MS) run++;
    prev = start;
    return { ...s, runId: run, runPeakBoss: null };
  });
  const peaks = new Map<number, number>();
  for (const r of rows) {
    if (r.runBoss !== null) peaks.set(r.runId, Math.max(peaks.get(r.runId) ?? 0, r.runBoss));
  }
  for (const r of rows) r.runPeakBoss = peaks.get(r.runId) ?? null;
  return rows;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Last save of each local day. EXP/day is normalised by the real gap, which may span several days.
export function byDay(rows: Row[]): DayRow[] {
  const last = new Map<string, Row>();
  for (const r of rows) last.set(localDay(r.savedAt), r);
  const days = [...last.entries()];
  return days.map(([day, row], i) => {
    const prev = days[i - 1]?.[1];
    let expPerDay: number | null = null;
    if (prev && row.lifetimeExp !== null && prev.lifetimeExp !== null) {
      expPerDay = (row.lifetimeExp - prev.lifetimeExp) / ((row.savedAt - prev.savedAt) / 86_400_000);
    }
    return { day, time: row.savedAt, row, expPerDay };
  });
}
