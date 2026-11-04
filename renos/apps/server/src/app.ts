import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { ApiErrorBody } from '@renos/shared';
import { AuthService } from './auth/auth.js';
import type { ServerConfig } from './config.js';
import { Database } from './db.js';
import { buildGameHost } from './gameHost.js';
import { GameService } from './games/service.js';
import { AppError } from './lib/errors.js';
import { ensureDir } from './lib/fsutil.js';
import { regularFile, sendFile } from './lib/static.js';
import { checkEntryPath, resolveInside } from './zip/paths.js';
import { registerApiRoutes } from './routes/api.js';

export interface RenosServers {
  app: FastifyInstance;
  gameHost: FastifyInstance;
  db: Database;
  games: GameService;
  auth: AuthService;
  close: () => Promise<void>;
}

/** CSP der RenOS-Oberfläche: nur eigene Skripte; iframes ausschließlich vom Game-Origin. */
export function appCsp(gameOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    `frame-src ${gameOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function errorBody(code: ApiErrorBody['error']['code'], message: string): ApiErrorBody {
  return { error: { code, message } };
}

export async function buildServers(config: ServerConfig, options: { logger?: FastifyBaseLogger } = {}): Promise<RenosServers> {
  await ensureDir(config.dataDir);

  const app = options.logger
    ? Fastify({ loggerInstance: options.logger, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 })
    : Fastify({
        logger:
          config.env === 'development'
            ? { level: config.logLevel, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,reqId', singleLine: true } } }
            : { level: config.logLevel },
        trustProxy: config.trustProxy,
        bodyLimit: 1024 * 1024,
      });

  const db = new Database(path.join(config.dataDir, 'renos.sqlite'));
  const auth = new AuthService(config, db, config.ownerPasswordHash);
  const games = new GameService(config, db, app.log);
  await games.init();

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: () => config.env === 'test',
    errorResponseBuilder: () => {
      const error = new AppError('rate_limited', 429, 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.');
      return error as unknown as object;
    },
  });

  const csp = appCsp(config.gameOrigin);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (config.appOrigin.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (request.url.startsWith('/api/')) {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    } else if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', csp);
    }
    return payload;
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ code: error.code }, error.message);
      return reply.code(error.statusCode).send(errorBody(error.code, error.message));
    }
    const status = (error as FastifyError).statusCode ?? 500;
    if (status === 413 || (error as FastifyError).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send(errorBody('payload_too_large', 'Die Datei ist zu groß.'));
    }
    if (status === 415 || (error as FastifyError).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send(errorBody('unsupported_media_type', 'Dieser Dateityp wird nicht unterstützt.'));
    }
    if (status === 429) {
      return reply.code(429).send(errorBody('rate_limited', 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.'));
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send(errorBody('bad_request', 'Die Anfrage ist ungültig.'));
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send(errorBody('internal_error', 'Ein interner Fehler ist aufgetreten.'));
  });

  await registerApiRoutes(app, { config, auth, games });

  // ----- Ausgelieferte Oberfläche (Produktion) --------------------------------
  const webDist = config.webDist && existsSync(path.join(config.webDist, 'index.html')) ? config.webDist : null;
  if (webDist) {
    const indexFile = path.join(webDist, 'index.html');
    app.get('/*', async (request, reply) => {
      const urlPath = decodeURIComponent((request.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
      if (urlPath.startsWith('api/')) return reply.callNotFound();
      if (urlPath) {
        const check = checkEntryPath(urlPath);
        const file = check.ok && !check.isDirectory ? resolveInside(webDist, check.path) : null;
        const info = file ? await regularFile(file) : null;
        if (file && info) {
          const noCache = /(^|\/)(index\.html|sw\.js|manifest\.webmanifest|registerSW\.js)$/.test(check.ok ? check.path : '');
          const cacheControl = noCache
            ? 'no-cache'
            : urlPath.startsWith('assets/')
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=86400';
          return sendFile(request, reply, file, info, { cacheControl });
        }
        // Unbekannte Dateien mit Endung → 404 statt der App-Shell.
        if (path.extname(urlPath)) return reply.callNotFound();
      }
      const info = await regularFile(indexFile);
      if (!info) return reply.callNotFound();
      return sendFile(request, reply, indexFile, info, { cacheControl: 'no-cache' });
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send(errorBody('not_found', 'Nicht gefunden.'));
    return reply.code(404).type('text/plain; charset=utf-8').send('Nicht gefunden');
  });

  const gameHost = await buildGameHost(config, db, games, app.log);

  return {
    app,
    gameHost,
    db,
    games,
    auth,
    close: async () => {
      games.dispose();
      await Promise.allSettled([app.close(), gameHost.close()]);
      db.close();
    },
  };
}
