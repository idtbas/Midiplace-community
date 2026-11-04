/// <reference lib="webworker" />
/**
 * Schreiben ins OPFS (nur im Installations-Worker): bevorzugt über synchrone Zugriffe (schnell,
 * Safari ≥ 16.4), sonst über schreibbare Streams.
 */

interface SyncHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

/** Ziel, in das nacheinander geschrieben wird. `close()` muss immer aufgerufen werden. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export async function openSink(handle: FileSystemFileHandle): Promise<FileSink> {
  const createSync = (handle as unknown as { createSyncAccessHandle?: () => Promise<SyncHandle> }).createSyncAccessHandle;
  if (typeof createSync === 'function') {
    const access = await createSync.call(handle);
    access.truncate(0);
    let offset = 0;
    return {
      async write(chunk) {
        let written = 0;
        while (written < chunk.byteLength) written += access.write(chunk.subarray(written) as Uint8Array<ArrayBuffer>, { at: offset + written });
        offset += chunk.byteLength;
      },
      async close() {
        access.flush();
        access.close();
      },
      async abort() {
        access.close();
      },
    };
  }
  const writable = await (handle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
  return {
    // Kopie, weil Lesepuffer im nächsten Schritt wiederverwendet werden.
    write: (chunk) => writable.write(chunk.slice()),
    close: () => writable.close(),
    abort: () => writable.abort().catch(() => undefined),
  };
}

/** Schreibt Abschnitte in eine Datei; jeder Abschnitt ist vor dem nächsten vollständig geschrieben. */
export async function writeChunks(handle: FileSystemFileHandle, chunks: AsyncIterable<Uint8Array>, onChunk: (n: number) => void): Promise<void> {
  const sink = await openSink(handle);
  try {
    for await (const chunk of chunks) {
      await sink.write(chunk);
      onChunk(chunk.byteLength);
    }
  } catch (error) {
    await sink.abort();
    throw error;
  }
  await sink.close();
}

/** Legt Unterordner bei Bedarf an und merkt sich die Handles. */
export function directoryMaker(root: FileSystemDirectoryHandle) {
  const dirs = new Map<string, FileSystemDirectoryHandle>([['', root]]);
  const ensureDir = async (relativeDir: string): Promise<FileSystemDirectoryHandle> => {
    const cached = dirs.get(relativeDir);
    if (cached) return cached;
    const slash = relativeDir.lastIndexOf('/');
    const parent = await ensureDir(slash >= 0 ? relativeDir.slice(0, slash) : '');
    const handle = await parent.getDirectoryHandle(relativeDir.slice(slash + 1), { create: true });
    dirs.set(relativeDir, handle);
    return handle;
  };
  const fileHandle = async (relativePath: string): Promise<FileSystemFileHandle> => {
    const slash = relativePath.lastIndexOf('/');
    const dir = await ensureDir(slash >= 0 ? relativePath.slice(0, slash) : '');
    return dir.getFileHandle(relativePath.slice(slash + 1), { create: true });
  };
  return { ensureDir, fileHandle };
}
