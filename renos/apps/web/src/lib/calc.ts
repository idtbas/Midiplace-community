/**
 * Rechner: sicherer Ausdrucksparser (rekursiver Abstieg, kein eval).
 *
 * Unterstützt: + − × ÷ (auch * / x :), %, ^ (Potenz), Klammern, Dezimalkomma oder -punkt,
 * unäres Minus, Konstanten pi/π und e, Funktionen sqrt/√, sin, cos, tan, asin, acos, atan,
 * ln, log (Basis 10), abs, round, floor, ceil, sowie `ans` (letztes Ergebnis).
 * Winkel in Grad oder Bogenmaß (Option).
 */

export class CalcError extends Error {}

export interface CalcOptions {
  degrees?: boolean;
  ans?: number;
}

type Token = { type: 'num'; value: number } | { type: 'op'; value: string } | { type: 'id'; value: string } | { type: 'lp' } | { type: 'rp' };

const FUNCTIONS: Record<string, (x: number, deg: boolean) => number> = {
  sqrt: (x) => Math.sqrt(x),
  '√': (x) => Math.sqrt(x),
  sin: (x, d) => Math.sin(d ? (x * Math.PI) / 180 : x),
  cos: (x, d) => Math.cos(d ? (x * Math.PI) / 180 : x),
  tan: (x, d) => Math.tan(d ? (x * Math.PI) / 180 : x),
  asin: (x, d) => (d ? (Math.asin(x) * 180) / Math.PI : Math.asin(x)),
  acos: (x, d) => (d ? (Math.acos(x) * 180) / Math.PI : Math.acos(x)),
  atan: (x, d) => (d ? (Math.atan(x) * 180) / Math.PI : Math.atan(x)),
  ln: (x) => Math.log(x),
  log: (x) => Math.log10(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const s = input.replace(/\s+/g, '');
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/[0-9.,]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.,]/.test(s[j]!)) j += 1;
      let raw = s.slice(i, j);
      // Dezimalkomma; Tausenderpunkte („1.234,5“) werden entfernt.
      if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
      if ((raw.match(/\./g) ?? []).length > 1 || raw === '.') throw new CalcError(`Ungültige Zahl „${s.slice(i, j)}“`);
      // Exponent (1e3, 2.5E-4)
      if ((s[j] === 'e' || s[j] === 'E') && /[0-9+-]/.test(s[j + 1] ?? '') && !/[a-z]/i.test(s[j + 1] ?? '')) {
        let k = j + 1;
        if (s[k] === '+' || s[k] === '-') k += 1;
        if (/[0-9]/.test(s[k] ?? '')) {
          while (k < s.length && /[0-9]/.test(s[k]!)) k += 1;
          raw += s.slice(j, k);
          j = k;
        }
      }
      tokens.push({ type: 'num', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[a-zπ√]/i.test(c)) {
      let j = i + 1;
      if (c !== 'π' && c !== '√') while (j < s.length && /[a-z]/i.test(s[j]!)) j += 1;
      const id = s.slice(i, j).toLowerCase();
      // „x“ allein ist das Malzeichen (3x4).
      tokens.push(id === 'x' ? { type: 'op', value: '*' } : { type: 'id', value: id });
      i = j;
      continue;
    }
    if (c === '(') tokens.push({ type: 'lp' });
    else if (c === ')') tokens.push({ type: 'rp' });
    else if ('+-−*/×÷:^%x'.includes(c)) {
      const map: Record<string, string> = { '−': '-', '×': '*', x: '*', '÷': '/', ':': '/' };
      tokens.push({ type: 'op', value: map[c] ?? c });
    } else throw new CalcError(`Unbekanntes Zeichen „${c}“`);
    i += 1;
  }
  return tokens;
}

export function evaluate(input: string, options: CalcOptions = {}): number {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new CalcError('Kein Ausdruck');
  if (tokens.length > 500) throw new CalcError('Ausdruck zu lang');
  let pos = 0;
  const deg = options.degrees ?? false;
  const peek = () => tokens[pos];
  const isOp = (t: Token | undefined, ...ops: string[]) => t?.type === 'op' && ops.includes(t.value);

  // Ausdruck := Term (('+'|'-') Term)*
  const expr = (depth: number): number => {
    if (depth > 100) throw new CalcError('Zu tief verschachtelt');
    let value = term(depth);
    while (isOp(peek(), '+', '-')) {
      const op = (tokens[pos++] as { value: string }).value;
      const right = term(depth);
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  // Term := Faktor (('*'|'/') Faktor | implizite Multiplikation)*
  const term = (depth: number): number => {
    let value = power(depth);
    for (;;) {
      const t = peek();
      if (isOp(t, '*', '/')) {
        const op = (tokens[pos++] as { value: string }).value;
        const right = power(depth);
        if (op === '/' && right === 0) throw new CalcError('Division durch null');
        value = op === '*' ? value * right : value / right;
      } else if (t && (t.type === 'lp' || t.type === 'id' || t.type === 'num')) {
        // 2π, 3(4+1), 2 sqrt(9)
        value *= power(depth);
      } else return value;
    }
  };
  // Potenz := Unär ('^' Potenz)?   (rechtsassoziativ)
  const power = (depth: number): number => {
    const base = unary(depth);
    if (isOp(peek(), '^')) {
      pos += 1;
      return base ** power(depth + 1);
    }
    return base;
  };
  const unary = (depth: number): number => {
    if (isOp(peek(), '-')) {
      pos += 1;
      return -unary(depth + 1);
    }
    if (isOp(peek(), '+')) {
      pos += 1;
      return unary(depth + 1);
    }
    return postfix(depth);
  };
  // Prozent: 50% = 0,5
  const postfix = (depth: number): number => {
    let value = primary(depth);
    while (isOp(peek(), '%')) {
      pos += 1;
      value /= 100;
    }
    return value;
  };
  const primary = (depth: number): number => {
    const t = tokens[pos++];
    if (!t) throw new CalcError('Ausdruck unvollständig');
    if (t.type === 'num') return t.value;
    if (t.type === 'lp') {
      const value = expr(depth + 1);
      if (tokens[pos]?.type !== 'rp') throw new CalcError('Klammer nicht geschlossen');
      pos += 1;
      return value;
    }
    if (t.type === 'id') {
      if (t.value === 'pi' || t.value === 'π') return Math.PI;
      if (t.value === 'e') return Math.E;
      if (t.value === 'ans') return options.ans ?? 0;
      const fn = FUNCTIONS[t.value];
      if (!fn) throw new CalcError(`Unbekannte Funktion „${t.value}“`);
      const arg = peek()?.type === 'lp' ? primary(depth + 1) : power(depth + 1);
      return fn(arg, deg);
    }
    throw new CalcError('Unerwartetes Zeichen');
  };

  const result = expr(0);
  if (pos < tokens.length) throw new CalcError(tokens[pos]?.type === 'rp' ? 'Klammer ohne Gegenstück' : 'Unerwartetes Zeichen');
  if (!Number.isFinite(result)) throw new CalcError(Number.isNaN(result) ? 'Ergebnis nicht definiert' : 'Ergebnis zu groß');
  return result;
}

/** Ergebnis für die Anzeige: deutsch, bis zu 12 signifikante Stellen, Rundungsrauschen entfernt. */
export function formatResult(value: number): string {
  const rounded = Number(value.toPrecision(12));
  if (Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-9 && rounded !== 0)) return rounded.toExponential(8).replace('.', ',').replace(/0+e/, 'e');
  return rounded.toLocaleString('de-DE', { maximumFractionDigits: 10, useGrouping: true });
}
