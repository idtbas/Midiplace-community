import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { GAME_BRIDGE_PATH, GAME_ID_PATTERN, GAME_PATH_PREFIX } from '@renos/shared';
import type { ServerConfig } from './config.js';
import type { Database } from './db.js';
import { bridgeScript, injectBridge } from './games/bridge.js';
import type { GameService } from './games/service.js';
import { regularFile, sendFile } from './lib/static.js';
import { checkEntryPath, resolveInside } from './zip/paths.js';

/**
 * Content-Security-Policy für Spielinhalte.
 *
 * Notwendige Ausnahmen für die Ren'Py-Web-Laufzeit (dokumentiert in ARCHITECTURE.md):
 *   - 'unsafe-inline': index.html von Ren'Py enthält Inline-Skripte und `javascript:`-Links im Hamburger-Menü
 *   - 'unsafe-eval':   Ren'Py ruft JavaScript über emscripten_run_script (eval) auf, z. B. presplashEnd()
 *   - 'wasm-unsafe-eval': Kompilieren von renpy.wasm
 *   - blob:/data:      Save-Export (Blob-Downloads), Medienwiedergabe
 * Die Isolation erfolgt über den getrennten Origin; `connect-src 'self'` verhindert Netzwerkzugriffe auf fremde Hosts,
 * `frame-ancestors` erlaubt das Einbetten nur durch RenOS.
 */
export function gameCsp(appOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join('; ');
}

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), display-capture=(), clipboard-read=()';

export async function buildGameHost(
  config: ServerConfig,
  db: Database,
  games: GameService,
  logger: FastifyBaseLogger,
): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger.child({ server: 'game-host' }), trustProxy: config.trustProxy });
  const csp = gameCsp(config.appOrigin);
  const bridge = bridgeScript(config.appOrigin);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    if (config.gameOrigin.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).type('text/plain; charset=utf-8').header('Cache-Control', 'no-store').send('Nicht gefunden');
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Game host error');
    void reply.code(500).type('text/plain; charset=utf-8').send('Interner Fehler');
  });

  app.get('/', async (_request, reply) => reply.type('text/plain; charset=utf-8').header('Cache-Control', 'no-store').send('RenOS Game Host'));

  app.get(GAME_BRIDGE_PATH, async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-cache').send(bridge),
  );

  app.get<{ Params: { id: string; '*': string } }>(`${GAME_PATH_PREFIX}/:id/*`, async (request, reply) => {
    const { id } = request.params;
    // Nur installierte Spiele werden ausgeliefert. Gelöschte Spiele sind sofort nicht mehr erreichbar.
    if (!GAME_ID_PATTERN.test(id) || !db.hasGame(id)) return reply.callNotFound();

    let relative = request.params['*'] ?? '';
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const check = checkEntryPath(relative);
    if (!check.ok || check.isDirectory) return reply.callNotFound();
    if (check.path.split('/').some((segment) => segment.startsWith('.'))) return reply.callNotFound();

    const root = games.gameRoot(id);
    const filePath = resolveInside(root, check.path);
    if (!filePath) return reply.callNotFound();
    const info = await regularFile(filePath);
    if (!info) return reply.callNotFound();
    // Doppelte Absicherung gegen Symlinks in übergeordneten Ordnern.
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
    if (!realFile.startsWith(realRoot + path.sep)) return reply.callNotFound();

    if (check.path === 'index.html') {
      const html = await readFile(filePath, 'utf8');
      return reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(injectBridge(html, GAME_BRIDGE_PATH));
    }
    // Spielordner sind unveränderlich: Eine Neuinstallation erhält immer eine neue ID.
    return sendFile(request, reply, filePath, info, { cacheControl: 'public, max-age=31536000, immutable' });
  });

  return app;
}
