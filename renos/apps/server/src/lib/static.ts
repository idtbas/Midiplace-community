import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * MIME-Typen für ausgelieferte Dateien. Besonders wichtig: `.wasm` muss `application/wasm` sein,
 * sonst kann der Browser WebAssembly nicht per Streaming kompilieren (Ren'Py-Dokumentation).
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.zip': 'application/zip',
  '.symbols': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function mimeType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface SendFileOptions {
  cacheControl: string;
  headers?: Record<string, string>;
}

/** Prüft, ob `filePath` eine reguläre Datei ist (keine Symlinks, keine Ordner). */
export async function regularFile(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile()) return null;
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

function parseRange(header: string, size: number): { start: number; end: number } | 'invalid' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // Mehrfachbereiche werden ignoriert → vollständige Antwort
  const [, startRaw, endRaw] = match;
  let start: number;
  let end: number;
  if (startRaw === '' && endRaw === '') return 'invalid';
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (suffix === 0) return 'invalid';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Liefert eine bereits geprüfte reguläre Datei aus. Unterstützt HEAD, bedingte Anfragen (ETag/Last-Modified)
 * und einfache Byte-Ranges (für Audio, Video und große Datenpakete).
 */
export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  info: { size: number; mtimeMs: number },
  options: SendFileOptions,
): Promise<FastifyReply> {
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();

  reply.header('Content-Type', mimeType(filePath));
  reply.header('Cache-Control', options.cacheControl);
  reply.header('ETag', etag);
  reply.header('Last-Modified', lastModified);
  reply.header('Accept-Ranges', 'bytes');
  for (const [key, value] of Object.entries(options.headers ?? {})) reply.header(key, value);

  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    return reply.code(304).send();
  }
  const ifModifiedSince = request.headers['if-modified-since'];
  if (!ifNoneMatch && ifModifiedSince && Date.parse(ifModifiedSince) >= Date.parse(lastModified)) {
    return reply.code(304).send();
  }

  let start = 0;
  let end = info.size - 1;
  const rangeHeader = request.headers.range;
  if (rangeHeader && info.size > 0) {
    const range = parseRange(rangeHeader, info.size);
    if (range === 'invalid') {
      reply.header('Content-Range', `bytes */${info.size}`);
      return reply.code(416).send();
    }
    if (range) {
      start = range.start;
      end = range.end;
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
  }

  const length = info.size === 0 ? 0 : end - start + 1;
  reply.header('Content-Length', String(length));
  // Fastifys HEAD-Behandlung übernimmt Content-Length nur bei Stream-Payloads – daher ein leerer Stream.
  if (request.method === 'HEAD') return reply.send(Readable.from([]));
  if (length === 0) return reply.send('');
  return reply.send(createReadStream(filePath, { start, end }));
}
