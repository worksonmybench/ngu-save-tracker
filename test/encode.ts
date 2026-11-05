// Minimal NRBF writer for tests and demo data. Mirrors BinaryFormatter's layout: object
// members are references, with the objects written flat after the root.
import { createHash } from 'node:crypto';

const enc = new TextEncoder();

class Writer {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 255); }
  i32(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.bytes.push(...b); }
  f64(v: number) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.bytes.push(...b); }
  str(s: string) {
    const data = enc.encode(s);
    let n = data.length;
    while (n >= 0x80) { this.u8((n & 0x7f) | 0x80); n >>>= 7; }
    this.u8(n);
    for (const b of data) this.bytes.push(b);
  }
}

type Pending = { id: number; value: object };

export function nrbf(root: Record<string, unknown>, rootClass = 'PlayerData'): Buffer {
  const w = new Writer();
  w.u8(0); w.i32(1); w.i32(-1); w.i32(1); w.i32(0); // header
  w.u8(12); w.i32(2); w.str('Assembly-CSharp');
  let nextId = 2;
  const queue: Pending[] = [];
  const metaIds = new Map<string, number>();

  const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 2 ** 31;
  const typeTag = (v: unknown) => (typeof v === 'boolean' ? 'b' : isInt(v) ? 'i' : typeof v === 'number' ? 'd' : typeof v === 'string' ? 's' : 'o');
  const classOf = (v: Record<string, unknown>, fallback: string) =>
    fallback + ':' + Object.entries(v).map(([k, x]) => k + typeTag(x)).join(',');

  const writeClass = (id: number, cls: string, value: Record<string, unknown>) => {
    const key = classOf(value, cls);
    const known = metaIds.get(key);
    if (known !== undefined) {
      w.u8(1); w.i32(id); w.i32(known);
    } else {
      metaIds.set(key, id);
      w.u8(5); w.i32(id); w.str(cls);
      const names = Object.keys(value);
      w.i32(names.length);
      names.forEach((n) => w.str(n));
      const kind = (v: unknown) => (typeof v === 'number' || typeof v === 'boolean' ? 0 : typeof v === 'string' ? 1 : 2);
      names.forEach((n) => w.u8(kind(value[n])));
      names.forEach((n) => {
        const v = value[n];
        if (typeof v === 'boolean') w.u8(1);
        else if (typeof v === 'number') w.u8(isInt(v) ? 8 : 6);
      });
      w.i32(2);
    }
    for (const v of Object.values(value)) {
      if (typeof v === 'boolean') w.u8(v ? 1 : 0);
      else if (typeof v === 'number') { if (isInt(v)) w.i32(v); else w.f64(v); }
      else if (typeof v === 'string') { w.u8(6); w.i32(nextId++); w.str(v); }
      else if (v === null || v === undefined) w.u8(10);
      else {
        const child = nextId++;
        w.u8(9); w.i32(child);
        queue.push({ id: child, value: v as object });
      }
    }
  };

  const writeArray = (id: number, arr: unknown[]) => {
    if (arr.every((x) => typeof x === 'number')) {
      w.u8(15); w.i32(id); w.i32(arr.length); w.u8(6);
      arr.forEach((x) => w.f64(x as number));
      return;
    }
    if (arr.length && arr.every((x) => typeof x === 'boolean')) {
      w.u8(15); w.i32(id); w.i32(arr.length); w.u8(1);
      arr.forEach((x) => w.u8(x ? 1 : 0));
      return;
    }
    w.u8(16); w.i32(id); w.i32(arr.length);
    for (const v of arr) {
      if (v === null) w.u8(10);
      else {
        const child = nextId++;
        w.u8(9); w.i32(child);
        queue.push({ id: child, value: v as object });
      }
    }
  };

  writeClass(1, rootClass, root);
  while (queue.length) {
    const { id, value } = queue.shift()!;
    if (Array.isArray(value)) {
      // Lists serialize as List`1{_items, _size, _version}, padded to capacity.
      const items = [...value, ...(value.length && typeof value[0] === 'object' ? [null, null] : [])];
      writeClass(id, 'System.Collections.Generic.List`1[[T]]', { _items: new ArrayMarker(items), _size: value.length, _version: 1 });
    } else if (value instanceof ArrayMarker) {
      writeArray(id, value.items);
    } else {
      writeClass(id, 'Obj', value as Record<string, unknown>);
    }
  }
  w.u8(11);
  return Buffer.from(w.bytes);
}

class ArrayMarker {
  items: unknown[];
  constructor(items: unknown[]) { this.items = items; }
}

export function encodeSave(player: Record<string, unknown>): string {
  const inner = nrbf(player);
  const checksum = createHash('md5').update(inner).digest('base64');
  return nrbf({ playerData: inner.toString('base64'), checksum }, 'SaveData').toString('base64');
}
