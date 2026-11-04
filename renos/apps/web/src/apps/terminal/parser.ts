/**
 * Sicherer Parser für die RenOS-Kommandozeile.
 * Zerlegt eine Eingabe in Wörter (mit '…' und "…" sowie \-Escapes). Es gibt keine Variablen,
 * keine Befehlsersetzung, keine Pipes und keine Ausführung von Code – nur interne Befehle.
 */
export type ParseResult = { ok: true; argv: string[] } | { ok: false; error: string };

export const MAX_INPUT_LENGTH = 2000;

export function tokenize(input: string): ParseResult {
  if (input.length > MAX_INPUT_LENGTH) return { ok: false, error: 'Eingabe zu lang.' };
  const argv: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length && ['"', '\\'].includes(input[i + 1]!)) {
        current += input[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
        inToken = true;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        argv.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return { ok: false, error: `Fehlendes schließendes Anführungszeichen (${quote}).` };
  if (inToken) argv.push(current);
  return { ok: true, argv };
}

/** Trennt Optionen (-l, -a, --help) von Argumenten. */
export function splitFlags(args: string[]): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let endOfFlags = false;
  for (const arg of args) {
    if (!endOfFlags && arg === '--') {
      endOfFlags = true;
    } else if (!endOfFlags && arg.startsWith('--') && arg.length > 2) {
      flags.add(arg.slice(2));
    } else if (!endOfFlags && arg.startsWith('-') && arg.length > 1) {
      for (const f of arg.slice(1)) flags.add(f);
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}
