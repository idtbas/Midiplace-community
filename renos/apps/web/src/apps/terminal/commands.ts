import { RENOS_VERSION, formatBytes, type Game } from '@renos/shared';
import { locale } from '@/i18n';
import { browserName, displayModeLabel, hasFinePointer, isStandalone } from '@/lib/platform';
import { formatDateTime } from '@/lib/format';
import type { FsNode } from '@/persistence/db';
import { HOME_ID, createFolder, displayPath, isTextFile, listChildren, readBlob, resolvePath } from '@/persistence/fs';
import type { AppId } from '@/system/appIds';
import { APP_META } from '@/system/appMeta';
import { APP_IDS } from '@/system/appIds';
import { ACCENTS, type AccentId } from '@/system/settings';
import { splitFlags } from './parser';

export type Tone = 'default' | 'muted' | 'accent' | 'error' | 'success' | 'dir' | 'bold' | 'warning';
export interface Segment {
  text: string;
  tone?: Tone;
}

export interface TerminalContext {
  cwdId: string;
  setCwd: (id: string) => void;
  userName: string;
  accent: AccentId;
  print: (text: string | Segment[], tone?: Tone) => void;
  clear: () => void;
  history: string[];
  openApp: (appId: AppId) => void;
  launchGame: (gameId: string) => Promise<void>;
  loadGames: () => Promise<{ games: Game[]; error: string | null }>;
  sessionStart: number;
}

export interface Command {
  name: string;
  summary: string;
  usage?: string;
  run: (args: string[], ctx: TerminalContext) => void | Promise<void>;
}

const APP_ALIASES: Record<string, AppId> = {
  files: 'files',
  dateien: 'files',
  library: 'library',
  bibliothek: 'library',
  spiele: 'library',
  installer: 'installer',
  settings: 'settings',
  einstellungen: 'settings',
  terminal: 'terminal',
  notes: 'notes',
  notizen: 'notes',
};

function sortNodes(nodes: FsNode[]): FsNode[] {
  return [...nodes].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, locale) : a.kind === 'folder' ? -1 : 1));
}

function quoteIfNeeded(name: string): string {
  return /\s/.test(name) ? `'${name}'` : name;
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (h) parts.push(`${h} Std.`);
  if (m || h) parts.push(`${m} Min.`);
  parts.push(`${s % 60} Sek.`);
  return parts.join(' ');
}

const LOGO = [
  '  ██████╗  ',
  '  ██╔══██╗ ',
  '  ██████╔╝ ',
  '  ██╔══██╗ ',
  '  ██║  ██║ ',
  '  ╚═╝  ╚═╝ ',
];

export const COMMANDS: Command[] = [
  {
    name: 'help',
    summary: 'Zeigt alle Befehle oder Hilfe zu einem Befehl',
    usage: 'help [befehl]',
    run: (args, ctx) => {
      if (args[0]) {
        const cmd = COMMANDS.find((c) => c.name === args[0]);
        if (!cmd) return ctx.print(`help: Unbekannter Befehl: ${args[0]}`, 'error');
        ctx.print([{ text: cmd.name, tone: 'bold' }, { text: ` – ${cmd.summary}` }]);
        if (cmd.usage) ctx.print(`Aufruf: ${cmd.usage}`, 'muted');
        return;
      }
      ctx.print('Verfügbare Befehle:', 'bold');
      for (const cmd of COMMANDS) ctx.print([{ text: cmd.name.padEnd(10), tone: 'accent' }, { text: cmd.summary }]);
      ctx.print('');
      ctx.print('Dies ist die interne RenOS-Kommandozeile. Sie führt keine Programme auf dem iPad oder dem Server aus.', 'muted');
      ctx.print('Tasten: ↑/↓ Verlauf · Tab vervollständigen · Ctrl+L leeren · Ctrl+C abbrechen', 'muted');
    },
  },
  { name: 'clear', summary: 'Leert die Anzeige', run: (_args, ctx) => ctx.clear() },
  {
    name: 'date',
    summary: 'Zeigt Datum und Uhrzeit',
    run: (_args, ctx) =>
      ctx.print(new Date().toLocaleString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })),
  },
  { name: 'whoami', summary: 'Zeigt den Benutzernamen', run: (_args, ctx) => ctx.print(ctx.userName) },
  {
    name: 'pwd',
    summary: 'Zeigt den aktuellen Ordner',
    run: async (_args, ctx) => ctx.print(await displayPath(ctx.cwdId, ctx.userName)),
  },
  {
    name: 'ls',
    summary: 'Listet Dateien und Ordner',
    usage: 'ls [-l] [pfad]',
    run: async (args, ctx) => {
      const { flags, rest } = splitFlags(args);
      const target = rest[0] ? await resolvePath(rest[0], ctx.cwdId) : await resolvePathSafe(ctx.cwdId);
      if (!target) return ctx.print(`ls: ${rest[0]}: Datei oder Ordner nicht gefunden`, 'error');
      const nodes = target.kind === 'folder' ? sortNodes(await listChildren(target.id)) : [target];
      if (nodes.length === 0) return;
      if (flags.has('l')) {
        for (const n of nodes) {
          ctx.print([
            { text: n.kind === 'folder' ? 'd ' : '- ', tone: 'muted' },
            { text: (n.kind === 'folder' ? '–' : formatBytes(n.size)).padStart(9), tone: 'muted' },
            { text: `  ${formatDateTime(n.modifiedAt)}  `, tone: 'muted' },
            { text: n.kind === 'folder' ? `${n.name}/` : n.name, tone: n.kind === 'folder' ? 'dir' : 'default' },
          ]);
        }
        return;
      }
      const segments: Segment[] = [];
      nodes.forEach((n, i) => {
        segments.push({ text: n.kind === 'folder' ? `${quoteIfNeeded(n.name)}/` : quoteIfNeeded(n.name), tone: n.kind === 'folder' ? 'dir' : 'default' });
        if (i < nodes.length - 1) segments.push({ text: '   ' });
      });
      ctx.print(segments);
    },
  },
  {
    name: 'cd',
    summary: 'Wechselt den Ordner',
    usage: 'cd [pfad]   (~ = persönlicher Ordner, .. = übergeordneter Ordner)',
    run: async (args, ctx) => {
      const target = await resolvePath(args[0] ?? '~', ctx.cwdId);
      if (!target) return ctx.print(`cd: ${args[0]}: Ordner nicht gefunden`, 'error');
      if (target.kind !== 'folder') return ctx.print(`cd: ${args[0]}: Kein Ordner`, 'error');
      ctx.setCwd(target.id);
    },
  },
  {
    name: 'cat',
    summary: 'Zeigt den Inhalt einer Textdatei',
    usage: 'cat <datei>',
    run: async (args, ctx) => {
      if (!args[0]) return ctx.print('cat: Dateiname fehlt', 'error');
      const node = await resolvePath(args[0], ctx.cwdId);
      if (!node) return ctx.print(`cat: ${args[0]}: Datei nicht gefunden`, 'error');
      if (node.kind === 'folder') return ctx.print(`cat: ${args[0]}: Ist ein Ordner`, 'error');
      if (!isTextFile(node)) return ctx.print(`cat: ${args[0]}: Keine Textdatei`, 'error');
      if (node.size > 256 * 1024) return ctx.print(`cat: ${args[0]}: Datei zu groß für die Anzeige`, 'error');
      const blob = await readBlob(node.id);
      ctx.print(blob ? await blob.text() : '');
    },
  },
  {
    name: 'mkdir',
    summary: 'Erstellt einen Ordner',
    usage: 'mkdir <name> …',
    run: async (args, ctx) => {
      if (args.length === 0) return ctx.print('mkdir: Name fehlt', 'error');
      for (const name of args) {
        try {
          await createFolder(ctx.cwdId, name);
        } catch (error) {
          ctx.print(`mkdir: ${name}: ${(error as Error).message}`, 'error');
        }
      }
    },
  },
  { name: 'echo', summary: 'Gibt Text aus', usage: 'echo [text …]', run: (args, ctx) => ctx.print(args.join(' ')) },
  { name: 'version', summary: 'Zeigt die RenOS-Version', run: (_args, ctx) => ctx.print(`RenOS ${RENOS_VERSION} · Terminal rsh ${RENOS_VERSION}`) },
  {
    name: 'apps',
    summary: 'Listet die Systemanwendungen',
    run: (_args, ctx) => {
      for (const id of APP_IDS) {
        const meta = APP_META[id];
        if (!meta.showInLauncher) continue;
        ctx.print([{ text: id.padEnd(11), tone: 'accent' }, { text: `${meta.name} – ${meta.description}` }]);
      }
    },
  },
  {
    name: 'games',
    summary: 'Listet die installierten Spiele',
    run: async (_args, ctx) => {
      const { games, error } = await ctx.loadGames();
      if (error) return ctx.print(`games: ${error}`, 'error');
      if (games.length === 0) return ctx.print('Keine Spiele installiert. Öffne den Installer mit: open installer', 'muted');
      for (const g of [...games].sort((a, b) => a.title.localeCompare(b.title, locale))) {
        ctx.print([
          { text: g.title, tone: 'bold' },
          { text: `  ${formatBytes(g.sizeBytes)} · zuletzt gespielt: ${g.lastPlayedAt ? formatDateTime(g.lastPlayedAt) : 'nie'}`, tone: 'muted' },
        ]);
      }
    },
  },
  {
    name: 'open',
    summary: 'Öffnet eine App oder startet ein Spiel',
    usage: 'open <app | spieltitel>',
    run: async (args, ctx) => {
      const target = args.join(' ').trim();
      if (!target) return ctx.print('open: App oder Spiel angeben, z. B. „open files“', 'error');
      const app = APP_ALIASES[target.toLowerCase()];
      if (app) {
        ctx.openApp(app);
        return ctx.print(`${APP_META[app].name} wird geöffnet …`, 'muted');
      }
      const { games, error } = await ctx.loadGames();
      const q = target.toLowerCase();
      const exact = games.filter((g) => g.title.toLowerCase() === q);
      const prefix = games.filter((g) => g.title.toLowerCase().startsWith(q));
      const match = exact.length === 1 ? exact[0] : prefix.length === 1 ? prefix[0] : undefined;
      if (match) {
        ctx.print(`„${match.title}“ wird gestartet …`, 'muted');
        await ctx.launchGame(match.id);
        return;
      }
      if (prefix.length > 1) {
        ctx.print(`open: „${target}“ ist mehrdeutig:`, 'error');
        for (const g of prefix) ctx.print(`  ${g.title}`, 'muted');
        return;
      }
      ctx.print(error ? `open: ${target}: unbekannt (Spiele nicht verfügbar: ${error})` : `open: ${target}: Keine App und kein Spiel mit diesem Namen`, 'error');
    },
  },
  {
    name: 'history',
    summary: 'Zeigt den Befehlsverlauf',
    run: (_args, ctx) => ctx.history.forEach((h, i) => ctx.print([{ text: String(i + 1).padStart(4), tone: 'muted' }, { text: `  ${h}` }])),
  },
  { name: 'uptime', summary: 'Laufzeit dieser RenOS-Sitzung', run: (_args, ctx) => ctx.print(`Sitzung läuft seit ${formatUptime(Date.now() - ctx.sessionStart)}`) },
  {
    name: 'neofetch',
    summary: 'Systemübersicht',
    run: async (_args, ctx) => {
      let storage = 'nicht verfügbar';
      try {
        const est = await navigator.storage?.estimate?.();
        if (est?.usage !== undefined && est.quota) storage = `${formatBytes(est.usage)} von ${formatBytes(est.quota)} (lokal)`;
      } catch {
        /* ignorieren */
      }
      const { games, error } = await ctx.loadGames();
      const info: Array<[string, string]> = [
        ['OS', `RenOS ${RENOS_VERSION} (Web-Desktop)`],
        ['Laufzeit', `${browserName()}`],
        ['Modus', displayModeLabel()],
        ['Anzeige', `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x · Fenster ${window.innerWidth}×${window.innerHeight}`],
        ['Eingabe', hasFinePointer() ? 'Zeiger (Trackpad/Maus) + Tastatur' : 'Touch'],
        ['Shell', `rsh ${RENOS_VERSION}`],
        ['Design', `Dunkel · Akzent ${ACCENTS[ctx.accent].label}`],
        ['Sitzung', formatUptime(Date.now() - ctx.sessionStart)],
        ['Apps', String(APP_IDS.filter((id) => APP_META[id].showInLauncher).length)],
        ['Spiele', error ? 'nicht verfügbar' : String(games.length)],
        ['Speicher', storage],
        ['Sprache', navigator.language],
      ];
      const header = `${ctx.userName}@renos`;
      const lines = [[{ text: header, tone: 'accent' as Tone }], [{ text: '─'.repeat(header.length), tone: 'muted' as Tone }], ...info.map(([k, v]) => [{ text: `${k}: `, tone: 'accent' as Tone }, { text: v }])];
      const height = Math.max(LOGO.length, lines.length);
      for (let i = 0; i < height; i += 1) {
        ctx.print([{ text: LOGO[i] ?? ' '.repeat(LOGO[0]!.length), tone: 'accent' }, { text: '  ' }, ...(lines[i] ?? [])]);
      }
      ctx.print('');
      ctx.print(isStandalone() ? 'Läuft als installierte Web-App.' : 'Läuft im Browser-Tab.', 'muted');
    },
  },
];

async function resolvePathSafe(id: string): Promise<FsNode | null> {
  return (await resolvePath('.', id)) ?? (await resolvePath('~', HOME_ID));
}

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Tab-Vervollständigung für Befehle (erstes Wort) und Pfade (weitere Wörter). */
export async function complete(input: string, cwdId: string): Promise<{ completed: string; options: string[] }> {
  const lastSpace = input.lastIndexOf(' ');
  if (lastSpace === -1) {
    const options = COMMANDS.map((c) => c.name).filter((n) => n.startsWith(input));
    if (options.length === 1) return { completed: `${options[0]} `, options };
    return { completed: commonPrefix(options) || input, options };
  }
  const head = input.slice(0, lastSpace + 1);
  const partial = input.slice(lastSpace + 1);
  const slash = partial.lastIndexOf('/');
  const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const namePart = slash >= 0 ? partial.slice(slash + 1) : partial;
  const dir = await resolvePath(dirPart || '.', cwdId);
  if (!dir || dir.kind !== 'folder') return { completed: input, options: [] };
  const children = await listChildren(dir.id);
  const matches = children.filter((c) => c.name.toLowerCase().startsWith(namePart.toLowerCase()));
  const names = matches.map((c) => (c.kind === 'folder' ? `${c.name}/` : c.name));
  if (names.length === 1) {
    const only = names[0]!;
    const escaped = only.replace(/ /g, '\\ ');
    return { completed: `${head}${dirPart}${escaped}${only.endsWith('/') ? '' : ' '}`, options: names };
  }
  const prefix = commonPrefix(names);
  return { completed: prefix.length > namePart.length ? `${head}${dirPart}${prefix.replace(/ /g, '\\ ')}` : input, options: names };
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const v of values.slice(1)) {
    while (!v.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  }
  return prefix;
}
