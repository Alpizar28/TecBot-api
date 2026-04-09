import { Readable } from 'stream';
import { readFileSync, existsSync } from 'fs';
import axios from 'axios';
import { google, type drive_v3 } from 'googleapis';
import { logger } from './logger.js';

export interface UploadResult {
  fileId: string;
  fileName: string;
  webUrl?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OneDriveOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const HTTP_RETRY_ATTEMPTS = parseInt(process.env.HTTP_RETRY_ATTEMPTS ?? '3', 10);
const HTTP_RETRY_BASE_MS = parseInt(process.env.HTTP_RETRY_BASE_MS ?? '400', 10);

/**
 * Loads the OAuth2 client config from the JSON file created in Google Cloud Console.
 * If the environment variable OAUTH_REDIRECT_URI is set, it overrides the redirect_uri
 * from the credentials file — useful when the server runs on a remote host.
 */
export function loadOAuthClientConfig(oauthClientPath: string): OAuthClient {
  if (!existsSync(oauthClientPath)) {
    throw new Error(`OAuth client file not found: ${oauthClientPath}`);
  }
  const raw = JSON.parse(readFileSync(oauthClientPath, 'utf8'));
  const cfg = raw.web || raw.installed;
  if (!cfg) throw new Error('Unsupported OAuth client JSON format');
  return {
    clientId: cfg.client_id,
    clientSecret: cfg.client_secret,
    redirectUri: process.env.OAUTH_REDIRECT_URI ?? cfg.redirect_uris[0],
  };
}

export function loadOneDriveOAuthConfig(): OneDriveOAuthClient {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;
  const redirectUri = process.env.ONEDRIVE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing OneDrive OAuth env vars (ONEDRIVE_CLIENT_ID/SECRET/REDIRECT)');
  }
  return { clientId, clientSecret, redirectUri };
}

/**
 * Returns the Google OAuth2 authorization URL the user must open in their browser.
 */
export function getAuthorizationUrl(oauthClient: OAuthClient, state?: string): string {
  const oauth2 = new google.auth.OAuth2(
    oauthClient.clientId,
    oauthClient.clientSecret,
    oauthClient.redirectUri,
  );

  const options: Parameters<typeof oauth2.generateAuthUrl>[0] = {
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive'],
    prompt: 'consent', // force refresh_token on every authorization
  };

  if (state) {
    options.state = state;
  }

  return oauth2.generateAuthUrl(options);
}

export function getOneDriveAuthorizationUrl(
  oauthClient: OneDriveOAuthClient,
  state?: string,
): string {
  const params = new URLSearchParams({
    client_id: oauthClient.clientId,
    response_type: 'code',
    redirect_uri: oauthClient.redirectUri,
    response_mode: 'query',
    scope: 'offline_access Files.ReadWrite',
  });

  if (state) params.set('state', state);

  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchanges an authorization code for tokens. Returns the token JSON string to persist.
 */
export async function exchangeCodeForTokens(
  oauthClient: OAuthClient,
  code: string,
): Promise<string> {
  const oauth2 = new google.auth.OAuth2(
    oauthClient.clientId,
    oauthClient.clientSecret,
    oauthClient.redirectUri,
  );
  const { tokens } = await oauth2.getToken(code);
  return JSON.stringify(tokens);
}

export async function exchangeOneDriveCodeForTokens(
  oauthClient: OneDriveOAuthClient,
  code: string,
): Promise<string> {
  const params = new URLSearchParams({
    client_id: oauthClient.clientId,
    client_secret: oauthClient.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauthClient.redirectUri,
  });

  const res = await axios.post(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const payload = res.data as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = payload.expires_in
    ? Date.now() + payload.expires_in * 1000
    : Date.now() + 3600 * 1000;

  return JSON.stringify({ ...payload, expires_at: expiresAt });
}

interface OneDriveTokenPayload {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
}

export class DriveService {
  private readonly drive: drive_v3.Drive;

  /**
   * Build a DriveService from a persisted OAuth token JSON string.
   * The token string must contain at minimum `access_token` and `refresh_token`.
   */
  static fromOAuthToken(oauthClient: OAuthClient, tokenJson: string): DriveService {
    const tokens = JSON.parse(tokenJson);
    const oauth2 = new google.auth.OAuth2(
      oauthClient.clientId,
      oauthClient.clientSecret,
      oauthClient.redirectUri,
    );
    oauth2.setCredentials(tokens);
    return new DriveService(google.drive({ version: 'v3', auth: oauth2 }));
  }

  /**
   * Build a DriveService from a Service Account credentials file.
   * Note: Service Accounts have no storage quota and cannot upload to personal Drive.
   * Only use this for Shared Drives (Team Drives).
   */
  static fromServiceAccount(credentialsPath: string): DriveService {
    if (!existsSync(credentialsPath)) {
      throw new Error(`Google Drive credentials file not found: ${credentialsPath}`);
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return new DriveService(google.drive({ version: 'v3', auth }));
  }

  private constructor(drive: drive_v3.Drive) {
    this.drive = drive;
  }

  /**
   * Finds a folder by name under a given parent. Returns its ID or null.
   */
  async findFolder(name: string, parentId: string): Promise<string | null> {
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `'${parentId}' in parents`,
      `trashed = false`,
    ].join(' and ');

    const res = await this.drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
    return res.data.files?.[0]?.id ?? null;
  }

  /**
   * Creates a folder and returns its ID.
   */
  async createFolder(name: string, parentId: string): Promise<string> {
    const res = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    });
    const id = res.data.id;
    if (!id) throw new Error(`Failed to create folder: ${name}`);
    return id;
  }

  /**
   * Ensures a folder exists (finds or creates). Returns the folder ID.
   */
  async ensureFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.findFolder(name, parentId);
    if (existing) return existing;
    logger.info({ component: 'drive_service', folderName: name, parentId }, 'Creating folder');
    return this.createFolder(name, parentId);
  }

  /**
   * Downloads a file using the provided downloader function and uploads it to Drive.
   * The downloader is responsible for fetching the file bytes and content-type,
   * abstracting away session/cookie handling.
   */
  async downloadAndUpload(
    downloader: () => Promise<{ data: ArrayBuffer; contentType: string }>,
    fileName: string,
    parentFolderId: string,
  ): Promise<UploadResult> {
    const { data, contentType } = await withRetry(downloader, 'tec.file_download');

    const fileBuffer = Buffer.from(data);

    const res = await withRetry(
      () =>
        this.drive.files.create({
          requestBody: { name: fileName, parents: [parentFolderId] },
          media: { mimeType: contentType, body: Readable.from(fileBuffer) },
          fields: 'id',
        }),
      'drive.file_upload',
    );

    const fileId = res.data.id;
    if (!fileId) throw new Error(`Upload failed for file: ${fileName}`);

    return {
      fileId,
      fileName,
      webUrl: `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
    };
  }
}

export class OneDriveService {
  private readonly oauthClient: OneDriveOAuthClient;
  private token: OneDriveTokenPayload;
  private readonly onTokenRefresh?: (tokenJson: string) => Promise<void>;

  static fromOAuthToken(
    oauthClient: OneDriveOAuthClient,
    tokenJson: string,
    onTokenRefresh?: (tokenJson: string) => Promise<void>,
  ): OneDriveService {
    const token = JSON.parse(tokenJson) as OneDriveTokenPayload;
    return new OneDriveService(oauthClient, token, onTokenRefresh);
  }

  private constructor(
    oauthClient: OneDriveOAuthClient,
    token: OneDriveTokenPayload,
    onTokenRefresh?: (tokenJson: string) => Promise<void>,
  ) {
    this.oauthClient = oauthClient;
    this.token = token;
    this.onTokenRefresh = onTokenRefresh;
  }

  async ensureFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.findFolder(name, parentId);
    if (existing) return existing;
    logger.info({ component: 'onedrive_service', folderName: name, parentId }, 'Creating folder');
    return this.createFolder(name, parentId);
  }

  async downloadAndUpload(
    downloader: () => Promise<{ data: ArrayBuffer; contentType: string }>,
    fileName: string,
    parentFolderId: string,
  ): Promise<UploadResult> {
    const { data, contentType } = await withRetry(downloader, 'tec.file_download');
    const buffer = Buffer.from(data);

    const accessToken = await this.getAccessToken();
    const encodedName = encodeURIComponent(fileName);
    const res = await withRetry(
      () =>
        axios.put(
          `https://graph.microsoft.com/v1.0/me/drive/items/${parentFolderId}:/${encodedName}:/content`,
          buffer,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': contentType,
            },
          },
        ),
      'onedrive.file_upload',
    );

    const fileId = (res.data as { id?: string; webUrl?: string }).id;
    if (!fileId) throw new Error(`Upload failed for file: ${fileName}`);
    return {
      fileId,
      fileName,
      webUrl: (res.data as { webUrl?: string }).webUrl,
    };
  }

  private async findFolder(name: string, parentId: string): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const safeName = name.replace(/'/g, "''");
    const filter = `$filter=name eq '${safeName}' and folder ne null`;
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children?${filter}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const items = (res.data as { value?: Array<{ id?: string }> }).value ?? [];
    return items[0]?.id ?? null;
  }

  private async createFolder(name: string, parentId: string): Promise<string> {
    const accessToken = await this.getAccessToken();
    const res = await axios.post(
      `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children`,
      {
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      },
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const folderId = (res.data as { id?: string }).id;
    if (!folderId) throw new Error(`Failed to create OneDrive folder: ${name}`);
    return folderId;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    const expiresAt = this.token.expires_at ?? now + 1;
    if (expiresAt - now > 60_000) {
      return this.token.access_token;
    }

    if (!this.token.refresh_token) {
      throw new Error('OneDrive refresh_token missing');
    }

    const params = new URLSearchParams({
      client_id: this.oauthClient.clientId,
      client_secret: this.oauthClient.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.token.refresh_token,
      redirect_uri: this.oauthClient.redirectUri,
      scope: 'offline_access Files.ReadWrite',
    });

    const res = await axios.post(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const payload = res.data as OneDriveTokenPayload;
    const expiresAtNew = payload.expires_in
      ? Date.now() + payload.expires_in * 1000
      : Date.now() + 3600 * 1000;
    this.token = {
      ...this.token,
      ...payload,
      expires_at: expiresAtNew,
    };

    if (this.onTokenRefresh) {
      await this.onTokenRefresh(JSON.stringify(this.token));
    }

    return this.token.access_token;
  }
}

async function withRetry<T>(request: () => Promise<T>, endpoint: string): Promise<T> {
  const maxAttempts = Math.max(1, HTTP_RETRY_ATTEMPTS);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      const sleepMs = backoffWithJitter(attempt, HTTP_RETRY_BASE_MS);
      logger.warn(
        { component: 'drive_service', endpoint, attempt, sleepMs },
        'Retrying failed request',
      );
      await sleep(sleepMs);
    }
  }

  throw new Error(`Retry loop exhausted for ${endpoint}`);
}

function isRetryableError(error: unknown): boolean {
  // For googleapis errors, check the HTTP status
  const maybeStatus =
    (error as { status?: number; code?: number })?.status ??
    (error as { status?: number; code?: number })?.code;
  if (typeof maybeStatus === 'number') {
    return maybeStatus >= 500 || maybeStatus === 408 || maybeStatus === 429;
  }
  // Unknown error type — retry
  return true;
}

function backoffWithJitter(attempt: number, baseMs: number): number {
  const cappedAttempt = Math.min(attempt, 6);
  const exp = baseMs * 2 ** (cappedAttempt - 1);
  const jitter = Math.floor(Math.random() * baseMs);
  return exp + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
