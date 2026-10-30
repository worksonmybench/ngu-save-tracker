import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { decodeSave, MAX_SAVE_BYTES, type DecodedSave } from '../save/decode';
import type { SaveRecord } from '../save/derive';
import { extractMetrics, METRICS_VERSION } from '../save/metrics';

// IndexedDB, not sessionStorage: the charts only have value across many saves over time.
// Originals are kept (gzipped, in this browser only) because history can't be recaptured
// and new metrics can then be derived from saves imported long ago.
interface Schema extends DBSchema {
  saves: { key: string; value: SaveRecord };
  raw: { key: string; value: ArrayBuffer };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | undefined;
const db = () =>
  (dbPromise ??= openDB<Schema>('ngu-save-tracker', 1, {
    upgrade(d) {
      d.createObjectStore('saves', { keyPath: 'id' });
      d.createObjectStore('raw');
    },
  }));

const gzip = (text: string) =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
const gunzip = (buf: ArrayBuffer) =>
  new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();

export type ImportResult = { added: number; duplicates: number; failed: { name: string; reason: string }[] };
export type Incoming = { name: string; lastModified: number; text: () => Promise<string>; size: number };

type Backup = { format: 'ngu-save-tracker-backup'; version: 1; saves: { fileName: string; fileModified: number; text: string }[] };
const yieldToUi = () => new Promise((r) => setTimeout(r));

function expandBackup(name: string, text: string): Backup['saves'] | null {
  if (!text.trimStart().startsWith('{')) return null;
  let parsed: Backup;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not a valid backup`);
  }
  if (parsed.format !== 'ngu-save-tracker-backup' || !Array.isArray(parsed.saves)) {
    throw new Error(`${name} is not a valid backup`);
  }
  return parsed.saves;
}

export async function importFiles(files: Incoming[], onProgress: (done: number, total: number) => void) {
  const result: ImportResult = { added: 0, duplicates: 0, failed: [] };
  const d = await db();
  const addOne = async (fileName: string, fileModified: number, text: string) => {
    const { player, checksum } = decodeSave(text);
    if (await d.get('saves', checksum)) {
      result.duplicates++;
      return;
    }
    const compressed = await gzip(text);
    const tx = d.transaction(['saves', 'raw'], 'readwrite');
    await Promise.all([
      tx.objectStore('saves').put({ ...extractMetrics(player, fileModified), id: checksum, fileName, fileModified }),
      tx.objectStore('raw').put(compressed, checksum),
      tx.done,
    ]);
    result.added++;
  };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress(i, files.length);
    await yieldToUi();
    try {
      if (f.size > MAX_SAVE_BYTES * 16) throw new Error('file is too large');
      const text = await f.text();
      const backup = expandBackup(f.name, text);
      if (backup) {
        for (const s of backup) {
          try {
            await addOne(s.fileName, s.fileModified, s.text);
          } catch (e) {
            result.failed.push({ name: s.fileName, reason: (e as Error).message });
          }
        }
      } else {
        await addOne(f.name, f.lastModified, text);
      }
    } catch (e) {
      result.failed.push({ name: f.name, reason: (e as Error).message });
    }
  }
  onProgress(files.length, files.length);
  // Ask the browser not to evict history under storage pressure. Refusal is harmless.
  if (result.added) navigator.storage?.persist?.().catch(() => {});
  return result;
}

export async function loadSaves(): Promise<SaveRecord[]> {
  const d = await db();
  const saves = await d.getAll('saves');
  const out: SaveRecord[] = [];
  for (const s of saves) {
    if (s.metricsVersion === METRICS_VERSION) {
      out.push(s);
      continue;
    }
    const decoded = await loadDecoded(s.id);
    const next = { ...extractMetrics(decoded.player, s.fileModified), id: s.id, fileName: s.fileName, fileModified: s.fileModified };
    await d.put('saves', next);
    out.push(next);
  }
  return out;
}

export async function loadDecoded(id: string): Promise<DecodedSave> {
  const buf = await (await db()).get('raw', id);
  if (!buf) throw new Error('the original save is missing');
  return decodeSave(await gunzip(buf));
}

export async function deleteSave(id: string) {
  const tx = (await db()).transaction(['saves', 'raw'], 'readwrite');
  await Promise.all([tx.objectStore('saves').delete(id), tx.objectStore('raw').delete(id), tx.done]);
}

export async function deleteAll() {
  const tx = (await db()).transaction(['saves', 'raw'], 'readwrite');
  await Promise.all([tx.objectStore('saves').clear(), tx.objectStore('raw').clear(), tx.done]);
}

export async function exportBackup(): Promise<Blob> {
  const d = await db();
  const saves: Backup['saves'] = [];
  for (const s of await d.getAll('saves')) {
    const buf = await d.get('raw', s.id);
    if (buf) saves.push({ fileName: s.fileName, fileModified: s.fileModified, text: await gunzip(buf) });
  }
  const backup: Backup = { format: 'ngu-save-tracker-backup', version: 1, saves };
  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}
