import type { PlayerData } from './decode';

export type Change = { path: string; before: unknown; after: unknown };
export type Section = { name: string; changes: Change[] };

function flatten(v: unknown, path: string, out: Map<string, unknown>) {
  if (Array.isArray(v)) {
    v.forEach((x, i) => flatten(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) flatten((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, v);
  }
}

const IGNORED = new Set(['playerName']);

// Field-by-field changes between two saves, grouped by top-level section.
export function diffSaves(a: PlayerData, b: PlayerData): Section[] {
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  flatten(a, '', before);
  flatten(b, '', after);
  const sections = new Map<string, Change[]>();
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (IGNORED.has(path)) continue;
    const x = before.get(path);
    const y = after.get(path);
    if (Object.is(x, y)) continue;
    const name = path.split(/[.[]/)[0];
    if (!sections.has(name)) sections.set(name, []);
    sections.get(name)!.push({ path, before: x, after: y });
  }
  return [...sections.entries()]
    .map(([name, changes]) => ({ name, changes }))
    .sort((p, q) => p.name.localeCompare(q.name));
}
