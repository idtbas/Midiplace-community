import type { ApiErrorCode } from '@renos/shared';

/** Fehler, der kontrolliert an den Client weitergegeben wird. Die Meldung darf keine Geheimnisse enthalten. */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(code: ApiErrorCode, statusCode: number, message: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const errors = {
  badRequest: (message = 'Die Anfrage ist ungültig.') => new AppError('bad_request', 400, message),
  unauthorized: () => new AppError('unauthorized', 401, 'Für diese Aktion ist eine Anmeldung erforderlich.'),
  csrf: () => new AppError('csrf_failed', 403, 'Die Sicherheitsprüfung der Anfrage ist fehlgeschlagen.'),
  forbidden: (message = 'Diese Aktion ist nicht erlaubt.') => new AppError('forbidden', 403, message),
  notFound: (message = 'Nicht gefunden.') => new AppError('not_found', 404, message),
  ownerNotConfigured: () =>
    new AppError(
      'owner_not_configured',
      503,
      'Auf dem Server ist kein Owner-Passwort eingerichtet. Upload und Verwaltung sind deaktiviert.',
    ),
  invalidCredentials: () => new AppError('invalid_credentials', 401, 'Das Passwort ist nicht korrekt.'),
  payloadTooLarge: (message = 'Die Datei ist zu groß.') => new AppError('payload_too_large', 413, message),
  lengthRequired: () => new AppError('length_required', 411, 'Die Dateigröße fehlt in der Anfrage.'),
  unsupportedMediaType: (message = 'Dieser Dateityp wird nicht unterstützt.') =>
    new AppError('unsupported_media_type', 415, message),
  uploadIncomplete: () => new AppError('upload_incomplete', 400, 'Der Upload wurde nicht vollständig übertragen.'),
  uploadExpired: () => new AppError('upload_expired', 410, 'Der Upload ist abgelaufen. Bitte die Datei erneut auswählen.'),
  archiveNotInstallable: () =>
    new AppError('archive_not_installable', 422, 'Dieses Archiv enthält keinen installierbaren Ren’Py-Web-Build.'),
  installInProgress: () => new AppError('install_in_progress', 409, 'Dieses Archiv wird bereits installiert.'),
  insufficientStorage: () =>
    new AppError('insufficient_storage', 507, 'Auf dem Server ist nicht genug Speicherplatz für die Installation frei.'),
  imageInvalid: () =>
    new AppError('image_invalid', 422, 'Das Bild ist ungültig. Unterstützt werden PNG, JPEG und WebP.'),
  internal: () => new AppError('internal_error', 500, 'Ein interner Fehler ist aufgetreten.'),
};
