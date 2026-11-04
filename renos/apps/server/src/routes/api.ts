import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  RENOS_VERSION,
  type GameUpdateRequest,
  type HealthResponse,
  type InstallRequest,
  type LoginRequest,
} from '@renos/shared';
import type { AuthService } from '../auth/auth.js';
import type { ServerConfig } from '../config.js';
import type { GameService } from '../games/service.js';
import { errors } from '../lib/errors.js';

const ARCHIVE_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function bodyObject<T>(request: FastifyRequest): Partial<T> {
  const body = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw errors.badRequest();
  return body as Partial<T>;
}

export async function registerApiRoutes(
  app: FastifyInstance,
  deps: { config: ServerConfig; auth: AuthService; games: GameService },
): Promise<void> {
  const { config, auth, games } = deps;

  // Archive werden als Datenstrom entgegengenommen und nie vollständig in den Speicher geladen.
  app.addContentTypeParser(ARCHIVE_TYPES, (_request, payload, done) => done(null, payload));
  app.addContentTypeParser(IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: config.maxCoverBytes }, (_request, body, done) =>
    done(null, body),
  );

  // ----- System ---------------------------------------------------------------

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: RENOS_VERSION,
    time: new Date().toISOString(),
    gameOrigin: config.gameOrigin,
    ownerConfigured: auth.ownerConfigured,
    publicLibrary: config.publicLibrary,
    limits: {
      maxUploadBytes: config.maxUploadBytes,
      maxUncompressedBytes: config.maxUncompressedBytes,
      maxArchiveEntries: config.maxArchiveEntries,
      maxCoverBytes: config.maxCoverBytes,
    },
  }));

  app.get('/api/storage', async (request, reply) => {
    auth.requireReader(request, reply);
    return games.storageInfo();
  });

  // ----- Authentifizierung ----------------------------------------------------

  app.get('/api/auth/session', async (request, reply) => auth.sessionInfo(request, reply));

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      auth.checkOrigin(request);
      const { password } = bodyObject<LoginRequest>(request);
      if (typeof password !== 'string') throw errors.badRequest('Bitte ein Passwort angeben.');
      return auth.login(password, reply);
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    auth.checkOrigin(request);
    auth.logout(request, reply);
    return { authenticated: false, ownerConfigured: auth.ownerConfigured, csrfToken: null, expiresAt: null };
  });

  // ----- Spiele ---------------------------------------------------------------

  app.get('/api/games', async (request, reply) => {
    auth.requireReader(request, reply);
    return { games: games.listGames() };
  });

  app.get<{ Params: { id: string } }>('/api/games/:id', async (request, reply) => {
    auth.requireReader(request, reply);
    return { game: games.toApiGame(games.getGame(request.params.id)) };
  });

  app.patch<{ Params: { id: string } }>('/api/games/:id', async (request, reply) => {
    auth.requireOwner(request, reply);
    const { title } = bodyObject<GameUpdateRequest>(request);
    if (typeof title !== 'string') throw errors.badRequest('Bitte einen Titel angeben.');
    return { game: games.renameGame(request.params.id, title) };
  });

  app.delete<{ Params: { id: string } }>('/api/games/:id', async (request, reply) => {
    auth.requireOwner(request, reply);
    await games.deleteGame(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/played', async (request, reply) => {
    auth.requireReader(request, reply);
    auth.checkOrigin(request);
    return { game: games.markPlayed(request.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/games/:id/cover', async (request, reply) => {
    auth.requireReader(request, reply);
    const cover = await games.readCover(request.params.id);
    if (!cover) throw errors.notFound('Für dieses Spiel ist kein Cover hinterlegt.');
    return reply
      .type(cover.mime)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(cover.data);
  });

  app.put<{ Params: { id: string } }>('/api/games/:id/cover', async (request, reply) => {
    auth.requireOwner(request, reply);
    if (!Buffer.isBuffer(request.body)) throw errors.unsupportedMediaType('Bitte ein PNG-, JPEG- oder WebP-Bild senden.');
    return { game: await games.setCover(request.params.id, request.body) };
  });

  app.delete<{ Params: { id: string } }>('/api/games/:id/cover', async (request, reply) => {
    auth.requireOwner(request, reply);
    return { game: await games.removeCover(request.params.id) };
  });

  // ----- Uploads & Installation ---------------------------------------------

  app.post<{ Querystring: { name?: string } }>(
    '/api/uploads',
    { bodyLimit: config.maxUploadBytes, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } },
    async (request, reply) => {
      auth.requireOwner(request, reply);
      const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!ARCHIVE_TYPES.includes(contentType)) throw errors.unsupportedMediaType('Bitte ein ZIP-Archiv hochladen.');
      const name = typeof request.query.name === 'string' ? request.query.name : 'archiv.zip';
      if (!/\.zip$/i.test(name)) throw errors.unsupportedMediaType('Es werden nur ZIP-Archive (.zip) unterstützt.');
      const length = Number(request.headers['content-length']);
      const upload = await games.createUpload(request.body as NodeJS.ReadableStream, name, length);
      return reply.code(201).send({ upload });
    },
  );

  app.get<{ Params: { id: string } }>('/api/uploads/:id', async (request, reply) => {
    auth.requireOwner(request, reply);
    return { upload: games.getUpload(request.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async (request, reply) => {
    auth.requireOwner(request, reply);
    await games.deleteUpload(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/uploads/:id/install', async (request, reply) => {
    auth.requireOwner(request, reply);
    const { title } = bodyObject<InstallRequest>(request);
    if (title !== undefined && typeof title !== 'string') throw errors.badRequest();
    const job = await games.startInstall(request.params.id, title);
    return reply.code(202).send({ job });
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    auth.requireOwner(request, reply);
    return { job: games.getJob(request.params.id) };
  });
}
