import { Readable } from 'stream';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import axios from 'axios';
import { google, type drive_v3 } from 'googleapis';
import type { Cookie } from '@tec-brain/types';
import { logger } from './logger.js';

export interface UploadResult {
    fileId: string;
    fileName: string;
}

export class DriveService {
    private readonly drive: drive_v3.Drive;

    constructor(credentialsPath: string) {
        const credentialsJson = readFileSync(credentialsPath, 'utf8');
        const credentials = JSON.parse(credentialsJson);
        const scopes = ['https://www.googleapis.com/auth/drive.file'];

        if (credentials?.type === 'service_account') {
            const auth = new google.auth.GoogleAuth({
                keyFile: credentialsPath,
                scopes,
            });
            this.drive = google.drive({ version: 'v3', auth });
            return;
        }

        const oauthClientConfig = credentials.installed || credentials.web;
        if (!oauthClientConfig) {
            throw new Error('Unsupported Google Drive credentials format. Expected service_account or OAuth client JSON.');
        }

        const tokenPath =
            process.env.GOOGLE_DRIVE_TOKEN_PATH ||
            resolve(dirname(credentialsPath), 'token.json');

        const tokenJson = readFileSync(tokenPath, 'utf8');
        const token = JSON.parse(tokenJson);

        const oauth2 = new google.auth.OAuth2(
            oauthClientConfig.client_id,
            oauthClientConfig.client_secret,
            (oauthClientConfig.redirect_uris && oauthClientConfig.redirect_uris[0]) || undefined,
        );
        oauth2.setCredentials(token);

        this.drive = google.drive({ version: 'v3', auth: oauth2 });
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
     * Downloads a file from a URL (using session cookies) and uploads it to Drive.
     */
    async downloadAndUpload(
        downloadUrl: string,
        fileName: string,
        parentFolderId: string,
        cookies: Cookie[],
    ): Promise<UploadResult> {
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

        const fileRes = await axios.get<ArrayBuffer>(downloadUrl, {
            responseType: 'arraybuffer',
            headers: {
                Cookie: cookieHeader,
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            timeout: 60_000,
        });

        const stream = Readable.from(Buffer.from(fileRes.data));
        const contentType =
            (fileRes.headers['content-type'] as string | undefined) ?? 'application/octet-stream';

        const res = await this.drive.files.create({
            requestBody: { name: fileName, parents: [parentFolderId] },
            media: { mimeType: contentType, body: stream },
            fields: 'id',
        });

        const fileId = res.data.id;
        if (!fileId) throw new Error(`Upload failed for file: ${fileName}`);

        return { fileId, fileName };
    }
}
