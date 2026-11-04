#!/usr/bin/env node
/**
 * Bildet GitHub Pages für die Tests des lokalen Modus nach: zwei rein statische Server.
 *   http://localhost:4320/renos/        → apps/web/dist-local (RenOS)
 *   http://localhost:4321/renos-games/  → apps/gamehost      (Spiele-Host, zweiter Origin)
 * Wie GitHub Pages: keine CSP, CORS „*“, 404 für unbekannte Dateien.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.map': 'application/json', '.wasm': 'application/wasm',
};

function serve(port, prefix, dir, spa) {
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404).end('not found');
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      if (spa && !path.extname(rel)) file = path.join(dir, 'index.html');
      else {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'max-age=0',
    });
    createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1');
}

serve(4320, '/renos/', path.join(root, 'apps/web/dist-local'), true);
serve(4321, '/renos-games/', path.join(root, 'apps/gamehost'), false);
console.log('static servers on :4320 and :4321');
