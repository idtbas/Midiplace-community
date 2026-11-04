import {
  CSRF_HEADER,
  type ApiErrorBody,
  type ApiErrorCode,
  type Game,
  type GamesResponse,
  type HealthResponse,
  type InstallJob,
  type SessionResponse,
  type StorageInfoResponse,
  type UploadInfo,
} from '@renos/shared';
import { t } from '@/i18n';

/** Fehler eines API-Aufrufs mit verständlicher deutscher Meldung. */
export class ApiError extends Error {
  readonly code: ApiErrorCode | 'network' | 'aborted';
  readonly status: number;

  constructor(code: ApiErrorCode | 'network' | 'aborted', status: number, message?: string) {
    super(message ?? describeError(code));
    this.code = code;
    this.status = status;
  }
}

export function describeError(code: ApiErrorCode | 'network' | 'aborted' | string): string {
  if (code === 'network') return t.errors.network;
  if (code === 'aborted') return t.errors.aborted;
  return (t.errors.api as Record<string, string>)[code] ?? t.errors.generic;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return t.errors.generic;
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error?.code) return new ApiError(body.error.code, response.status);
  } catch {
    /* kein JSON */
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) return new ApiError('network', response.status);
  return new ApiError('internal_error', response.status);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  rawBody?: Blob;
  contentType?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.rawBody) {
    body = options.rawBody;
    headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  options.signal?.addEventListener('abort', () => controller.abort());
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (options.signal?.aborted) throw new ApiError('aborted', 0);
    throw new ApiError('network', 0, error instanceof Error && error.name === 'AbortError' ? t.errors.network : undefined);
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => apiRequest<HealthResponse>('/api/health', { timeoutMs: 6000 }),
  session: () => apiRequest<SessionResponse>('/api/auth/session', { timeoutMs: 6000 }),
  login: (password: string) => apiRequest<SessionResponse>('/api/auth/login', { method: 'POST', body: { password } }),
  logout: () => apiRequest<SessionResponse>('/api/auth/logout', { method: 'POST', body: {} }),
  games: () => apiRequest<GamesResponse>('/api/games'),
  game: (id: string) => apiRequest<{ game: Game }>(`/api/games/${encodeURIComponent(id)}`),
  renameGame: (id: string, title: string) => apiRequest<{ game: Game }>(`/api/games/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } }),
  deleteGame: (id: string) => apiRequest<void>(`/api/games/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  markPlayed: (id: string) => apiRequest<{ game: Game }>(`/api/games/${encodeURIComponent(id)}/played`, { method: 'POST', body: {} }),
  setCover: (id: string, image: Blob) =>
    apiRequest<{ game: Game }>(`/api/games/${encodeURIComponent(id)}/cover`, { method: 'PUT', rawBody: image, contentType: image.type, timeoutMs: 60_000 }),
  removeCover: (id: string) => apiRequest<{ game: Game }>(`/api/games/${encodeURIComponent(id)}/cover`, { method: 'DELETE' }),
  storage: () => apiRequest<StorageInfoResponse>('/api/storage'),
  upload: (id: string) => apiRequest<{ upload: UploadInfo }>(`/api/uploads/${encodeURIComponent(id)}`),
  discardUpload: (id: string) => apiRequest<void>(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  install: (uploadId: string, title: string) =>
    apiRequest<{ job: InstallJob }>(`/api/uploads/${encodeURIComponent(uploadId)}/install`, { method: 'POST', body: { title } }),
  job: (id: string) => apiRequest<{ job: InstallJob }>(`/api/jobs/${encodeURIComponent(id)}`),
};

export interface UploadHandle {
  promise: Promise<UploadInfo>;
  abort: () => void;
}

/**
 * Lädt ein Archiv per XMLHttpRequest hoch. Nur XHR liefert in Safari einen echten Upload-Fortschritt.
 * Der Fortschritt entspricht den tatsächlich übertragenen Bytes.
 */
export function uploadArchive(file: Blob, fileName: string, onProgress: (loaded: number, total: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadInfo>((resolve, reject) => {
    xhr.open('POST', `/api/uploads?name=${encodeURIComponent(fileName)}`);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.setRequestHeader('Accept', 'application/json');
    if (csrfToken) xhr.setRequestHeader(CSRF_HEADER, csrfToken);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* kein JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object' && 'upload' in body) {
        resolve((body as { upload: UploadInfo }).upload);
        return;
      }
      const code = (body as ApiErrorBody | null)?.error?.code;
      reject(new ApiError(code ?? (xhr.status >= 500 ? 'internal_error' : 'bad_request'), xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('network', 0));
    xhr.onabort = () => reject(new ApiError('aborted', 0));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
