/**
 * Gemeinsame Typen und Konstanten für Frontend und Backend von RenOS.
 *
 * Alle API-Antworten sind JSON. Fehler haben immer die Form `ApiErrorBody`.
 */

export const RENOS_VERSION = '1.0.0';
export const API_PREFIX = '/api';

/** Name des Headers, über den das Frontend das CSRF-Token mitsendet. */
export const CSRF_HEADER = 'x-renos-csrf';

/** Pfadpräfix auf dem Game-Host, unter dem installierte Spiele liegen. */
export const GAME_PATH_PREFIX = '/g';

/** Pfad der Bridge, die der Game-Host in die index.html eines Spiels einfügt. */
export const GAME_BRIDGE_PATH = '/__renos/bridge.js';

/** Format der Spiel-IDs (vom Server zufällig erzeugt, niemals vom Client gewählt). */
export const GAME_ID_PATTERN = /^[a-z0-9]{24}$/;
export const UPLOAD_ID_PATTERN = /^[a-z0-9]{24}$/;

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'csrf_failed'
  | 'not_found'
  | 'rate_limited'
  | 'owner_not_configured'
  | 'invalid_credentials'
  | 'payload_too_large'
  | 'length_required'
  | 'unsupported_media_type'
  | 'upload_incomplete'
  | 'upload_expired'
  | 'archive_invalid'
  | 'archive_not_installable'
  | 'install_in_progress'
  | 'install_failed'
  | 'insufficient_storage'
  | 'image_invalid'
  | 'internal_error';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Server / Health
// ---------------------------------------------------------------------------

export interface ServerLimits {
  maxUploadBytes: number;
  maxUncompressedBytes: number;
  maxArchiveEntries: number;
  maxCoverBytes: number;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
  time: string;
  gameOrigin: string;
  ownerConfigured: boolean;
  publicLibrary: boolean;
  limits: ServerLimits;
}

export interface StorageInfoResponse {
  gamesCount: number;
  gamesBytes: number;
  /** Freier Speicher auf dem Datenträger des Servers, falls ermittelbar. */
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
}

// ---------------------------------------------------------------------------
// Authentifizierung (Single Owner)
// ---------------------------------------------------------------------------

export interface SessionResponse {
  authenticated: boolean;
  ownerConfigured: boolean;
  /** Nur gesetzt, wenn angemeldet. Muss bei verändernden Anfragen im CSRF-Header mitgesendet werden. */
  csrfToken: string | null;
  expiresAt: string | null;
}

export interface LoginRequest {
  password: string;
}

// ---------------------------------------------------------------------------
// Archiv-Analyse
// ---------------------------------------------------------------------------

/**
 * - `renpy-web`: Unterstützter Ren'Py-Web-Build (index.html + renpy.js/wasm + game.zip …)
 * - `renpy-project`: Ren'Py-Projektquellen (game/*.rpy) – potenziell konvertierbar, aber nicht direkt startbar
 * - `renpy-desktop`: Ren'Py-Desktop-Build (Windows/Linux/macOS) – im Browser nicht lauffähig
 * - `unknown`: Gültiges Archiv ohne erkennbare Ren'Py-Struktur
 */
export type ArchiveKind = 'renpy-web' | 'renpy-project' | 'renpy-desktop' | 'unknown';

export type AnalysisIssueCode =
  | 'not_a_zip'
  | 'empty_archive'
  | 'too_many_entries'
  | 'too_large_uncompressed'
  | 'suspicious_ratio'
  | 'unsafe_path'
  | 'absolute_path'
  | 'path_traversal'
  | 'invalid_filename'
  | 'duplicate_entry'
  | 'symlink'
  | 'encrypted_entry'
  | 'unsupported_compression'
  | 'executable_content'
  | 'missing_entry_point'
  | 'missing_runtime'
  | 'missing_game_data'
  | 'nested_archive_only';

export interface AnalysisIssue {
  code: AnalysisIssueCode;
  severity: 'error' | 'warning' | 'info';
  /** Betroffener Pfad (gekürzt), falls zutreffend. */
  path?: string;
}

export interface ArchiveCheck {
  id: 'format' | 'size' | 'entries' | 'paths' | 'entry_point' | 'runtime' | 'game_data';
  ok: boolean;
}

export interface ArchiveAnalysis {
  kind: ArchiveKind;
  /** Ob das Archiv installiert werden kann. Nur `renpy-web` ohne Fehler ist installierbar. */
  installable: boolean;
  /** Gemeinsamer Ordner, in dem der Web-Build liegt (z. B. `MeinSpiel-1.0-web/`), sonst leer. */
  rootPrefix: string;
  entryPoint: string | null;
  fileCount: number;
  directoryCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  detectedTitle: string | null;
  presplash: string | null;
  /** Hinweise zu erkannter Ren'Py-Laufzeit, z. B. `wasm` oder `legacy-pythonhome`. */
  runtime: 'wasm' | 'legacy' | null;
  checks: ArchiveCheck[];
  issues: AnalysisIssue[];
}

// ---------------------------------------------------------------------------
// Uploads & Installation
// ---------------------------------------------------------------------------

export interface UploadInfo {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  analysis: ArchiveAnalysis;
}

export interface InstallRequest {
  title?: string;
}

export type InstallJobState = 'queued' | 'extracting' | 'finalizing' | 'done' | 'failed';

export interface InstallJob {
  id: string;
  uploadId: string;
  state: InstallJobState;
  bytesTotal: number;
  bytesWritten: number;
  filesTotal: number;
  filesWritten: number;
  gameId: string | null;
  error: { code: ApiErrorCode; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Spiele
// ---------------------------------------------------------------------------

export interface Game {
  id: string;
  title: string;
  entry: string;
  sizeBytes: number;
  fileCount: number;
  installedAt: string;
  lastPlayedAt: string | null;
  /** Relativer API-Pfad des Covers (mit Cache-Version) oder null. */
  coverUrl: string | null;
  /** Ursprünglicher Dateiname des Archivs. */
  sourceFileName: string;
  runtime: 'wasm' | 'legacy' | null;
  /** Vollständige URL des Spiels auf dem Game-Host. */
  playUrl: string;
}

export interface GamesResponse {
  games: Game[];
}

export interface GameUpdateRequest {
  title?: string;
}

// ---------------------------------------------------------------------------
// Bridge-Protokoll zwischen Spiel-iframe (Game-Origin) und RenOS (App-Origin)
// ---------------------------------------------------------------------------

export const BRIDGE_SOURCE = 'renos-bridge';
export const BRIDGE_VERSION = 1;

export type BridgeMessage =
  | { source: typeof BRIDGE_SOURCE; v: 1; type: 'boot' }
  | { source: typeof BRIDGE_SOURCE; v: 1; type: 'progress'; done: number; total: number }
  | { source: typeof BRIDGE_SOURCE; v: 1; type: 'running' }
  | { source: typeof BRIDGE_SOURCE; v: 1; type: 'error'; message: string }
  | { source: typeof BRIDGE_SOURCE; v: 1; type: 'storage'; persisted: boolean | null }
  | { source: typeof BRIDGE_SOURCE; v: 1; type: 'exit-request' };

const BRIDGE_TYPES = new Set(['boot', 'progress', 'running', 'error', 'storage', 'exit-request']);

/**
 * Prüft eine Nachricht aus dem Spiel-iframe streng. Der Inhalt stammt aus potenziell
 * nicht vertrauenswürdigem Code und wird deshalb vollständig validiert.
 */
export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.source !== BRIDGE_SOURCE || d.v !== BRIDGE_VERSION) return null;
  if (typeof d.type !== 'string' || !BRIDGE_TYPES.has(d.type)) return null;
  switch (d.type) {
    case 'boot':
    case 'running':
    case 'exit-request':
      return { source: BRIDGE_SOURCE, v: 1, type: d.type };
    case 'progress': {
      const done = Number(d.done);
      const total = Number(d.total);
      if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) return null;
      return { source: BRIDGE_SOURCE, v: 1, type: 'progress', done: Math.min(done, total), total };
    }
    case 'error': {
      const message = typeof d.message === 'string' ? d.message.slice(0, 500) : '';
      return { source: BRIDGE_SOURCE, v: 1, type: 'error', message };
    }
    case 'storage': {
      const persisted = typeof d.persisted === 'boolean' ? d.persisted : null;
      return { source: BRIDGE_SOURCE, v: 1, type: 'storage', persisted };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Bereinigt einen vom Nutzer gewählten Spieltitel. */
export function sanitizeTitle(input: string, fallback = 'Unbenanntes Spiel'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 120);
}

export function formatBytes(bytes: number, locale = 'de-DE'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
}
