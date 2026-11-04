import path from 'node:path';

/**
 * Laufzeitkonfiguration des Servers. Alle Werte stammen aus Umgebungsvariablen
 * (siehe `.env.example`). Geheimnisse werden niemals im Code hinterlegt.
 */
export interface ServerConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  gameHost: string;
  gamePort: number;
  appOrigin: string;
  gameOrigin: string;
  dataDir: string;
  ownerPasswordHash: string | null;
  publicLibrary: boolean;
  sessionTtlMs: number;
  maxUploadBytes: number;
  maxUncompressedBytes: number;
  maxArchiveEntries: number;
  maxCompressionRatio: number;
  maxCoverBytes: number;
  uploadTtlMs: number;
  trustProxy: boolean;
  webDist: string | null;
  logLevel: string;
}

const MB = 1024 * 1024;

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Ungültiger Wert für ${key}: ${raw} (erlaubt: ${min}–${max})`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`Ungültiger Wert für ${key}: ${raw} (erwartet true/false)`);
}

function readOrigin(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Ungültige URL für ${key}: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${key} muss mit http:// oder https:// beginnen.`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${key} darf nur einen Origin enthalten (ohne Pfad): ${raw}`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const port = readInt(env, 'RENOS_PORT', 8787, 0, 65535);
  const gamePort = readInt(env, 'RENOS_GAME_PORT', 8788, 0, 65535);
  const appOrigin = readOrigin(env, 'RENOS_APP_ORIGIN', 'http://localhost:5173');
  const gameOrigin = readOrigin(env, 'RENOS_GAME_ORIGIN', `http://localhost:${gamePort}`);

  if (appOrigin === gameOrigin) {
    throw new Error(
      'RENOS_APP_ORIGIN und RENOS_GAME_ORIGIN müssen sich unterscheiden. Spiele dürfen nicht im Origin von RenOS laufen.',
    );
  }
  if (nodeEnv === 'production') {
    for (const [key, origin] of [
      ['RENOS_APP_ORIGIN', appOrigin],
      ['RENOS_GAME_ORIGIN', gameOrigin],
    ] as const) {
      const host = new URL(origin).hostname;
      if (!origin.startsWith('https://') && host !== 'localhost' && host !== '127.0.0.1') {
        throw new Error(`${key} muss in Produktion HTTPS verwenden: ${origin}`);
      }
    }
  }

  const hash = env.RENOS_OWNER_PASSWORD_HASH?.trim() || null;
  const webDistRaw = env.RENOS_WEB_DIST?.trim();

  return {
    env: nodeEnv,
    host: env.RENOS_HOST?.trim() || '127.0.0.1',
    port,
    gameHost: env.RENOS_GAME_HOST?.trim() || env.RENOS_HOST?.trim() || '127.0.0.1',
    gamePort,
    appOrigin,
    gameOrigin,
    dataDir: path.resolve(cwd, env.RENOS_DATA_DIR?.trim() || './data'),
    ownerPasswordHash: hash,
    publicLibrary: readBool(env, 'RENOS_PUBLIC_LIBRARY', false),
    sessionTtlMs: readInt(env, 'RENOS_SESSION_TTL_DAYS', 30, 1, 365) * 24 * 60 * 60 * 1000,
    maxUploadBytes: readInt(env, 'RENOS_MAX_UPLOAD_MB', 16384, 1, 256 * 1024) * MB,
    maxUncompressedBytes: readInt(env, 'RENOS_MAX_UNCOMPRESSED_MB', 32768, 1, 512 * 1024) * MB,
    maxArchiveEntries: readInt(env, 'RENOS_MAX_ARCHIVE_ENTRIES', 100000, 1, 1_000_000),
    maxCompressionRatio: readInt(env, 'RENOS_MAX_COMPRESSION_RATIO', 200, 2, 100_000),
    maxCoverBytes: 8 * MB,
    uploadTtlMs: 60 * 60 * 1000,
    trustProxy: readBool(env, 'RENOS_TRUST_PROXY', false),
    webDist: webDistRaw ? path.resolve(cwd, webDistRaw) : null,
    logLevel: env.RENOS_LOG_LEVEL?.trim() || (nodeEnv === 'test' ? 'silent' : 'info'),
  };
}
