import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENOS_VERSION } from '@renos/shared';
import { buildServers } from './app.js';
import { hashPassword, isValidPasswordHash } from './auth/password.js';
import { loadConfig } from './config.js';
import { randomToken } from './lib/ids.js';

/** Lädt eine `.env`-Datei aus dem Projektwurzelverzeichnis (ohne zusätzliche Abhängigkeit). */
function loadDotEnv(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), path.resolve(here, '../../..'), path.resolve(here, '../../../..')];
  for (const dir of candidates) {
    const file = path.join(dir, '.env');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || line.trim().startsWith('#')) continue;
      const [, key, rawValue] = match;
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = (rawValue ?? '').replace(/^(['"])(.*)\1$/, '$2');
    }
    return dir;
  }
  // Ohne .env relativ zur Projektwurzel arbeiten, damit `data/` immer am selben Ort liegt.
  return path.resolve(here, '../../..');
}

async function main(): Promise<void> {
  const root = loadDotEnv();
  const config = loadConfig(process.env, root);

  let devPassword: string | null = null;
  if (config.ownerPasswordHash && !isValidPasswordHash(config.ownerPasswordHash)) {
    throw new Error('RENOS_OWNER_PASSWORD_HASH hat ein ungültiges Format. Bitte mit `npm run hash-password` neu erzeugen.');
  }
  if (!config.ownerPasswordHash && config.env === 'development') {
    // Nur für die lokale Entwicklung: zufälliges Einmal-Passwort, das bei jedem Start neu erzeugt wird.
    devPassword = randomToken(9);
    config.ownerPasswordHash = await hashPassword(devPassword);
  }

  const servers = await buildServers(config);
  const log = servers.app.log;

  await servers.app.listen({ host: config.host, port: config.port });
  await servers.gameHost.listen({ host: config.gameHost, port: config.gamePort });

  log.info({ version: RENOS_VERSION, appOrigin: config.appOrigin, gameOrigin: config.gameOrigin, dataDir: config.dataDir }, 'RenOS server ready');
  if (devPassword) {
    log.warn(`Kein RENOS_OWNER_PASSWORD_HASH gesetzt. Einmal-Passwort für diese Entwicklungssitzung: ${devPassword}`);
  } else if (!config.ownerPasswordHash) {
    log.warn('Kein Owner-Passwort konfiguriert: Upload, Installation und Löschen sind deaktiviert.');
  }

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await servers.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
