import { zlibSync } from 'fflate';
import { crc32 } from './crc32';

/**
 * Planung der Umwandlung von Ren'Py-Desktop-Builds (Windows, Linux, Mac) in Web-Builds.
 *
 * Ein Desktop-Build enthält dieselben Spieldaten (`game/`) wie ein Web-Build – nur die Engine ist für
 * Windows/Linux/Mac kompiliert. RenOS ersetzt sie durch die Ren'Py-Web-Laufzeit und baut die game.zip
 * so, wie es der Ren'Py-Launcher tut: Skripte und kleine Dateien kommen hinein, Bilder, Musik, Stimmen
 * und Videos werden bei Bedarf nachgeladen („Progressive Downloading“, renpyweb_remote_files.txt).
 */

export type MediaKind = 'image' | 'audio' | 'video';

export interface DesktopLayout {
  /** Ordner, der `game/` enthält (mit abschließendem „/“, oder leer für die Archivwurzel). */
  root: string;
  engineVersion: string | null;
  engineMajor: number | null;
  python: 2 | 3 | null;
  platforms: Array<'windows' | 'linux' | 'mac'>;
}

const RENPY_GAME_FILE = /\.(rpy|rpyc|rpa|rpym|rpymc|rpi)$/i;

/** Ordner mit einem Ren'Py-Spielordner `game/` (z. B. „MeinSpiel-1.0-pc/“ oder „X.app/Contents/Resources/autorun/“). */
export function findGameRoots(paths: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const p of paths) {
    const at = p.lastIndexOf('game/');
    if (at < 0 || !RENPY_GAME_FILE.test(p)) continue;
    // Jeder „game/“-Abschnitt im Pfad ist ein Kandidat (Ordner können „game“ heißen).
    let i = p.indexOf('game/');
    while (i >= 0) {
      if (i === 0 || p[i - 1] === '/') roots.add(p.slice(0, i));
      i = p.indexOf('game/', i + 1);
    }
  }
  return [...roots].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** Bevorzugt den Ordner, neben dem die Engine (`renpy/`) liegt; sonst den flachsten. */
export function chooseGameRoot(paths: string[]): string | null {
  const roots = findGameRoots(paths);
  if (!roots.length) return null;
  const set = new Set(paths);
  const hasEngine = (root: string) => paths.some((p) => p.startsWith(`${root}renpy/`)) || [...set].some((p) => p === `${root}renpy.py`);
  return roots.find(hasEngine) ?? roots.find((r) => /\/autorun\/$/.test(r)) ?? roots[0]!;
}

/** Version aus renpy/vc_version.py („version = '8.1.3.23091805'“) bzw. renpy/__init__.py (ältere Versionen). */
export function parseEngineVersion(vcVersionPy: string | null, initPy: string | null): { version: string | null; major: number | null } {
  const fromVc = vcVersionPy && /^\s*version\s*=\s*u?['"](\d+)\.(\d+)\.(\d+)/m.exec(vcVersionPy);
  if (fromVc) return { version: `${fromVc[1]}.${fromVc[2]}.${fromVc[3]}`, major: Number(fromVc[1]) };
  const fromTuple = initPy && /version_tuple\s*=\s*(?:VersionTuple)?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(initPy);
  if (fromTuple) return { version: `${fromTuple[1]}.${fromTuple[2]}.${fromTuple[3]}`, major: Number(fromTuple[1]) };
  const fromString = initPy && /^\s*version\s*=\s*u?['"]Ren'Py (\d+)\.(\d+)\.(\d+)/m.exec(initPy);
  if (fromString) return { version: `${fromString[1]}.${fromString[2]}.${fromString[3]}`, major: Number(fromString[1]) };
  return { version: null, major: null };
}

/** Python-Generation des Spiels: Ren'Py 8 = Python 3, Ren'Py 6/7 = Python 2. */
export function detectPython(paths: string[], root: string, engineMajor: number | null): 2 | 3 | null {
  const inRoot = paths.filter((p) => p.startsWith(root)).map((p) => p.slice(root.length));
  if (inRoot.some((p) => p.startsWith('lib/py3-'))) return 3;
  if (inRoot.some((p) => p.startsWith('lib/py2-'))) return 2;
  if (engineMajor !== null) return engineMajor >= 8 ? 3 : 2;
  if (inRoot.some((p) => /^renpy\/.*__pycache__\/.*\.cpython-3\d+\.pyc$/.test(p))) return 3;
  if (inRoot.some((p) => /^renpy\/.*\.pyo$/.test(p))) return 2;
  if (inRoot.some((p) => /^lib\/(windows|linux|darwin|mac)-/.test(p))) return 2;
  if (inRoot.some((p) => /^game\/cache\/bytecode-3\d+\.rpyb$/.test(p))) return 3;
  if (inRoot.some((p) => /^game\/cache\/bytecode-2\d?\.rpyb$|^game\/cache\/bytecode\.rpyb$/.test(p))) return 2;
  return null;
}

export function detectPlatforms(paths: string[], root: string): DesktopLayout['platforms'] {
  const inRoot = paths.filter((p) => p.startsWith(root)).map((p) => p.slice(root.length).toLowerCase());
  const out: DesktopLayout['platforms'] = [];
  if (inRoot.some((p) => /^[^/]+\.exe$/.test(p) || /^lib\/(py\d-)?windows/.test(p))) out.push('windows');
  if (inRoot.some((p) => /^[^/]+\.sh$/.test(p) || /^lib\/(py\d-)?linux/.test(p))) out.push('linux');
  if (/\.app\/contents\/resources\/autorun\/$/i.test(root) || inRoot.some((p) => /^lib\/(py\d-)?mac/.test(p))) out.push('mac');
  return out;
}

/** Dateien unter game/, die ein Web-Build nicht braucht oder die für die Web-Engine schädlich wären. */
export function skipGameFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  return (
    lower.startsWith('cache/') ||
    lower.startsWith('saves/') ||
    lower.includes('/__pycache__/') ||
    lower.startsWith('__pycache__/') ||
    /\.(rpa|rpi|rpyb|exe|dll|so|dylib|pyd|bak)$/.test(lower) ||
    /(^|\/)(log|errors|traceback|files)\.txt$/.test(lower) ||
    lower === 'renpyweb_remote_files.txt'
  );
}

export function mediaKind(rel: string): MediaKind | null {
  if (/\.(png|jpe?g|webp|avif)$/i.test(rel)) return 'image';
  if (/\.(wav|mp2|mp3|ogg|oga|opus)$/i.test(rel)) return 'audio';
  if (/\.(ogv|webm|mp4|m4v|mkv|avi)$/i.test(rel)) return 'video';
  return null;
}

export function isVoicePath(rel: string): boolean {
  return /(^|\/)(voices?|vo|voiceover)\//i.test(rel) || /(^|\/)voice[^/]*\//i.test(rel);
}

/**
 * Regeln für „sofort laden“ (game.zip, Arbeitsspeicher) und „bei Bedarf“ (aus dem iPad-Speicher).
 * GUI-Grafiken und kleine Dateien laden sofort, damit Menüs ohne Platzhalter erscheinen.
 */
export const CLASSIFY_LIMITS = {
  smallImageBytes: 24 * 1024,
  smallImageBudget: 48 * 1024 * 1024,
  guiImageBudget: 160 * 1024 * 1024,
  smallAudioBytes: 128 * 1024,
  smallAudioBudget: 48 * 1024 * 1024,
};

export type Placement = { kind: 'local' } | { kind: 'remote'; meta: string };

export class Classifier {
  private smallImages = 0;
  private gui = 0;
  private smallAudio = 0;

  constructor(private readonly limits = CLASSIFY_LIMITS) {}

  /**
   * Entscheidet für eine Datei. `size` ist die entpackte Größe; `dims` liefert bei Bedarf die
   * Bildgröße (null, wenn sie nicht bestimmbar ist – dann wird das Bild sofort geladen).
   */
  async place(rel: string, size: number, dims: () => Promise<{ width: number; height: number } | null>): Promise<Placement> {
    const kind = mediaKind(rel);
    if (kind === 'video') return { kind: 'remote', meta: 'video -' };
    if (kind === 'audio') {
      if (isVoicePath(rel)) return { kind: 'remote', meta: 'voice -' };
      if (size <= this.limits.smallAudioBytes && this.smallAudio + size <= this.limits.smallAudioBudget) {
        this.smallAudio += size;
        return { kind: 'local' };
      }
      return { kind: 'remote', meta: 'music -' };
    }
    if (kind === 'image') {
      if (/^gui\//i.test(rel) && this.gui + size <= this.limits.guiImageBudget) {
        this.gui += size;
        return { kind: 'local' };
      }
      if (size <= this.limits.smallImageBytes && this.smallImages + size <= this.limits.smallImageBudget) {
        this.smallImages += size;
        return { kind: 'local' };
      }
      const d = await dims();
      if (!d) return { kind: 'local' };
      return { kind: 'remote', meta: `image ${d.width},${d.height}` };
    }
    return { kind: 'local' };
  }
}

/** Inhalt von game/renpyweb_remote_files.txt (Format wie launcher/game/web.rpy). */
export function remoteFilesText(remote: Map<string, string>): string {
  let out = '';
  for (const name of [...remote.keys()].sort()) out += `${name}\n${remote.get(name)}\n`;
  return out;
}

/** 1×1 transparentes PNG – Platzhalter, bis ein Bild nachgeladen ist (Ren'Py skaliert ihn auf die Bildgröße). */
export const PLACEHOLDER_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00,
  0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
  0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/**
 * Transparentes PNG in der Größe w×h (Palette mit 1 Bit, durchsichtig) – stark komprimiert, meist wenige
 * hundert Bytes. Dient als Platzhalter mit den echten Maßen eines nachgeladenen Bildes.
 */
export function placeholderPng(w: number, h: number): Uint8Array {
  const rowBytes = 1 + Math.ceil(w / 8);
  const raw = new Uint8Array(rowBytes * h);
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.byteLength);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([1, 3, 0, 0, 0], 8); // 1 Bit, Palette
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Uint8Array.from([0, 0, 0])),
    chunk('tRNS', Uint8Array.from([0])),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.byteLength;
  }
  return png;
}

/** Ren'Py-Laufzeit für die Python-Generation des Spiels wählen (neueste passende). */
export function chooseRuntime<T extends { python: number; version: string }>(available: T[], python: 2 | 3 | null): T | null {
  const wanted = python ?? 3;
  const matching = available.filter((r) => r.python === wanted).sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
  return matching[0] ?? null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
