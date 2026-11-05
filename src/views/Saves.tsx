import { useMemo, useRef, useState } from 'preact/hooks';
import { fmtDateTime, fmtInt } from '../charts/format';
import type { SaveRecord } from '../save/derive';
import { deleteAll, deleteSave, exportBackup, importFiles, type ImportResult } from '../store/db';

const SAVE_FOLDER = String.raw`%USERPROFILE%\AppData\LocalLow\NGU Industries\NGU Idle`;

export function ImportPanel({ onImported }: { onImported: (r: ImportResult) => Promise<void> }) {
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [dragging, setDragging] = useState(false);

  const run = async (list: FileList | File[] | null, fromFolder = false) => {
    let files = [...(list ?? [])];
    // A folder holds logs and other files too; only its saves are worth reporting on.
    if (fromFolder) files = files.filter((f) => /^NGU.*\.txt$/i.test(f.name));
    if (!files.length) return;
    const r = await importFiles(files, (done, total) => setProgress([done, total]));
    setProgress(null);
    await onImported(r);
  };

  return (
    <section
      class={`card dropzone${dragging ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); run(e.dataTransfer?.files ?? null); }}
    >
      <h2>Add saves</h2>
      <p class="note">
        Choose your save folder for instant history, or drop files here. On Windows it's <code>{SAVE_FOLDER}</code>.
        Each "Save Yer Game" click leaves a dated copy there.
      </p>
      <div class="actions">
        <label class="button primary">
          Choose save folder
          {/* @ts-expect-error webkitdirectory is non-standard but supported by all major browsers */}
          <input type="file" class="sr-only" webkitdirectory multiple onChange={(e) => { run(e.currentTarget.files, true); e.currentTarget.value = ''; }} />
        </label>
        <label class="button">
          Choose files
          <input type="file" class="sr-only" multiple accept=".txt,.json" onChange={(e) => { run(e.currentTarget.files); e.currentTarget.value = ''; }} />
        </label>
      </div>
      <p class="note">Saves are read and stored only in this browser. This page is set up so it can't send them anywhere.</p>
      <div aria-live="polite">
        {progress && <p class="muted">Reading save {Math.min(progress[0] + 1, progress[1])} of {progress[1]}…</p>}
      </div>
    </section>
  );
}

// Lives above the views: a first import swaps the empty state for the charts, and
// unreadable files must still be reported.
export function ImportReport({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
  return (
    <section class="card report" role="status">
      <p>
        Added {result.added}. {result.duplicates ? `${result.duplicates} already stored. ` : ''}
        {result.failed.length ? `${result.failed.length} couldn't be read.` : ''}
        {' '}<button class="link" onClick={onDismiss}>Dismiss</button>
      </p>
      {result.failed.length > 0 && (
        <ul class="error">
          {result.failed.slice(0, 10).map((f) => <li key={f.name}>{f.name}: {f.reason}</li>)}
          {result.failed.length > 10 && <li>And {result.failed.length - 10} more.</li>}
        </ul>
      )}
    </section>
  );
}

export function Saves({ saves, onChange, onImported }: { saves: SaveRecord[]; onChange: () => Promise<void>; onImported: (r: ImportResult) => Promise<void> }) {
  const sorted = useMemo(() => [...saves].sort((a, b) => b.savedAt - a.savedAt), [saves]);
  const link = useRef<HTMLAnchorElement>(null);

  const backup = async () => {
    const url = URL.createObjectURL(await exportBackup());
    const a = link.current!;
    a.href = url;
    a.download = `ngu-saves-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const removeOne = async (s: SaveRecord) => {
    if (confirm(`Delete the save from ${fmtDateTime(s.savedAt)}? This can't be undone.`)) {
      await deleteSave(s.id);
      await onChange();
    }
  };
  const removeAll = async () => {
    if (confirm(`Delete all ${saves.length} saves from this browser? This can't be undone.`)) {
      await deleteAll();
      await onChange();
    }
  };

  return (
    <div class="stack">
      <ImportPanel onImported={onImported} />
      <section class="card">
        <h2>Stored saves</h2>
        <p class="note">
          Browsers can clear site data, so back up anything you can't re-import. The backup holds your original saves,
          including your player name, so treat it like a save file. Restore it with "Choose files".
        </p>
        <div class="actions">
          <button class="button" onClick={backup}>Download backup</button>
          <button class="button danger" onClick={removeAll}>Delete all</button>
          <a ref={link} hidden />
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">Saved</th><th scope="col">File</th><th scope="col">Build</th><th scope="col">Lifetime EXP</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id}>
                  <td>{fmtDateTime(s.savedAt)}</td><td class="path">{s.fileName}</td><td>{s.build ?? '—'}</td><td>{fmtInt(s.lifetimeExp)}</td>
                  <td><button class="link" onClick={() => removeOne(s)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
