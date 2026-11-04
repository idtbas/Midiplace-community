import { DatabaseSync } from 'node:sqlite';
import type { ArchiveAnalysis } from '@renos/shared';

/**
 * Schlanke Datenzugriffsschicht auf Basis von `node:sqlite` (keine nativen Abhängigkeiten).
 * Alle Abfragen verwenden vorbereitete Statements mit Parametern.
 */

export interface GameRow {
  id: string;
  title: string;
  entry: string;
  size_bytes: number;
  file_count: number;
  installed_at: string;
  last_played_at: string | null;
  cover_ext: string | null;
  cover_version: number;
  source_file_name: string;
  runtime: 'wasm' | 'legacy' | null;
}

export interface UploadRow {
  id: string;
  file_name: string;
  size_bytes: number;
  path: string;
  created_at: string;
  expires_at: string;
  analysis: ArchiveAnalysis;
  state: 'ready' | 'installing';
}

export interface SessionRow {
  id_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS games (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     entry TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     file_count INTEGER NOT NULL,
     installed_at TEXT NOT NULL,
     last_played_at TEXT,
     cover_ext TEXT,
     cover_version INTEGER NOT NULL DEFAULT 0,
     source_file_name TEXT NOT NULL,
     runtime TEXT
   );
   CREATE TABLE IF NOT EXISTS uploads (
     id TEXT PRIMARY KEY,
     file_name TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     path TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     analysis_json TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'ready'
   );
   CREATE TABLE IF NOT EXISTS sessions (
     id_hash TEXT PRIMARY KEY,
     csrf_token TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );`,
];

type Row = Record<string, unknown>;

function toGame(row: Row): GameRow {
  return {
    id: String(row.id),
    title: String(row.title),
    entry: String(row.entry),
    size_bytes: Number(row.size_bytes),
    file_count: Number(row.file_count),
    installed_at: String(row.installed_at),
    last_played_at: row.last_played_at == null ? null : String(row.last_played_at),
    cover_ext: row.cover_ext == null ? null : String(row.cover_ext),
    cover_version: Number(row.cover_version ?? 0),
    source_file_name: String(row.source_file_name),
    runtime: row.runtime === 'wasm' || row.runtime === 'legacy' ? row.runtime : null,
  };
}

function toUpload(row: Row): UploadRow {
  return {
    id: String(row.id),
    file_name: String(row.file_name),
    size_bytes: Number(row.size_bytes),
    path: String(row.path),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    analysis: JSON.parse(String(row.analysis_json)) as ArchiveAnalysis,
    state: row.state === 'installing' ? 'installing' : 'ready',
  };
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as Row | undefined;
    let version = row ? Number(row.value) : 0;
    while (version < MIGRATIONS.length) {
      const sql = MIGRATIONS[version];
      if (!sql) break;
      this.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(String(version + 1));
      });
      version += 1;
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ----- Spiele ------------------------------------------------------------

  listGames(): GameRow[] {
    return (this.db.prepare('SELECT * FROM games ORDER BY title COLLATE NOCASE').all() as Row[]).map(toGame);
  }

  getGame(id: string): GameRow | null {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as Row | undefined;
    return row ? toGame(row) : null;
  }

  hasGame(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM games WHERE id = ?').get(id) !== undefined;
  }

  insertGame(game: GameRow): void {
    this.db
      .prepare(
        `INSERT INTO games (id, title, entry, size_bytes, file_count, installed_at, last_played_at, cover_ext, cover_version, source_file_name, runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        game.id,
        game.title,
        game.entry,
        game.size_bytes,
        game.file_count,
        game.installed_at,
        game.last_played_at,
        game.cover_ext,
        game.cover_version,
        game.source_file_name,
        game.runtime,
      );
  }

  updateGameTitle(id: string, title: string): void {
    this.db.prepare('UPDATE games SET title = ? WHERE id = ?').run(title, id);
  }

  updateGameCover(id: string, ext: string | null): void {
    this.db.prepare('UPDATE games SET cover_ext = ?, cover_version = cover_version + 1 WHERE id = ?').run(ext, id);
  }

  markPlayed(id: string, at: string): void {
    this.db.prepare('UPDATE games SET last_played_at = ? WHERE id = ?').run(at, id);
  }

  deleteGame(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes) > 0;
  }

  totalGameBytes(): { count: number; bytes: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS b FROM games').get() as Row;
    return { count: Number(row.c), bytes: Number(row.b) };
  }

  // ----- Uploads -----------------------------------------------------------

  insertUpload(upload: UploadRow): void {
    this.db
      .prepare(
        `INSERT INTO uploads (id, file_name, size_bytes, path, created_at, expires_at, analysis_json, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        upload.id,
        upload.file_name,
        upload.size_bytes,
        upload.path,
        upload.created_at,
        upload.expires_at,
        JSON.stringify(upload.analysis),
        upload.state,
      );
  }

  getUpload(id: string): UploadRow | null {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Row | undefined;
    return row ? toUpload(row) : null;
  }

  /** Setzt den Upload atomar auf „installing“. Gibt false zurück, wenn er bereits installiert wird. */
  claimUpload(id: string): boolean {
    return Number(this.db.prepare(`UPDATE uploads SET state = 'installing' WHERE id = ? AND state = 'ready'`).run(id).changes) > 0;
  }

  releaseUpload(id: string): void {
    this.db.prepare(`UPDATE uploads SET state = 'ready' WHERE id = ?`).run(id);
  }

  deleteUpload(id: string): void {
    this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  }

  listUploads(): UploadRow[] {
    return (this.db.prepare('SELECT * FROM uploads').all() as Row[]).map(toUpload);
  }

  // ----- Sessions ----------------------------------------------------------

  insertSession(session: SessionRow): void {
    this.db
      .prepare('INSERT INTO sessions (id_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(session.id_hash, session.csrf_token, session.created_at, session.expires_at);
  }

  getSession(idHash: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as Row | undefined;
    if (!row) return null;
    return {
      id_hash: String(row.id_hash),
      csrf_token: String(row.csrf_token),
      created_at: String(row.created_at),
      expires_at: String(row.expires_at),
    };
  }

  extendSession(idHash: string, expiresAt: string): void {
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(expiresAt, idHash);
  }

  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteExpiredSessions(nowIso: string): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
  }
}
