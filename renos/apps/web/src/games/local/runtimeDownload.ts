/// <reference lib="webworker" />
import { writeChunks } from './opfsWrite';
import { forgetRuntime, parseRuntimeManifest, readInstalledRuntime, runtimeDirectory, sha256Hex, type RuntimeManifest } from './runtimes';

/**
 * Lädt ein Ren'Py-Laufzeitpaket von der RenOS-Website ins OPFS (im Installations-Worker).
 * Jede Datei wird auf Größe und SHA-256 geprüft; runtime.json entsteht erst ganz am Ende.
 */
export async function downloadRuntime(
  id: string,
  baseUrl: string,
  isCancelled: () => boolean,
  progress: (bytes: number, total: number) => void,
): Promise<RuntimeManifest> {
  const existing = await readInstalledRuntime(id);
  if (existing) return existing;

  const response = await fetch(`${baseUrl}${id}/runtime.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error('runtime_unavailable');
  const manifest = parseRuntimeManifest(await response.json(), id);
  if (!manifest) throw new Error('runtime_invalid');

  const dir = await runtimeDirectory(id, true);
  await dir.removeEntry('runtime.json').catch(() => undefined);
  forgetRuntime(id);

  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  let done = 0;
  for (const f of manifest.files) {
    if (isCancelled()) throw new DOMException('cancelled', 'AbortError');
    const handle = await dir.getFileHandle(f.name, { create: true });
    const existingFile = await handle.getFile();
    if (existingFile.size === f.size && (await sha256Hex(existingFile)) === f.sha256) {
      done += f.size;
      progress(done, total);
      continue;
    }
    const res = await fetch(`${baseUrl}${id}/${f.name}`, { cache: 'no-cache' });
    if (!res.ok || !res.body) throw new Error('runtime_unavailable');
    const reader = res.body.getReader();
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        if (isCancelled()) throw new DOMException('cancelled', 'AbortError');
        yield value;
      }
    }
    await writeChunks(handle, chunks(), (n) => {
      done += n;
      progress(done, total);
    });
    const written = await handle.getFile();
    if (written.size !== f.size || (await sha256Hex(written)) !== f.sha256) throw new Error('runtime_corrupt');
  }
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  await writeChunks(await dir.getFileHandle('runtime.json', { create: true }), (async function* () {
    yield json;
  })(), () => undefined);
  const installed = await readInstalledRuntime(id);
  if (!installed) throw new Error('runtime_corrupt');
  return installed;
}
