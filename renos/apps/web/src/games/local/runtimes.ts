/**
 * Ren'Py-Laufzeitpakete im OPFS von RenOS (renos-runtimes/<id>/…).
 *
 * Ein Paket wird einmal von der RenOS-Website geladen (z. B. GitHub Pages) und danach offline von allen
 * umgewandelten Spielen genutzt. runtime.json wird zuletzt geschrieben – fehlt es, ist das Paket
 * unvollständig und wird neu geladen.
 */

export const RUNTIMES_DIR = 'renos-runtimes';
export const RUNTIME_ID = /^renpy-\d+\.\d+\.\d+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

export interface RuntimeFile {
  name: string;
  size: number;
  sha256: string;
}

export interface RuntimeSummary {
  id: string;
  version: string;
  major: number;
  python: 2 | 3;
  generation: 'web3' | 'renpyweb' | 'unknown';
  totalBytes: number;
}

export interface RuntimeManifest extends RuntimeSummary {
  format: 1;
  engine: 'renpy';
  fullVersion: string;
  bytecode: string | null;
  /** Dateien, die zusammen mit index.html und game.zip den Web-Build bilden. */
  webFiles: string[];
  files: RuntimeFile[];
}

export function isRuntimeSummary(value: unknown): value is RuntimeSummary {
  const v = value as Partial<RuntimeSummary> | null;
  return (
    !!v &&
    typeof v.id === 'string' &&
    RUNTIME_ID.test(v.id) &&
    typeof v.version === 'string' &&
    (v.python === 2 || v.python === 3) &&
    typeof v.totalBytes === 'number' &&
    typeof v.major === 'number'
  );
}

/** Prüft ein geladenes runtime.json streng (Dateinamen, Größen, Prüfsummen). */
export function parseRuntimeManifest(value: unknown, expectedId?: string): RuntimeManifest | null {
  if (!isRuntimeSummary(value)) return null;
  const v = value as Partial<RuntimeManifest>;
  if (v.format !== 1 || v.engine !== 'renpy') return null;
  if (expectedId && v.id !== expectedId) return null;
  if (!Array.isArray(v.files) || !Array.isArray(v.webFiles) || v.files.length > 64) return null;
  for (const f of v.files) {
    if (!f || typeof f.name !== 'string' || !SAFE_NAME.test(f.name) || f.name === 'runtime.json') return null;
    if (typeof f.size !== 'number' || f.size < 0 || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return null;
  }
  const names = new Set(v.files.map((f) => f.name));
  if (!names.has('index.html') || !names.has('engine.zip')) return null;
  if (!v.webFiles.every((n) => typeof n === 'string' && names.has(n) && n !== 'index.html' && n !== 'engine.zip')) return null;
  return v as RuntimeManifest;
}

export async function runtimesRoot(create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RUNTIMES_DIR, { create });
}

export async function runtimeDirectory(id: string, create = false): Promise<FileSystemDirectoryHandle> {
  if (!RUNTIME_ID.test(id)) throw new Error('invalid runtime id');
  return (await runtimesRoot(true)).getDirectoryHandle(id, { create });
}

const manifestCache = new Map<string, RuntimeManifest>();

/** Installiertes, vollständiges Paket (alle Dateien in der erwarteten Größe vorhanden) oder null. */
export async function readInstalledRuntime(id: string): Promise<RuntimeManifest | null> {
  const cached = manifestCache.get(id);
  if (cached) return cached;
  try {
    const dir = await runtimeDirectory(id);
    const manifest = parseRuntimeManifest(JSON.parse(await (await (await dir.getFileHandle('runtime.json')).getFile()).text()), id);
    if (!manifest) return null;
    for (const f of manifest.files) {
      const file = await (await dir.getFileHandle(f.name)).getFile();
      if (file.size !== f.size) return null;
    }
    manifestCache.set(id, manifest);
    return manifest;
  } catch {
    return null;
  }
}

export function forgetRuntime(id: string): void {
  manifestCache.delete(id);
}

/** Datei eines installierten Pakets – nur Dateien, die im Paket stehen. */
export async function readRuntimeFile(id: string, name: string): Promise<File | null> {
  const manifest = await readInstalledRuntime(id);
  if (!manifest || !manifest.files.some((f) => f.name === name)) return null;
  try {
    return await (await (await runtimeDirectory(id)).getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function listInstalledRuntimes(): Promise<RuntimeManifest[]> {
  const out: RuntimeManifest[] = [];
  try {
    const root = await runtimesRoot(true);
    for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) {
      if (!RUNTIME_ID.test(name)) continue;
      const manifest = await readInstalledRuntime(name);
      if (manifest) out.push(manifest);
    }
  } catch {
    /* OPFS nicht verfügbar */
  }
  return out;
}

/** Pakete, die die RenOS-Website anbietet (runtimes/index.json). Offline: leer. */
export async function fetchRuntimeIndex(baseUrl: string): Promise<RuntimeSummary[]> {
  try {
    const response = await fetch(`${baseUrl}index.json`, { cache: 'no-cache' });
    if (!response.ok) return [];
    const body = (await response.json()) as { runtimes?: unknown[] };
    return Array.isArray(body.runtimes) ? body.runtimes.filter(isRuntimeSummary) : [];
  } catch {
    return [];
  }
}

/** Verfügbare Pakete: angebotene und bereits installierte (offline nutzbar), ohne Doppelte. */
export async function availableRuntimes(baseUrl: string): Promise<Array<RuntimeSummary & { installed: boolean }>> {
  const [offered, installed] = await Promise.all([fetchRuntimeIndex(baseUrl), listInstalledRuntimes()]);
  const map = new Map<string, RuntimeSummary & { installed: boolean }>();
  for (const r of offered) map.set(r.id, { ...r, installed: false });
  for (const r of installed) map.set(r.id, { id: r.id, version: r.version, major: r.major, python: r.python, generation: r.generation, totalBytes: r.totalBytes, installed: true });
  return [...map.values()];
}

/** SHA-256 eines Blobs (hex). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
