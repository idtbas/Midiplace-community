import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Game, InstallJob, UploadInfo } from '@renos/shared';
import { buildServers, type RenosServers } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { makeZip, tinyPng, webBuildEntries } from './helpers/zip.js';

const APP_ORIGIN = 'http://localhost:5173';
const GAME_ORIGIN = 'http://localhost:8788';
const PASSWORD = 'richtig-geheim-123';

let dataDir: string;
let servers: RenosServers;
let cookie = '';
let csrf = '';

async function login(password = PASSWORD) {
  return servers.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password }, headers: { origin: APP_ORIGIN } });
}

function authHeaders(extra: Record<string, string> = {}) {
  return { cookie, 'x-renos-csrf': csrf, origin: APP_ORIGIN, ...extra };
}

async function upload(zip: Buffer, name = 'spiel.zip') {
  return servers.app.inject({
    method: 'POST',
    url: `/api/uploads?name=${encodeURIComponent(name)}`,
    payload: zip,
    headers: authHeaders({ 'content-type': 'application/zip' }),
  });
}

async function installUpload(uploadId: string, title?: string): Promise<InstallJob> {
  const res = await servers.app.inject({
    method: 'POST',
    url: `/api/uploads/${uploadId}/install`,
    payload: title ? { title } : {},
    headers: authHeaders(),
  });
  expect(res.statusCode).toBe(202);
  const { job } = res.json<{ job: InstallJob }>();
  return servers.games.waitForJob(job.id);
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'renos-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    RENOS_DATA_DIR: dataDir,
    RENOS_APP_ORIGIN: APP_ORIGIN,
    RENOS_GAME_ORIGIN: GAME_ORIGIN,
    RENOS_OWNER_PASSWORD_HASH: await hashPassword(PASSWORD, { N: 2 ** 14, r: 8, p: 1 }),
  });
  servers = await buildServers(config, { logger: pino({ level: 'silent' }) });
});

afterAll(async () => {
  await servers.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('health & auth', () => {
  it('reports health without authentication', async () => {
    const res = await servers.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', gameOrigin: GAME_ORIGIN, ownerConfigured: true, publicLibrary: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps the library private without login', async () => {
    const res = await servers.app.inject({ method: 'GET', url: '/api/games' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects unauthorised uploads', async () => {
    const res = await servers.app.inject({
      method: 'POST',
      url: '/api/uploads?name=a.zip',
      payload: makeZip(webBuildEntries()),
      headers: { 'content-type': 'application/zip', origin: APP_ORIGIN },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects wrong passwords and logins from foreign origins', async () => {
    expect((await login('falsch-falsch')).json()).toMatchObject({ error: { code: 'invalid_credentials' } });
    const foreign = await servers.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('logs in with a secure session cookie and CSRF token', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ authenticated: boolean; csrfToken: string }>();
    expect(body.authenticated).toBe(true);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/renos_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api/);
    cookie = setCookie.split(';')[0]!;
    csrf = body.csrfToken;
    const session = await servers.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, csrfToken: csrf });
  });

  it('requires the CSRF token and a matching origin for changes', async () => {
    const noCsrf = await servers.app.inject({
      method: 'POST',
      url: '/api/uploads?name=a.zip',
      payload: makeZip(webBuildEntries()),
      headers: { cookie, origin: APP_ORIGIN, 'content-type': 'application/zip' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: { code: 'csrf_failed' } });

    const foreign = await servers.app.inject({
      method: 'POST',
      url: '/api/uploads?name=a.zip',
      payload: makeZip(webBuildEntries()),
      headers: { ...authHeaders({ 'content-type': 'application/zip' }), origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
  });
});

describe('upload validation', () => {
  it('rejects non-zip uploads', async () => {
    const wrongType = await servers.app.inject({
      method: 'POST',
      url: '/api/uploads?name=a.zip',
      payload: 'hallo',
      headers: authHeaders({ 'content-type': 'text/plain' }),
    });
    expect(wrongType.statusCode).toBe(415);
    const wrongName = await upload(makeZip(webBuildEntries()), 'spiel.exe');
    expect(wrongName.statusCode).toBe(415);
  });

  it('rejects incomplete uploads and leaves no temporary files', async () => {
    const zip = makeZip(webBuildEntries());
    const res = await servers.app.inject({
      method: 'POST',
      url: '/api/uploads?name=a.zip',
      payload: zip,
      headers: authHeaders({ 'content-type': 'application/zip', 'content-length': String(zip.length + 5000) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'upload_incomplete' } });
    expect((await readdir(servers.games.dirs.uploads)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('analyses unsafe archives without storing them', async () => {
    const res = await upload(makeZip([...webBuildEntries(), { name: '../evil.js', data: 'x' }]));
    expect(res.statusCode).toBe(201);
    const { upload: info } = res.json<{ upload: UploadInfo }>();
    expect(info.analysis.installable).toBe(false);
    const install = await servers.app.inject({ method: 'POST', url: `/api/uploads/${info.id}/install`, payload: {}, headers: authHeaders() });
    expect(install.statusCode).toBe(404);
  });

  it('reports desktop builds as not installable', async () => {
    const res = await upload(makeZip([{ name: 'game/script.rpyc', data: 'x' }, { name: 'Spiel.exe', data: 'MZ' }, { name: 'renpy/common/x.rpy', data: 'x' }]));
    expect(res.json<{ upload: UploadInfo }>().upload.analysis.kind).toBe('renpy-desktop');
  });
});

describe('installation, serving and removal', () => {
  let game: Game;

  it('installs a valid web build atomically', async () => {
    const res = await upload(makeZip(webBuildEntries('Testspiel-1.0-web/', 'Mondlicht')), 'Testspiel-1.0-web.zip');
    expect(res.statusCode).toBe(201);
    const { upload: info } = res.json<{ upload: UploadInfo }>();
    expect(info.analysis).toMatchObject({ kind: 'renpy-web', installable: true, rootPrefix: 'Testspiel-1.0-web/', detectedTitle: 'Mondlicht' });

    const job = await installUpload(info.id);
    expect(job.state).toBe('done');
    expect(job.bytesWritten).toBe(info.analysis.uncompressedBytes);
    expect(await readdir(servers.games.dirs.staging)).toEqual([]);

    const list = await servers.app.inject({ method: 'GET', url: '/api/games', headers: { cookie } });
    const games = list.json<{ games: Game[] }>().games;
    expect(games).toHaveLength(1);
    game = games[0]!;
    expect(game).toMatchObject({ id: job.gameId, title: 'Mondlicht', runtime: 'wasm', fileCount: 7 });
    expect(game.playUrl).toBe(`${GAME_ORIGIN}/g/${game.id}/index.html`);
    expect(game.coverUrl).toMatch(/\/api\/games\/.+\/cover\?v=1/);

    // Ein Upload kann nur einmal installiert werden.
    const again = await servers.app.inject({ method: 'POST', url: `/api/uploads/${info.id}/install`, payload: {}, headers: authHeaders() });
    expect(again.statusCode).toBe(404);
  });

  it('serves the game from the separate game origin with strict headers', async () => {
    const index = await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/index.html` });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.body).toContain('<script src="/__renos/bridge.js"></script>');
    expect(index.headers['content-security-policy']).toContain(`frame-ancestors ${APP_ORIGIN}`);
    expect(index.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.headers['cache-control']).toBe('no-cache');

    const dirIndex = await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/` });
    expect(dirIndex.statusCode).toBe(200);

    const wasm = await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/renpy.wasm` });
    expect(wasm.statusCode).toBe(200);
    expect(wasm.headers['content-type']).toBe('application/wasm');
    expect(wasm.headers['cache-control']).toContain('immutable');

    expect((await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/renpy.js` })).headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/renpy.data` })).headers['content-type']).toBe('application/octet-stream');
    expect((await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/game.zip` })).headers['content-type']).toBe('application/zip');

    const range = await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/game.zip`, headers: { range: 'bytes=0-99' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe('bytes 0-99/4096');
    expect(range.rawPayload.length).toBe(100);

    const head = await servers.gameHost.inject({ method: 'HEAD', url: `/g/${game.id}/renpy.data` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('2048');

    const etag = String(wasm.headers.etag);
    const cached = await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/renpy.wasm`, headers: { 'if-none-match': etag } });
    expect(cached.statusCode).toBe(304);

    const bridge = await servers.gameHost.inject({ method: 'GET', url: '/__renos/bridge.js' });
    expect(bridge.body).toContain(JSON.stringify(APP_ORIGIN));
  });

  it('blocks traversal and unknown games on the game host', async () => {
    for (const url of [
      `/g/${game.id}/../../renos.sqlite`,
      `/g/${game.id}/..%2F..%2Frenos.sqlite`,
      `/g/${game.id}/%2e%2e/%2e%2e/renos.sqlite`,
      `/g/${game.id}/missing.js`,
      `/g/${game.id}/.hidden`,
      '/g/aaaaaaaaaaaaaaaaaaaaaaaa/index.html',
      '/g/../renos.sqlite',
    ]) {
      const res = await servers.gameHost.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('does not serve games on the app origin', async () => {
    const res = await servers.app.inject({ method: 'GET', url: `/g/${game.id}/index.html` });
    expect(res.statusCode).toBe(404);
  });

  it('manages covers with signature checks', async () => {
    const invalid = await servers.app.inject({
      method: 'PUT',
      url: `/api/games/${game.id}/cover`,
      payload: Buffer.from('<svg onload="alert(1)"></svg>'),
      headers: authHeaders({ 'content-type': 'image/png' }),
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ error: { code: 'image_invalid' } });

    const valid = await servers.app.inject({
      method: 'PUT',
      url: `/api/games/${game.id}/cover`,
      payload: tinyPng(),
      headers: authHeaders({ 'content-type': 'image/png' }),
    });
    expect(valid.statusCode).toBe(200);
    const updated = valid.json<{ game: Game }>().game;
    expect(updated.coverUrl).toMatch(/\?v=2$/);

    const cover = await servers.app.inject({ method: 'GET', url: updated.coverUrl!, headers: { cookie } });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toBe('image/png');
    expect(cover.headers['content-security-policy']).toContain('sandbox');

    const removed = await servers.app.inject({ method: 'DELETE', url: `/api/games/${game.id}/cover`, headers: authHeaders() });
    expect(removed.json<{ game: Game }>().game.coverUrl).toBeNull();
  });

  it('renames games and records play time', async () => {
    const renamed = await servers.app.inject({
      method: 'PATCH',
      url: `/api/games/${game.id}`,
      payload: { title: '  Neuer\u0000 Titel  ' },
      headers: authHeaders(),
    });
    expect(renamed.json<{ game: Game }>().game.title).toBe('Neuer Titel');
    const played = await servers.app.inject({ method: 'POST', url: `/api/games/${game.id}/played`, headers: { cookie, origin: APP_ORIGIN } });
    expect(played.json<{ game: Game }>().game.lastPlayedAt).not.toBeNull();
  });

  it('reports storage information', async () => {
    const res = await servers.app.inject({ method: 'GET', url: '/api/storage', headers: { cookie } });
    expect(res.json()).toMatchObject({ gamesCount: 1, gamesBytes: game.sizeBytes });
  });

  it('removes games and stops serving them immediately', async () => {
    const unauthorised = await servers.app.inject({ method: 'DELETE', url: `/api/games/${game.id}` });
    expect(unauthorised.statusCode).toBe(401);
    const res = await servers.app.inject({ method: 'DELETE', url: `/api/games/${game.id}`, headers: authHeaders() });
    expect(res.statusCode).toBe(204);
    const index = await servers.gameHost.inject({ method: 'GET', url: `/g/${game.id}/index.html` });
    expect(index.statusCode).toBe(404);
    const list = await servers.app.inject({ method: 'GET', url: '/api/games', headers: { cookie } });
    expect(list.json<{ games: Game[] }>().games).toEqual([]);
  });

  it('does not list a game when the installation fails', async () => {
    const res = await upload(makeZip([...webBuildEntries(), { name: 'liar.bin', data: Buffer.alloc(64 * 1024, 1), declaredSize: 100 }]));
    const { upload: info } = res.json<{ upload: UploadInfo }>();
    expect(info.analysis.installable).toBe(true);
    const job = await installUpload(info.id);
    expect(job.state).toBe('failed');
    expect(job.gameId).toBeNull();
    expect(await readdir(servers.games.dirs.staging)).toEqual([]);
    expect(await readdir(servers.games.dirs.games)).toEqual([]);
    const list = await servers.app.inject({ method: 'GET', url: '/api/games', headers: { cookie } });
    expect(list.json<{ games: Game[] }>().games).toEqual([]);
    // Der Upload bleibt erhalten und kann verworfen werden.
    const discard = await servers.app.inject({ method: 'DELETE', url: `/api/uploads/${info.id}`, headers: authHeaders() });
    expect(discard.statusCode).toBe(204);
  });

  it('logs out and invalidates the session', async () => {
    const res = await servers.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: APP_ORIGIN } });
    expect(res.statusCode).toBe(200);
    const session = await servers.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: false });
  });
});
