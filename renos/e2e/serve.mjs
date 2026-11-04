#!/usr/bin/env node
/** Startet einen frischen RenOS-Server für die End-to-End-Tests (eigenes Datenverzeichnis, Testpasswort). */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { hashPassword } = await import(path.join(root, 'apps/server/dist/auth/password.js'));
const dataDir = path.join(root, 'e2e/.artifacts/data');
rmSync(dataDir, { recursive: true, force: true });

export const E2E_PASSWORD = 'e2e-owner-passwort';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RENOS_HOST: '127.0.0.1',
  RENOS_PORT: '4310',
  RENOS_GAME_HOST: '127.0.0.1',
  RENOS_GAME_PORT: '4311',
  RENOS_APP_ORIGIN: 'http://localhost:4310',
  RENOS_GAME_ORIGIN: 'http://localhost:4311',
  RENOS_DATA_DIR: dataDir,
  RENOS_WEB_DIST: path.join(root, 'apps/web/dist'),
  RENOS_OWNER_PASSWORD_HASH: await hashPassword(E2E_PASSWORD, { N: 2 ** 14, r: 8, p: 1 }),
  RENOS_LOG_LEVEL: 'warn',
};
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'apps/server/dist/index.js')], { env, stdio: 'inherit' });
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
