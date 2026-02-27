import fs from 'fs';
import path from 'path';
import { TecHttpClient } from '../clients/tec-http.client.js';
import { logger as appLogger } from '../logger.js';

interface LoggerLike {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
}

interface StoredCookie {
    key: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: string;
    secure?: boolean;
    httpOnly?: boolean;
}

/**
 * Manages HTTP clients per user.
 * Sessions are persisted to disk in `sessionDir/{username}.json`.
 */
export class SessionManager {
    private readonly sessionDir: string;
    private readonly logger: LoggerLike;

    constructor(sessionDir: string, logger: LoggerLike = appLogger.child({ component: 'session_manager' })) {
        this.sessionDir = sessionDir;
        this.logger = logger;
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    private sessionPath(username: string): string {
        const safe = username.replace(/[^a-zA-Z0-9@._-]/g, '_');
        return path.join(this.sessionDir, `${safe}.json`);
    }

    private loadSavedCookies(username: string): StoredCookie[] | null {
        const p = this.sessionPath(username);
        if (!fs.existsSync(p)) return null;

        try {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
            if (!Array.isArray(parsed)) {
                this.quarantineBrokenSessionFile(p, username, 'session file is not an array');
                return null;
            }

            const cookies = parsed.filter(isStoredCookie);
            if (cookies.length === 0) {
                this.quarantineBrokenSessionFile(p, username, 'session has no valid cookies');
                return null;
            }

            return cookies;
        } catch (error) {
            this.quarantineBrokenSessionFile(
                p,
                username,
                error instanceof Error ? error.message : String(error),
            );
            return null;
        }
    }

    private quarantineBrokenSessionFile(pathToFile: string, username: string, reason: string): void {
        const quarantinePath = `${pathToFile}.corrupt.${Date.now()}`;
        try {
            fs.renameSync(pathToFile, quarantinePath);
        } catch {
            // Ignore rename errors and keep moving to login fallback.
        }
        this.logger.warn({ username, reason, quarantinePath }, 'Invalid session file was quarantined');
    }

    private saveCookies(username: string, cookies: StoredCookie[]): void {
        fs.writeFileSync(this.sessionPath(username), JSON.stringify(cookies, null, 2));
    }

    /**
     * Returns an authenticated HTTP client.
     * Tries to restore from disk first. Falls back to fresh login.
     */
    async getClient(username: string, password: string): Promise<TecHttpClient> {
        const client = new TecHttpClient(buildChildLogger(this.logger, { username }));

        const saved = this.loadSavedCookies(username);
        if (saved && saved.length > 0) {
            for (const c of saved) {
                const domain = (c.domain ?? 'tecdigital.tec.ac.cr').replace(/^\./, '');
                const cookiePath = c.path ?? '/';
                if (isExpired(c.expires)) continue;

                const cookieParts = [
                    `${c.key}=${c.value}`,
                    `Domain=${domain}`,
                    `Path=${cookiePath}`,
                ];
                if (c.secure) cookieParts.push('Secure');
                if (c.httpOnly) cookieParts.push('HttpOnly');
                if (c.expires) cookieParts.push(`Expires=${c.expires}`);

                await client.jar.setCookie(cookieParts.join('; '), `https://${domain}${cookiePath}`);
            }

            const isValid = await this.validateSession(client);
            if (isValid) {
                this.logger.info({ username }, 'Restored API session');
                return client;
            }
            this.logger.info({ username }, 'Saved API session expired, re-authenticating');
            client.jar.removeAllCookiesSync();
        }

        await this.login(client, username, password);
        return client;
    }

    private async validateSession(client: TecHttpClient): Promise<boolean> {
        return client.verifySession();
    }

    async login(client: TecHttpClient, username: string, password: string): Promise<void> {
        this.logger.info({ username }, 'Performing API login');

        const success = await client.login(username, password);

        if (!success) {
            throw new Error('Login fallido: Credenciales inválidas o acceso denegado por API');
        }

        const rawCookies = await client.jar.getCookies('https://tecdigital.tec.ac.cr/');

        this.saveCookies(username, rawCookies.map((c) => ({
            key: c.key,
            value: c.value,
            domain: c.domain ?? undefined,
            path: c.path ?? undefined,
            expires:
                c.expires && c.expires !== 'Infinity'
                    ? c.expires.toUTCString()
                    : undefined,
            secure: c.secure,
            httpOnly: c.httpOnly,
        })));

        this.logger.info({ username }, 'API login successful and session persisted');
    }

    async getCookies(client: TecHttpClient): Promise<any[]> {
        const raw = await client.jar.getCookies('https://tecdigital.tec.ac.cr/');
        return raw.map((c) => ({
            name: c.key,
            value: c.value,
            domain: c.domain ?? undefined,
            path: c.path ?? undefined,
        }));
    }
}

function isExpired(expires?: string): boolean {
    if (!expires) return false;
    const ms = Date.parse(expires);
    if (Number.isNaN(ms)) return false;
    return ms <= Date.now();
}

function isStoredCookie(value: unknown): value is StoredCookie {
    if (!value || typeof value !== 'object') return false;

    const maybeCookie = value as Record<string, unknown>;
    return typeof maybeCookie.key === 'string' && typeof maybeCookie.value === 'string';
}

function buildChildLogger(logger: LoggerLike, bindings: Record<string, unknown>): LoggerLike {
    const maybeChild = (logger as { child?: (value: Record<string, unknown>) => LoggerLike }).child;
    if (typeof maybeChild === 'function') {
        return maybeChild(bindings);
    }
    return logger;
}
