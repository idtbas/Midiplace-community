import { createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import {
  GAME_ID_PATTERN,
  GAME_PATH_PREFIX,
  UPLOAD_ID_PATTERN,
  sanitizeTitle,
  type ApiErrorCode,
  type Game,
  type InstallJob,
  type StorageInfoResponse,
  type UploadInfo,
} from '@renos/shared';
import type { ServerConfig } from '../config.js';
import type { Database, GameRow, UploadRow } from '../db.js';
import { AppError, errors } from '../lib/errors.js';
import { diskSpace, ensureDir, listDir, removeInside } from '../lib/fsutil.js';
import { randomId } from '../lib/ids.js';
import { detectImageType, mimeForCoverExt } from '../lib/images.js';
import { ArchiveError, analyzeArchive, extractArchive, type ArchiveLimits } from '../zip/archive.js';

const JOB_RETENTION_MS = 60 * 60 * 1000;
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

export interface StorageDirs {
  root: string;
  games: string;
  uploads: string;
  staging: string;
  covers: string;
  trash: string;
}

class UploadAbortedError extends Error {}

/**
 * Verwaltet Uploads, Installationen und installierte Spiele auf dem Server.
 *
 * Ablauf einer Installation:
 *   1. Upload landet als `uploads/<id>.zip` (Teil-Uploads als `.part`, werden bei Abbruch gelöscht)
 *   2. Analyse ohne Entpacken → Ergebnis in der Datenbank
 *   3. Entpacken in einen frischen Ordner `staging/<jobId>`
 *   4. Atomares `rename` nach `games/<gameId>` und erst danach Eintrag in der Datenbank
 * Bei jedem Fehler wird der Staging-Ordner entfernt; halbfertige Spiele erscheinen nie in der Bibliothek.
 */
export class GameService {
  readonly dirs: StorageDirs;
  private readonly jobs = new Map<string, InstallJob>();
  private readonly limits: ArchiveLimits;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Database,
    private readonly log: FastifyBaseLogger,
  ) {
    const root = config.dataDir;
    this.dirs = {
      root,
      games: path.join(root, 'games'),
      uploads: path.join(root, 'uploads'),
      staging: path.join(root, 'staging'),
      covers: path.join(root, 'covers'),
      trash: path.join(root, 'trash'),
    };
    this.limits = {
      maxEntries: config.maxArchiveEntries,
      maxUncompressedBytes: config.maxUncompressedBytes,
      maxCompressionRatio: config.maxCompressionRatio,
    };
  }

  async init(): Promise<void> {
    for (const dir of Object.values(this.dirs)) await ensureDir(dir);
    await this.cleanup(true);
    this.cleanupTimer = setInterval(() => void this.cleanup(false), 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Entfernt abgelaufene Uploads, verwaiste Staging-Ordner und gelöschte Spiele.
   * Beim Start werden zusätzlich Spielordner ohne Datenbankeintrag entfernt (z. B. nach einem Absturz
   * zwischen `rename` und Datenbankeintrag). Es werden nur Einträge mit RenOS-eigenem ID-Format angefasst.
   */
  async cleanup(startup: boolean): Promise<void> {
    const now = Date.now();
    for (const upload of this.db.listUploads()) {
      if (Date.parse(upload.expires_at) <= now && upload.state === 'ready') await this.removeUpload(upload);
    }
    const activeJobs = new Set([...this.jobs.values()].filter((j) => j.state !== 'done' && j.state !== 'failed').map((j) => j.id));
    for (const name of await listDir(this.dirs.staging)) {
      if (!UPLOAD_ID_PATTERN.test(name) || activeJobs.has(name)) continue;
      await removeInside(this.dirs.staging, path.join(this.dirs.staging, name)).catch(() => undefined);
    }
    for (const name of await listDir(this.dirs.uploads)) {
      const id = name.replace(/\.zip(\.part)?$/, '');
      if (!UPLOAD_ID_PATTERN.test(id)) continue;
      const known = this.db.getUpload(id);
      if (name.endsWith('.part') ? startup : !known) {
        await unlink(path.join(this.dirs.uploads, name)).catch(() => undefined);
      }
    }
    if (startup) {
      for (const name of await listDir(this.dirs.games)) {
        if (GAME_ID_PATTERN.test(name) && !this.db.hasGame(name)) {
          this.log.warn({ gameId: name }, 'Removing orphaned game directory');
          await removeInside(this.dirs.games, path.join(this.dirs.games, name)).catch(() => undefined);
        }
      }
    }
    for (const name of await listDir(this.dirs.trash)) {
      await removeInside(this.dirs.trash, path.join(this.dirs.trash, name)).catch(() => undefined);
    }
    for (const [id, job] of this.jobs) {
      if ((job.state === 'done' || job.state === 'failed') && now - Date.parse(job.updatedAt) > JOB_RETENTION_MS) {
        this.jobs.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Spiele
  // ---------------------------------------------------------------------------

  gameRoot(id: string): string {
    return path.join(this.dirs.games, id);
  }

  toApiGame(row: GameRow): Game {
    return {
      id: row.id,
      title: row.title,
      entry: row.entry,
      sizeBytes: row.size_bytes,
      fileCount: row.file_count,
      installedAt: row.installed_at,
      lastPlayedAt: row.last_played_at,
      coverUrl: row.cover_ext ? `/api/games/${row.id}/cover?v=${row.cover_version}` : null,
      sourceFileName: row.source_file_name,
      runtime: row.runtime,
      playUrl: `${this.config.gameOrigin}${GAME_PATH_PREFIX}/${row.id}/${row.entry}`,
    };
  }

  listGames(): Game[] {
    return this.db.listGames().map((row) => this.toApiGame(row));
  }

  getGame(id: string): GameRow {
    const row = GAME_ID_PATTERN.test(id) ? this.db.getGame(id) : null;
    if (!row) throw errors.notFound('Dieses Spiel ist nicht installiert.');
    return row;
  }

  renameGame(id: string, title: string): Game {
    this.getGame(id);
    this.db.updateGameTitle(id, sanitizeTitle(title));
    return this.toApiGame(this.getGame(id));
  }

  markPlayed(id: string): Game {
    this.getGame(id);
    this.db.markPlayed(id, new Date().toISOString());
    return this.toApiGame(this.getGame(id));
  }

  async deleteGame(id: string): Promise<void> {
    const row = this.getGame(id);
    // Zuerst aus der Datenbank entfernen: Ab diesem Moment liefert der Game-Host keine Dateien mehr aus.
    this.db.deleteGame(id);
    const target = path.join(this.dirs.trash, `${id}-${Date.now()}`);
    try {
      await rename(this.gameRoot(id), target);
      void removeInside(this.dirs.trash, target).catch((error: unknown) => this.log.error({ error }, 'Trash cleanup failed'));
    } catch (error) {
      this.log.error({ error, gameId: id }, 'Could not move game directory to trash');
      await removeInside(this.dirs.games, this.gameRoot(id)).catch(() => undefined);
    }
    if (row.cover_ext) await unlink(path.join(this.dirs.covers, `${id}.${row.cover_ext}`)).catch(() => undefined);
  }

  async readCover(id: string): Promise<{ data: Buffer; mime: string } | null> {
    const row = this.getGame(id);
    if (!row.cover_ext) return null;
    const mime = mimeForCoverExt(row.cover_ext);
    if (!mime) return null;
    try {
      return { data: await readFile(path.join(this.dirs.covers, `${id}.${row.cover_ext}`)), mime };
    } catch {
      return null;
    }
  }

  async setCover(id: string, data: Buffer): Promise<Game> {
    const row = this.getGame(id);
    if (data.length === 0 || data.length > this.config.maxCoverBytes) throw errors.imageInvalid();
    const type = detectImageType(data);
    if (!type) throw errors.imageInvalid();
    await writeFile(path.join(this.dirs.covers, `${id}.${type.ext}`), data, { mode: 0o640 });
    if (row.cover_ext && row.cover_ext !== type.ext) {
      await unlink(path.join(this.dirs.covers, `${id}.${row.cover_ext}`)).catch(() => undefined);
    }
    this.db.updateGameCover(id, type.ext);
    return this.toApiGame(this.getGame(id));
  }

  async removeCover(id: string): Promise<Game> {
    const row = this.getGame(id);
    if (row.cover_ext) await unlink(path.join(this.dirs.covers, `${id}.${row.cover_ext}`)).catch(() => undefined);
    this.db.updateGameCover(id, null);
    return this.toApiGame(this.getGame(id));
  }

  async storageInfo(): Promise<StorageInfoResponse> {
    const totals = this.db.totalGameBytes();
    const disk = await diskSpace(this.dirs.root);
    return {
      gamesCount: totals.count,
      gamesBytes: totals.bytes,
      diskFreeBytes: disk?.free ?? null,
      diskTotalBytes: disk?.total ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------

  private toUploadInfo(row: UploadRow): UploadInfo {
    return {
      id: row.id,
      fileName: row.file_name,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      analysis: row.analysis,
    };
  }

  /** Speichert den Upload-Stream in einer temporären Datei und analysiert ihn. */
  async createUpload(body: NodeJS.ReadableStream, fileName: string, declaredLength: number): Promise<UploadInfo> {
    if (!Number.isInteger(declaredLength) || declaredLength <= 0) throw errors.lengthRequired();
    if (declaredLength > this.config.maxUploadBytes) {
      throw errors.payloadTooLarge(`Das Archiv ist größer als das Limit von ${Math.round(this.config.maxUploadBytes / 1024 / 1024)} MB.`);
    }
    const disk = await diskSpace(this.dirs.root);
    if (disk && disk.free < declaredLength + DISK_MARGIN_BYTES) throw errors.insufficientStorage();

    const id = randomId();
    const partPath = path.join(this.dirs.uploads, `${id}.zip.part`);
    const finalPath = path.join(this.dirs.uploads, `${id}.zip`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > declaredLength) return callback(new UploadAbortedError('too long'));
        callback(null, chunk);
      },
    });

    try {
      await pipeline(body, limiter, createWriteStream(partPath, { flags: 'wx', mode: 0o640 }));
    } catch (error) {
      await unlink(partPath).catch(() => undefined);
      if (error instanceof UploadAbortedError) throw errors.uploadIncomplete();
      this.log.info({ error: (error as Error).message }, 'Upload aborted');
      throw errors.uploadIncomplete();
    }
    if (received !== declaredLength) {
      await unlink(partPath).catch(() => undefined);
      throw errors.uploadIncomplete();
    }
    await rename(partPath, finalPath);

    const safeName = sanitizeTitle(fileName.split(/[\\/]/).pop() ?? '', 'archiv.zip').slice(0, 200);
    let analysis;
    try {
      analysis = await analyzeArchive(finalPath, safeName, received, this.limits);
    } catch (error) {
      await unlink(finalPath).catch(() => undefined);
      throw error;
    }
    const now = new Date();
    const row: UploadRow = {
      id,
      file_name: safeName,
      size_bytes: received,
      path: finalPath,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.config.uploadTtlMs).toISOString(),
      analysis,
      state: 'ready',
    };
    // Nicht installierbare Archive werden nicht aufbewahrt – das Ergebnis der Analyse genügt.
    if (!analysis.installable) {
      await unlink(finalPath).catch(() => undefined);
      return this.toUploadInfo(row);
    }
    this.db.insertUpload(row);
    this.log.info({ uploadId: id, kind: analysis.kind, files: analysis.fileCount }, 'Upload analysed');
    return this.toUploadInfo(row);
  }

  getUpload(id: string): UploadInfo {
    const row = UPLOAD_ID_PATTERN.test(id) ? this.db.getUpload(id) : null;
    if (!row) throw errors.notFound('Dieser Upload existiert nicht (mehr).');
    if (Date.parse(row.expires_at) <= Date.now() && row.state === 'ready') throw errors.uploadExpired();
    return this.toUploadInfo(row);
  }

  private async removeUpload(row: UploadRow): Promise<void> {
    this.db.deleteUpload(row.id);
    await unlink(row.path).catch(() => undefined);
  }

  async deleteUpload(id: string): Promise<void> {
    const row = UPLOAD_ID_PATTERN.test(id) ? this.db.getUpload(id) : null;
    if (!row) throw errors.notFound('Dieser Upload existiert nicht (mehr).');
    if (row.state === 'installing') throw errors.installInProgress();
    await this.removeUpload(row);
  }

  // ---------------------------------------------------------------------------
  // Installation
  // ---------------------------------------------------------------------------

  getJob(id: string): InstallJob {
    const job = UPLOAD_ID_PATTERN.test(id) ? this.jobs.get(id) : undefined;
    if (!job) throw errors.notFound('Dieser Installationsvorgang existiert nicht.');
    return { ...job };
  }

  async startInstall(uploadId: string, requestedTitle: string | undefined): Promise<InstallJob> {
    const upload = this.getUpload(uploadId);
    if (!upload.analysis.installable) throw errors.archiveNotInstallable();
    const disk = await diskSpace(this.dirs.root);
    if (disk && disk.free < upload.analysis.uncompressedBytes + DISK_MARGIN_BYTES) throw errors.insufficientStorage();
    if (!this.db.claimUpload(uploadId)) throw errors.installInProgress();

    const now = new Date().toISOString();
    const job: InstallJob = {
      id: randomId(),
      uploadId,
      state: 'queued',
      bytesTotal: upload.analysis.uncompressedBytes,
      bytesWritten: 0,
      filesTotal: upload.analysis.fileCount,
      filesWritten: 0,
      gameId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    const title = sanitizeTitle(requestedTitle ?? upload.analysis.detectedTitle ?? '', upload.analysis.detectedTitle ?? 'Unbenanntes Spiel');
    void this.runInstall(job, title);
    return { ...job };
  }

  /** Wartet auf das Ende eines Jobs (für Tests und interne Abläufe). */
  async waitForJob(id: string, timeoutMs = 60_000): Promise<InstallJob> {
    const started = Date.now();
    for (;;) {
      const job = this.getJob(id);
      if (job.state === 'done' || job.state === 'failed') return job;
      if (Date.now() - started > timeoutMs) throw new Error('Job timeout');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private update(job: InstallJob, patch: Partial<InstallJob>): void {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  }

  private async runInstall(job: InstallJob, title: string): Promise<void> {
    const uploadRow = this.db.getUpload(job.uploadId);
    if (!uploadRow) {
      this.update(job, { state: 'failed', error: { code: 'not_found', message: 'Der Upload existiert nicht mehr.' } });
      return;
    }
    const staging = path.join(this.dirs.staging, job.id);
    const gameId = randomId();
    const gameDir = this.gameRoot(gameId);
    let coverExt: string | null = null;
    let moved = false;

    try {
      this.update(job, { state: 'extracting' });
      await ensureDir(staging);
      const result = await extractArchive(uploadRow.path, staging, uploadRow.analysis.rootPrefix, this.limits, (p) => {
        this.update(job, { bytesWritten: p.bytesWritten, filesWritten: p.filesWritten });
      });

      this.update(job, { state: 'finalizing', bytesWritten: result.bytesWritten, filesWritten: result.filesWritten });
      const entryStat = await stat(path.join(staging, 'index.html')).catch(() => null);
      if (!entryStat?.isFile()) throw new ArchiveError('missing_entry_point');

      const presplash = uploadRow.analysis.presplash;
      if (presplash) {
        try {
          const data = await readFile(path.join(staging, presplash));
          const type = data.length <= this.config.maxCoverBytes ? detectImageType(data) : null;
          if (type) {
            await writeFile(path.join(this.dirs.covers, `${gameId}.${type.ext}`), data, { mode: 0o640 });
            coverExt = type.ext;
          }
        } catch (error) {
          this.log.warn({ error: (error as Error).message }, 'Could not use presplash as cover');
        }
      }

      await rename(staging, gameDir);
      moved = true;

      this.db.transaction(() => {
        this.db.insertGame({
          id: gameId,
          title,
          entry: 'index.html',
          size_bytes: result.bytesWritten,
          file_count: result.filesWritten,
          installed_at: new Date().toISOString(),
          last_played_at: null,
          cover_ext: coverExt,
          cover_version: coverExt ? 1 : 0,
          source_file_name: uploadRow.file_name,
          runtime: uploadRow.analysis.runtime,
        });
        this.db.deleteUpload(uploadRow.id);
      });
      await unlink(uploadRow.path).catch(() => undefined);
      this.update(job, { state: 'done', gameId });
      this.log.info({ gameId, title, bytes: result.bytesWritten }, 'Game installed');
    } catch (error) {
      const code: ApiErrorCode = error instanceof AppError ? error.code : 'install_failed';
      const detail = error instanceof ArchiveError ? error.code : (error as Error).message;
      this.log.warn({ jobId: job.id, detail }, 'Installation failed');
      await removeInside(this.dirs.staging, staging).catch(() => undefined);
      if (moved) await removeInside(this.dirs.games, gameDir).catch(() => undefined);
      if (coverExt) await rm(path.join(this.dirs.covers, `${gameId}.${coverExt}`), { force: true }).catch(() => undefined);
      this.db.releaseUpload(uploadRow.id);
      this.update(job, {
        state: 'failed',
        error: {
          code,
          message:
            error instanceof ArchiveError
              ? `Das Archiv konnte nicht sicher entpackt werden (${error.code}).`
              : 'Die Installation ist fehlgeschlagen. Es wurden keine Änderungen übernommen.',
        },
      });
    }
  }
}
