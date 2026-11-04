/**
 * Minimaler Pickle-Leser für die Indizes von Ren'Py-Archiven (.rpa/.rpi).
 *
 * Unterstützt nur reine Daten (dict, list, tuple, str, bytes, int, bool, None, float) in den
 * Protokollen 0–5. Opcodes, die Objekte erzeugen oder Code aufrufen (GLOBAL, REDUCE, BUILD, …),
 * werden abgelehnt – ein Archiv kann so nie Code ausführen.
 */

export class PickleError extends Error {}

/** Python-`bytes` bzw. Python-2-`str` (Bytefolge). */
export class PyBytes {
  constructor(readonly data: Uint8Array) {}
  /** Als Text: UTF-8, bei ungültigen Folgen Latin-1 (wie Python 2 mit Dateinamen meist umging). */
  text(): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.data);
    } catch {
      return String.fromCharCode(...this.data);
    }
  }
}

export type PyValue = null | boolean | number | bigint | string | PyBytes | PyValue[] | PyTuple | PyDict;
export class PyTuple {
  constructor(readonly items: PyValue[]) {}
}
export class PyDict {
  readonly entries: Array<[PyValue, PyValue]> = [];
}

const MARK = Symbol('mark');

/**
 * Erlaubte „Aufrufe“: Python 3 schreibt `bytes` in Protokoll 2 als `__builtin__.bytes(...)` bzw.
 * `_codecs.encode(text, 'latin1')`. Beides erzeugt nur Bytes. Alles andere wird abgelehnt.
 */
class PyGlobal {
  constructor(readonly name: 'bytes' | 'encode') {}
}
const SAFE_GLOBALS: Record<string, 'bytes' | 'encode'> = {
  '__builtin__ bytes': 'bytes',
  'builtins bytes': 'bytes',
  '_codecs encode': 'encode',
};

type StackItem = PyValue | PyGlobal | typeof MARK;

const utf8 = new TextDecoder('utf-8');
const MAX_ITEMS = 5_000_000;

export function unpickle(data: Uint8Array): PyValue {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stack: StackItem[] = [];
  const memo = new Map<number, PyValue | PyGlobal>();
  let pos = 0;
  let items = 0;

  const need = (n: number) => {
    if (pos + n > data.length) throw new PickleError('unexpected end of data');
  };
  const u8 = () => {
    need(1);
    return data[pos++]!;
  };
  const u16 = () => {
    need(2);
    const v = view.getUint16(pos, true);
    pos += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const i32 = () => {
    need(4);
    const v = view.getInt32(pos, true);
    pos += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = view.getBigUint64(pos, true);
    pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PickleError('length too large');
    return Number(v);
  };
  const bytes = (n: number) => {
    need(n);
    const out = data.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const line = () => {
    const end = data.indexOf(0x0a, pos);
    if (end < 0) throw new PickleError('unterminated line');
    const out = data.subarray(pos, end);
    pos = end + 1;
    return String.fromCharCode(...out);
  };
  const push = (v: PyValue) => {
    items += 1;
    if (items > MAX_ITEMS) throw new PickleError('too many items');
    stack.push(v);
  };
  const pop = (): PyValue => {
    const v = stack.pop();
    if (v === undefined || v === MARK || v instanceof PyGlobal) throw new PickleError('stack underflow');
    return v;
  };
  const top = (): PyValue => {
    const v = stack[stack.length - 1];
    if (v === undefined || v === MARK || v instanceof PyGlobal) throw new PickleError('stack underflow');
    return v;
  };
  /** Oberstes Element für das Memo (auch erlaubte Konstruktoren). */
  const topForMemo = (): PyValue | PyGlobal => {
    const v = stack[stack.length - 1];
    if (v === undefined || v === MARK) throw new PickleError('stack underflow');
    return v;
  };
  const global = (module: string, name: string) => {
    const safe = SAFE_GLOBALS[`${module} ${name}`];
    if (!safe) throw new PickleError(`forbidden global ${module}.${name}`);
    stack.push(new PyGlobal(safe));
  };
  const reduce = () => {
    const args = pop();
    const fn = stack.pop();
    if (!(fn instanceof PyGlobal) || !(args instanceof PyTuple)) throw new PickleError('forbidden reduce');
    const [first, second] = args.items;
    if (fn.name === 'bytes') {
      if (args.items.length === 0) return push(new PyBytes(new Uint8Array(0)));
      if (Array.isArray(first) && first.every((b) => typeof b === 'number' && b >= 0 && b < 256)) return push(new PyBytes(Uint8Array.from(first as number[])));
      if (first instanceof PyBytes) return push(first);
    }
    if (fn.name === 'encode' && typeof first === 'string' && (second === 'latin1' || second === 'latin-1')) {
      return push(new PyBytes(Uint8Array.from(first, (c) => c.charCodeAt(0) & 0xff)));
    }
    throw new PickleError('forbidden reduce');
  };
  const popMark = (): PyValue[] => {
    const at = stack.lastIndexOf(MARK);
    if (at < 0) throw new PickleError('mark not found');
    const out = stack.splice(at) as StackItem[];
    out.shift();
    return out as PyValue[];
  };
  const longFromBytes = (b: Uint8Array): number | bigint => {
    if (b.length === 0) return 0;
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]!);
    if (b[b.length - 1]! & 0x80) v -= 1n << BigInt(b.length * 8);
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  };
  const parseIntText = (text: string): number | bigint | boolean => {
    const t = text.trim().replace(/L$/, '');
    if (t === '00') return false;
    if (t === '01') return true;
    if (!/^-?\d+$/.test(t)) throw new PickleError('invalid int');
    const big = BigInt(t);
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  };
  const unquote = (text: string): Uint8Array => {
    const t = text.trim();
    const q = t[0];
    if ((q !== "'" && q !== '"') || t[t.length - 1] !== q) throw new PickleError('invalid string');
    const inner = t.slice(1, -1);
    const out: number[] = [];
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i]!;
      if (c !== '\\') {
        out.push(c.charCodeAt(0) & 0xff);
        continue;
      }
      const n = inner[++i];
      if (n === 'x') {
        out.push(parseInt(inner.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (n === 'n') out.push(10);
      else if (n === 'r') out.push(13);
      else if (n === 't') out.push(9);
      else if (n !== undefined && /[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(inner.slice(i))![0];
        out.push(parseInt(oct, 8));
        i += oct.length - 1;
      } else if (n !== undefined) out.push(n.charCodeAt(0));
    }
    return Uint8Array.from(out);
  };

  for (;;) {
    const op = u8();
    switch (op) {
      case 0x80: // PROTO
        if (u8() > 5) throw new PickleError('unsupported protocol');
        break;
      case 0x95: // FRAME
        u64();
        break;
      case 0x2e: // STOP
        if (stack.length !== 1) throw new PickleError('invalid stack at STOP');
        return pop();
      case 0x28: // MARK
        stack.push(MARK);
        break;
      case 0x4e: // NONE
        push(null);
        break;
      case 0x88: // NEWTRUE
        push(true);
        break;
      case 0x89: // NEWFALSE
        push(false);
        break;
      case 0x4a: // BININT
        push(i32());
        break;
      case 0x4b: // BININT1
        push(u8());
        break;
      case 0x4d: // BININT2
        push(u16());
        break;
      case 0x8a: // LONG1
        push(longFromBytes(bytes(u8())));
        break;
      case 0x8b: // LONG4
        push(longFromBytes(bytes(u32())));
        break;
      case 0x49: // INT
        push(parseIntText(line()));
        break;
      case 0x4c: // LONG
        push(parseIntText(line()));
        break;
      case 0x47: // BINFLOAT
        need(8);
        push(view.getFloat64(pos, false));
        pos += 8;
        break;
      case 0x46: // FLOAT
        push(Number.parseFloat(line()));
        break;
      case 0x58: // BINUNICODE
        push(utf8.decode(bytes(u32())));
        break;
      case 0x8c: // SHORT_BINUNICODE
        push(utf8.decode(bytes(u8())));
        break;
      case 0x8d: // BINUNICODE8
        push(utf8.decode(bytes(u64())));
        break;
      case 0x56: // UNICODE (raw-unicode-escape)
        push(line().replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
        break;
      case 0x54: // BINSTRING
        push(new PyBytes(bytes(i32())));
        break;
      case 0x55: // SHORT_BINSTRING
        push(new PyBytes(bytes(u8())));
        break;
      case 0x53: // STRING
        push(new PyBytes(unquote(line())));
        break;
      case 0x42: // BINBYTES
        push(new PyBytes(bytes(u32())));
        break;
      case 0x43: // SHORT_BINBYTES
        push(new PyBytes(bytes(u8())));
        break;
      case 0x8e: // BINBYTES8
        push(new PyBytes(bytes(u64())));
        break;
      case 0x7d: // EMPTY_DICT
        push(new PyDict());
        break;
      case 0x5d: // EMPTY_LIST
        push([]);
        break;
      case 0x29: // EMPTY_TUPLE
        push(new PyTuple([]));
        break;
      case 0x64: {
        // DICT
        const values = popMark();
        const dict = new PyDict();
        for (let i = 0; i + 1 < values.length; i += 2) dict.entries.push([values[i]!, values[i + 1]!]);
        push(dict);
        break;
      }
      case 0x6c: // LIST
        push(popMark());
        break;
      case 0x74: // TUPLE
        push(new PyTuple(popMark()));
        break;
      case 0x85: // TUPLE1
        push(new PyTuple([pop()]));
        break;
      case 0x86: {
        // TUPLE2
        const b = pop();
        const a = pop();
        push(new PyTuple([a, b]));
        break;
      }
      case 0x87: {
        // TUPLE3
        const c = pop();
        const b = pop();
        const a = pop();
        push(new PyTuple([a, b, c]));
        break;
      }
      case 0x61: {
        // APPEND
        const value = pop();
        const list = top();
        if (!Array.isArray(list)) throw new PickleError('APPEND to non-list');
        list.push(value);
        break;
      }
      case 0x65: {
        // APPENDS
        const values = popMark();
        const list = top();
        if (!Array.isArray(list)) throw new PickleError('APPENDS to non-list');
        list.push(...values);
        break;
      }
      case 0x73: {
        // SETITEM
        const value = pop();
        const key = pop();
        const dict = top();
        if (!(dict instanceof PyDict)) throw new PickleError('SETITEM on non-dict');
        dict.entries.push([key, value]);
        break;
      }
      case 0x75: {
        // SETITEMS
        const values = popMark();
        const dict = top();
        if (!(dict instanceof PyDict)) throw new PickleError('SETITEMS on non-dict');
        for (let i = 0; i + 1 < values.length; i += 2) dict.entries.push([values[i]!, values[i + 1]!]);
        break;
      }
      case 0x70: // PUT
        memo.set(Number(line()), topForMemo());
        break;
      case 0x71: // BINPUT
        memo.set(u8(), topForMemo());
        break;
      case 0x72: // LONG_BINPUT
        memo.set(u32(), topForMemo());
        break;
      case 0x94: // MEMOIZE
        memo.set(memo.size, topForMemo());
        break;
      case 0x67: // GET
      case 0x68: // BINGET
      case 0x6a: {
        // LONG_BINGET
        const key = op === 0x67 ? Number(line()) : op === 0x68 ? u8() : u32();
        if (!memo.has(key)) throw new PickleError('memo key not found');
        const value = memo.get(key)!;
        if (value instanceof PyGlobal) stack.push(value);
        else push(value);
        break;
      }
      case 0x63: {
        // GLOBAL
        const module = line();
        global(module, line());
        break;
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = pop();
        const module = pop();
        if (typeof module !== 'string' || typeof name !== 'string') throw new PickleError('invalid global');
        global(module, name);
        break;
      }
      case 0x52: // REDUCE
        reduce();
        break;
      case 0x30: // POP
        stack.pop();
        break;
      case 0x31: // POP_MARK
        popMark();
        break;
      case 0x32: // DUP
        push(top());
        break;
      default:
        throw new PickleError(`unsupported opcode 0x${op.toString(16)}`);
    }
  }
}
