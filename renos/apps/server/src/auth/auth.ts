import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, type SessionResponse } from '@renos/shared';
import type { ServerConfig } from '../config.js';
import type { Database, SessionRow } from '../db.js';
import { errors } from '../lib/errors.js';
import { randomToken } from '../lib/ids.js';
import { verifyPassword } from './password.js';

export const SESSION_COOKIE = 'renos_session';
const SLIDING_RENEW_MS = 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Single-Owner-Authentifizierung.
 * - Das Session-Token liegt nur im HttpOnly-Cookie; in der Datenbank wird lediglich sein SHA-256 gespeichert.
 * - Verändernde Anfragen benötigen zusätzlich das CSRF-Token im Header und einen passenden Origin.
 */
export class AuthService {
  constructor(
    private readonly config: ServerConfig,
    private readonly db: Database,
    private readonly ownerHash: string | null,
  ) {}

  get ownerConfigured(): boolean {
    return this.ownerHash !== null;
  }

  private cookieOptions() {
    return {
      path: '/api',
      httpOnly: true,
      sameSite: 'strict' as const,
      secure: this.config.appOrigin.startsWith('https://'),
    };
  }

  async login(password: string, reply: FastifyReply): Promise<SessionResponse> {
    if (!this.ownerHash) throw errors.ownerNotConfigured();
    if (typeof password !== 'string' || password.length === 0 || !(await verifyPassword(password, this.ownerHash))) {
      throw errors.invalidCredentials();
    }
    const token = randomToken(32);
    const csrf = randomToken(24);
    const now = Date.now();
    const expiresAt = new Date(now + this.config.sessionTtlMs).toISOString();
    this.db.deleteExpiredSessions(new Date(now).toISOString());
    this.db.insertSession({ id_hash: sha256(token), csrf_token: csrf, created_at: new Date(now).toISOString(), expires_at: expiresAt });
    reply.setCookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: Math.floor(this.config.sessionTtlMs / 1000) });
    return { authenticated: true, ownerConfigured: true, csrfToken: csrf, expiresAt };
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies[SESSION_COOKIE];
    if (token) this.db.deleteSession(sha256(token));
    reply.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  /** Ermittelt die Session der Anfrage (mit gleitender Verlängerung). */
  resolve(request: FastifyRequest, reply?: FastifyReply): SessionRow | null {
    const token = request.cookies[SESSION_COOKIE];
    if (!token || token.length > 200) return null;
    const session = this.db.getSession(sha256(token));
    if (!session) return null;
    const now = Date.now();
    const expires = Date.parse(session.expires_at);
    if (expires <= now) {
      this.db.deleteSession(session.id_hash);
      return null;
    }
    if (reply && expires - now < this.config.sessionTtlMs - SLIDING_RENEW_MS) {
      const renewed = new Date(now + this.config.sessionTtlMs).toISOString();
      this.db.extendSession(session.id_hash, renewed);
      reply.setCookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: Math.floor(this.config.sessionTtlMs / 1000) });
      session.expires_at = renewed;
    }
    return session;
  }

  sessionInfo(request: FastifyRequest, reply: FastifyReply): SessionResponse {
    const session = this.resolve(request, reply);
    return {
      authenticated: session !== null,
      ownerConfigured: this.ownerConfigured,
      csrfToken: session?.csrf_token ?? null,
      expiresAt: session?.expires_at ?? null,
    };
  }

  /** Prüft den Origin-Header verändernder Anfragen (sofern der Client ihn sendet). */
  checkOrigin(request: FastifyRequest): void {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.config.appOrigin) throw errors.forbidden('Anfragen von dieser Herkunft sind nicht erlaubt.');
  }

  /** Erfordert eine gültige Session; bei verändernden Anfragen zusätzlich CSRF-Token und Origin. */
  requireOwner(request: FastifyRequest, reply: FastifyReply): SessionRow {
    if (!this.ownerHash) throw errors.ownerNotConfigured();
    const session = this.resolve(request, reply);
    if (!session) throw errors.unauthorized();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      this.checkOrigin(request);
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, session.csrf_token)) throw errors.csrf();
    }
    return session;
  }

  /** Lesezugriff: offen, wenn die Bibliothek öffentlich ist, sonst nur für den Owner. */
  requireReader(request: FastifyRequest, reply: FastifyReply): void {
    if (this.config.publicLibrary) return;
    if (!this.ownerHash) throw errors.ownerNotConfigured();
    if (!this.resolve(request, reply)) throw errors.unauthorized();
  }
}
