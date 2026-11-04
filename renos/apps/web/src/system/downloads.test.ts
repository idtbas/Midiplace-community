import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/persistence/db';
import { initFileSystem, listChildren, readBlob } from '@/persistence/fs';
import { DownloadError, fileNameFor, findFileLinks, normalizeUrl, proxyUrlFor, startDownload, useDownloads } from './downloads';
import { useSettings } from './settings';

describe('Downloads: Adressen und Namen', () => {
  it('vervollständigt und prüft Adressen', () => {
    expect(normalizeUrl('student-transfer.com')).toBe('https://student-transfer.com/');
    expect(normalizeUrl(' https://example.com/a b.zip ')).toBe('https://example.com/a%20b.zip');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('hallo')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  it('nimmt den Dateinamen aus Content-Disposition oder der Adresse', () => {
    expect(fileNameFor('https://x.test/dl?id=1', 'attachment; filename="Szenario Pack.zip"')).toBe('Szenario Pack.zip');
    expect(fileNameFor('https://x.test/dl', "attachment; filename*=UTF-8''Gr%C3%BC%C3%9Fe.zip")).toBe('Grüße.zip');
    expect(fileNameFor('https://www.mediafire.com/file/abc/Pack-1.2.zip/file', null)).toBe('Pack-1.2.zip');
    expect(fileNameFor('https://x.test/a/b%20c.webp', null)).toBe('b c.webp');
    expect(fileNameFor('https://x.test/../../', 'filename="../geheim"')).toBe('.._geheim');
  });

  it('findet Datei-Links auf einer Webseite', () => {
    const html = `<a href="/files/szenario.zip">Download</a><a href="https://cdn.test/x.rar?dl=1">Mirror</a>
      <a href="/about">Über uns</a><a id="downloadButton" href="https://dl.test/get/123">Herunterladen</a><a href="javascript:void(0)">x.zip</a>`;
    expect(findFileLinks(html, 'https://seite.test/post/1')).toEqual([
      { url: 'https://seite.test/files/szenario.zip', label: 'Download' },
      { url: 'https://cdn.test/x.rar?dl=1', label: 'Mirror' },
      { url: 'https://dl.test/get/123', label: 'Herunterladen' },
    ]);
  });

  it('baut die Adresse für den Weiterleitungsdienst', () => {
    expect(proxyUrlFor('https://proxy.test/', 'https://a.test/x y.zip')).toBe('https://proxy.test/?url=https%3A%2F%2Fa.test%2Fx%20y.zip');
  });
});

describe('Downloads nach Files', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await initFileSystem();
    useDownloads.setState({ items: [] });
    useSettings.getState().set('downloadProxy', '');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('lädt erlaubte Dateien direkt nach Files → Downloads', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4, 1, 2]), { headers: { 'content-type': 'application/zip', 'content-length': '6' } })) as typeof fetch;
    const result = await startDownload('https://cdn.test/packs/szenario.zip');
    expect(result.kind).toBe('file');
    const files = await listChildren('downloads');
    expect(files.map((f) => f.name)).toEqual(['szenario.zip']);
    expect((await readBlob(files[0]!.id))!.size).toBe(6);
    expect(useDownloads.getState().items[0]).toMatchObject({ state: 'done', received: 6, name: 'szenario.zip' });
  });

  it('meldet blockierte Server verständlich, wenn kein Weiterleitungsdienst eingerichtet ist', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(startDownload('https://hoster.test/x.zip')).rejects.toMatchObject({ kind: 'blocked' });
    expect(useDownloads.getState().items[0]?.state).toBe('error');
  });

  it('nutzt den eigenen Weiterleitungsdienst, wenn der direkte Weg scheitert', async () => {
    useSettings.getState().set('downloadProxy', 'https://proxy.test');
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!url.startsWith('https://proxy.test/')) throw new TypeError('Failed to fetch');
      return new Response('inhalt', { headers: { 'content-type': 'application/zip', 'x-final-url': 'https://download.hoster.test/abc/Echter%20Name.zip' } });
    }) as typeof fetch;
    const result = await startDownload('https://hoster.test/file/abc');
    expect(calls).toEqual(['https://hoster.test/file/abc', 'https://proxy.test/?url=https%3A%2F%2Fhoster.test%2Ffile%2Fabc']);
    expect(result.kind === 'file' && result.node.name).toBe('Echter Name.zip');
    expect(useDownloads.getState().items[0]?.viaProxy).toBe(true);
  });

  it('bietet bei einer Webseite die gefundenen Datei-Links an', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<a href="/get/pack.zip">Pack</a>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch;
    const result = await startDownload('https://seite.test/thread');
    expect(result).toEqual({ kind: 'page', url: 'https://seite.test/thread', links: [{ url: 'https://seite.test/get/pack.zip', label: 'Pack' }] });
    expect(await listChildren('downloads')).toHaveLength(0);
  });

  it('lehnt zu große Dateien ab', async () => {
    globalThis.fetch = vi.fn(async () => new Response('x', { headers: { 'content-length': String(4 * 1024 * 1024 * 1024) } })) as typeof fetch;
    await expect(startDownload('https://cdn.test/riesig.zip')).rejects.toBeInstanceOf(DownloadError);
    expect(await listChildren('downloads')).toHaveLength(0);
  });
});
