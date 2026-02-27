import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/**
 * Encrypts a plain text string using AES-256-CBC.
 * Requires DB_ENCRYPTION_KEY env var (32-byte hex string).
 */
export function encrypt(plainText: string): string {
    const key = getKeyBuffer();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a ciphertext string produced by `encrypt`.
 */
export function decrypt(cipherText: string): string {
    const key = getKeyBuffer();
    const [ivHex, encryptedHex] = cipherText.split(':');
    if (!ivHex || !encryptedHex) {
        throw new Error('Invalid ciphertext format');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}

function getKeyBuffer(): Buffer {
    const key = process.env.DB_ENCRYPTION_KEY;
    if (!key || key.length !== 64) {
        throw new Error('DB_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    return Buffer.from(key, 'hex');
}
