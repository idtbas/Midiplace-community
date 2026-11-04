import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appCsp, buildServers, type RenosServers } from '../src/app.js';
import { hashPassword, isValidPasswordHash, verifyPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { gameCsp } from '../src/gameHost.js';
import { injectBridge } from '../src/games/bridge.js';

describe('configuration safety', () => {
  it('refuses to serve games from the RenOS origin', () => {
    expect(() => loadConfig({ RENOS_APP_ORIGIN: 'https://renos.example', RENOS_GAME_ORIGIN: 'https://renos.example' })).toThrow(/unterscheiden/);
  });

  it('requires HTTPS for public hosts in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', RENOS_APP_ORIGIN: 'http://renos.example', RENOS_GAME_ORIGIN: 'https://games.renos.example' }),
    ).toThrow(/HTTPS/);
    expect(() => loadConfig({ NODE_ENV: 'production', RENOS_APP_ORIGIN: 'https://renos.example', RENOS_GAME_ORIGIN: 'https://games.renos.example' })).not.toThrow();
  });

  it('rejects origins with paths and invalid numbers', () => {
    expect(() => loadConfig({ RENOS_APP_ORIGIN: 'https://renos.example/app' })).toThrow();
    expect(() => loadConfig({ RENOS_MAX_UPLOAD_MB: '-1' })).toThrow();
  });
});

describe('password hashing', () => {
  it('hashes with scrypt and verifies in constant time', async () => {
    const hash = await hashPassword('ein-langes-passwort', { N: 2 ** 14, r: 8, p: 1 });
    expect(isValidPasswordHash(hash)).toBe(true);
    expect(await verifyPassword('ein-langes-passwort', hash)).toBe(true);
    expect(await verifyPassword('falsch', hash)).toBe(false);
    expect(await verifyPassword('x', 'kein-hash')).toBe(false);
    await expect(hashPassword('kurz')).rejects.toThrow();
  });
});

describe('content security policies', () => {
  it('only allows RenOS to frame games and games cannot reach other hosts', () => {
    const csp = gameCsp('https://renos.example');
    expect(csp).toContain('frame-ancestors https://renos.example');
    expect(csp).toContain("connect-src 'self' data: blob:");
    expect(csp).toContain("object-src 'none'");
  });

  it('only allows the game origin as frame source in RenOS', () => {
    const csp = appCsp('https://games.renos.example');
    expect(csp).toContain('frame-src https://games.renos.example');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('injects the bridge into the head of the game page', () => {
    expect(injectBridge('<html><head lang="x"><title>t</title>', '/b.js')).toBe('<html><head lang="x">\n<script src="/b.js"></script><title>t</title>');
    expect(injectBridge('<p>kein head</p>', '/b.js')).toBe('<script src="/b.js"></script>\n<p>kein head</p>');
  });
});

describe('login rate limiting (production mode)', () => {
  let dataDir: string;
  let servers: RenosServers;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'renos-sec-'));
    const config = loadConfig({
      NODE_ENV: 'production',
      RENOS_DATA_DIR: dataDir,
      RENOS_APP_ORIGIN: 'http://localhost:5173',
      RENOS_GAME_ORIGIN: 'http://localhost:8788',
      RENOS_OWNER_PASSWORD_HASH: await hashPassword('richtig-geheim-123', { N: 2 ** 14, r: 8, p: 1 }),
    });
    servers = await buildServers(config, { logger: pino({ level: 'silent' }) });
  });

  afterAll(async () => {
    await servers.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('blocks brute-force attempts after a few failed logins', async () => {
    const attempt = () =>
      servers.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'geraten' }, headers: { origin: 'http://localhost:5173' } });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await attempt()).statusCode);
    expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(statuses[8]).toBe(429);
    const limited = await attempt();
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('sends hardening headers on the app origin', async () => {
    const res = await servers.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });
});
