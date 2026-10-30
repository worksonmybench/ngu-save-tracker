// Data-only reader for MS-NRBF (.NET BinaryFormatter output). It never instantiates
// types named in the stream, and saves are untrusted input, so everything is bounded.
// Generic List<T> values are flattened to arrays and boxed enums to their integer.

const MAX_DEPTH = 128;
const MAX_ELEMENTS = 20_000_000;

class Obj {
  cls: string;
  fields: Record<string, unknown>;
  constructor(cls: string) {
    this.cls = cls;
    // Field names come from the file, so no prototype that "__proto__" could reach.
    this.fields = Object.create(null);
  }
}
class Ref {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
class Nulls {
  count: number;
  constructor(count: number) {
    this.count = count;
  }
}
const END = Symbol('MessageEnd');

type MemberType = [binaryType: number, info: unknown];
type ClassMeta = { name: string; names: string[]; types: MemberType[] };

const decoder = new TextDecoder('utf-8');

export class Reader {
  private view: DataView;
  private p = 0;
  private objs = new Map<number, unknown>();
  private classes = new Map<number, ClassMeta>();
  private budget = MAX_ELEMENTS;
  private bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private u8() {
    if (this.p >= this.bytes.length) throw new Error('unexpected end of data');
    return this.bytes[this.p++];
  }
  private i32() {
    const v = this.view.getInt32(this.p, true);
    this.p += 4;
    return v;
  }

  private string() {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 28) throw new Error('bad string length');
      const b = this.u8();
      n |= (b & 0x7f) << shift;
      if (b < 0x80) break;
    }
    if (n < 0 || this.p + n > this.bytes.length) throw new Error('string overruns data');
    const s = decoder.decode(this.bytes.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }

  private num(read: (offset: number) => number, size: number) {
    const v = read.call(this.view, this.p);
    this.p += size;
    return v;
  }

  private prim(t: number): unknown {
    const v = this.view;
    const at = this.p;
    switch (t) {
      case 1: return this.u8() !== 0;
      case 2: return this.u8();
      case 3: {
        const b = this.bytes[at];
        const n = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
        this.p += n;
        return decoder.decode(this.bytes.subarray(at, at + n));
      }
      case 5: case 18: return this.string();
      case 6: this.p += 8; return v.getFloat64(at, true);
      case 7: this.p += 2; return v.getInt16(at, true);
      case 8: this.p += 4; return v.getInt32(at, true);
      // Int64s become doubles: enough precision for charts, and JSON-compatible.
      case 9: case 12: case 13: this.p += 8; return Number(v.getBigInt64(at, true));
      case 10: this.p += 1; return v.getInt8(at);
      case 11: this.p += 4; return v.getFloat32(at, true);
      case 14: this.p += 2; return v.getUint16(at, true);
      case 15: this.p += 4; return v.getUint32(at, true);
      case 16: this.p += 8; return Number(v.getBigUint64(at, true));
      case 17: return null;
      default: throw new Error(`unknown primitive type ${t}`);
    }
  }

  private classInfo() {
    const oid = this.i32();
    const name = this.string();
    const count = this.i32();
    if (count < 0 || count > this.bytes.length - this.p) throw new Error('bad member count');
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(this.string());
    return { oid, name, names };
  }

  private memberTypes(count: number): MemberType[] {
    const kinds: number[] = [];
    for (let i = 0; i < count; i++) kinds.push(this.u8());
    return kinds.map((bt) => {
      if (bt === 0 || bt === 7) return [bt, this.u8()];
      if (bt === 3) return [bt, this.string()];
      if (bt === 4) {
        const name = this.string();
        return [bt, [name, this.i32()]];
      }
      return [bt, null];
    });
  }

  private members(oid: number, meta: ClassMeta, depth: number) {
    const obj = new Obj(meta.name);
    this.objs.set(oid, obj);
    meta.names.forEach((name, i) => {
      const [bt, info] = meta.types[i];
      obj.fields[name] = bt === 0 ? this.prim(info as number) : this.record(depth + 1);
    });
    return obj;
  }

  private claim(n: number) {
    if (n < 0 || n > this.bytes.length - this.p + this.budget) throw new Error('array too large');
    this.budget -= n;
    if (this.budget < 0) throw new Error('too many elements');
  }

  private fill(oid: number, total: number, depth: number, primType?: number) {
    const arr: unknown[] = [];
    this.objs.set(oid, arr);
    while (arr.length < total) {
      if (primType !== undefined) {
        arr.push(this.prim(primType));
        continue;
      }
      const v = this.record(depth + 1);
      if (v instanceof Nulls) {
        this.claim(v.count);
        for (let i = 0; i < v.count; i++) arr.push(null);
      } else arr.push(v);
    }
    return arr;
  }

  private record(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error('nesting too deep');
    for (;;) {
      const rt = this.u8();
      switch (rt) {
        case 0: this.p += 16; continue; // SerializedStreamHeader
        case 12: this.i32(); this.string(); continue; // BinaryLibrary
        case 4: case 5: { // (System)ClassWithMembersAndTypes
          const { oid, name, names } = this.classInfo();
          const types = this.memberTypes(names.length);
          if (rt === 5) this.i32();
          const meta = { name, names, types };
          this.classes.set(oid, meta);
          return this.members(oid, meta, depth);
        }
        case 2: case 3: { // (System)ClassWithMembers: untyped, every member is a record
          const { oid, name, names } = this.classInfo();
          if (rt === 3) this.i32();
          const meta = { name, names, types: names.map((): MemberType => [1, null]) };
          this.classes.set(oid, meta);
          return this.members(oid, meta, depth);
        }
        case 1: { // ClassWithId: reuses an earlier object's metadata
          const oid = this.i32();
          const meta = this.classes.get(this.i32());
          if (!meta) throw new Error('reference to unknown class metadata');
          this.classes.set(oid, meta);
          return this.members(oid, meta, depth);
        }
        case 6: { // BinaryObjectString
          const oid = this.i32();
          const s = this.string();
          this.objs.set(oid, s);
          return s;
        }
        case 8: return this.prim(this.u8()); // MemberPrimitiveTyped
        case 9: return new Ref(this.i32()); // MemberReference
        case 10: return null; // ObjectNull
        case 11: return END; // MessageEnd
        case 13: return new Nulls(this.u8());
        case 14: return new Nulls(this.i32());
        case 15: { // ArraySinglePrimitive
          const oid = this.i32();
          const n = this.i32();
          const t = this.u8();
          this.claim(n);
          return this.fill(oid, n, depth, t);
        }
        case 16: case 17: { // ArraySingleObject / ArraySingleString
          const oid = this.i32();
          const n = this.i32();
          this.claim(n);
          return this.fill(oid, n, depth);
        }
        case 7: { // BinaryArray
          const oid = this.i32();
          const kind = this.u8();
          const rank = this.i32();
          if (rank < 1 || rank > 8) throw new Error('bad array rank');
          let total = 1;
          for (let i = 0; i < rank; i++) total *= this.i32();
          if (kind >= 3 && kind <= 5) this.p += rank * 4; // lower bounds
          const bt = this.u8();
          let t: number | undefined;
          if (bt === 0 || bt === 7) t = this.u8();
          else if (bt === 3) this.string();
          else if (bt === 4) { this.string(); this.i32(); }
          this.claim(total);
          return this.fill(oid, total, depth, bt === 0 ? t : undefined);
        }
        default:
          throw new Error(`unsupported record type ${rt} at offset ${this.p - 1}`);
      }
    }
  }

  parse(): unknown {
    let root: unknown;
    let seen = false;
    while (this.p < this.bytes.length) {
      const r = this.record(0);
      if (r === END) break;
      if (!seen) {
        root = r;
        seen = true;
      }
    }
    return this.resolve(root, 0, new Map(), new Set());
  }

  private resolve(v: unknown, depth: number, memo: Map<unknown, unknown>, active: Set<unknown>): unknown {
    if (v instanceof Ref) return this.resolve(this.objs.get(v.id) ?? null, depth, memo, active);
    if (v instanceof Nulls) return null;
    if (!(v instanceof Obj) && !Array.isArray(v)) return v;
    if (memo.has(v)) return memo.get(v);
    if (active.has(v)) return null; // A cycle has no plain-data form.
    if (depth > MAX_DEPTH) throw new Error('nesting too deep');
    active.add(v);
    const next = (x: unknown) => this.resolve(x, depth + 1, memo, active);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map(next);
    } else if (v.cls.startsWith('System.Collections.Generic.List`1') && '_items' in v.fields) {
      const items = (next(v.fields._items) as unknown[] | null) ?? [];
      const size = v.fields._size;
      out = items.slice(0, typeof size === 'number' ? size : items.length);
    } else {
      const keys = Object.keys(v.fields);
      if (keys.length === 1 && keys[0] === 'value__') {
        out = v.fields.value__;
      } else {
        const obj: Record<string, unknown> = Object.create(null);
        for (const k of keys) obj[k] = next(v.fields[k]);
        out = obj;
      }
    }
    active.delete(v);
    memo.set(v, out);
    return out;
  }
}
