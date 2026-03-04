import crypto from 'crypto';
import { getPool } from './client.js';

const ALGORITHM_GCM = 'aes-256-gcm';
const ALGORITHM_CBC = 'aes-256-cbc';
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const CBC_IV_LENGTH = 16;

/**
 * Encrypts a plain text string using AES-256-GCM (authenticated encryption).
 * Output format: "gcm:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 * Requires DB_ENCRYPTION_KEY env var (64-character hex string = 32 bytes).
 */
export function encrypt(plainText: string): string {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM_GCM, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a ciphertext string produced by `encrypt`.
 * Supports both the current GCM format ("gcm:<iv>:<tag>:<ct>")
 * and the legacy CBC format ("<iv_hex>:<ct_hex>") for backward compatibility.
 */
export function decrypt(cipherText: string): string {
  if (cipherText.startsWith('gcm:')) {
    return decryptGcm(cipherText);
  }
  return decryptCbc(cipherText);
}

function decryptGcm(cipherText: string): string {
  const key = getKeyBuffer();
  const parts = cipherText.split(':');
  // format: gcm:<iv>:<tag>:<ciphertext>
  if (parts.length !== 4 || parts[0] !== 'gcm') {
    throw new Error('Invalid GCM ciphertext format');
  }
  const [, ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  if (iv.length !== GCM_IV_LENGTH) throw new Error('Invalid GCM IV length');
  if (tag.length !== GCM_TAG_LENGTH) throw new Error('Invalid GCM auth tag length');

  const decipher = crypto.createDecipheriv(ALGORITHM_GCM, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Legacy CBC decryption — used only to read old rows before they are re-encrypted. */
function decryptCbc(cipherText: string): string {
  const key = getKeyBuffer();
  const [ivHex, encryptedHex] = cipherText.split(':');
  if (!ivHex || !encryptedHex) {
    throw new Error('Invalid ciphertext format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  if (iv.length !== CBC_IV_LENGTH) throw new Error('Invalid CBC IV length');
  const decipher = crypto.createDecipheriv(ALGORITHM_CBC, key, iv);
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

/**
 * One-time migration: finds all CBC-encrypted values in the database and
 * re-encrypts them with AES-256-GCM. Safe to run multiple times — GCM rows
 * (prefixed "gcm:") are skipped automatically.
 */
export async function reEncryptLegacyCbcRows(): Promise<void> {
  const pool = getPool();
  let reEncrypted = 0;

  // ── users.tec_password_enc ───────────────────────────────────────────────
  const userRows = await pool.query<{ id: string; tec_password_enc: string }>(
    "SELECT id, tec_password_enc FROM users WHERE tec_password_enc NOT LIKE 'gcm:%'",
  );
  for (const row of userRows.rows) {
    const plain = decryptCbc(row.tec_password_enc);
    const newCt = encrypt(plain);
    await pool.query('UPDATE users SET tec_password_enc = $1 WHERE id = $2', [newCt, row.id]);
    reEncrypted++;
  }

  // ── users.drive_oauth_token_enc ──────────────────────────────────────────
  const driveRows = await pool.query<{ id: string; drive_oauth_token_enc: string }>(
    "SELECT id, drive_oauth_token_enc FROM users WHERE drive_oauth_token_enc IS NOT NULL AND drive_oauth_token_enc NOT LIKE 'gcm:%'",
  );
  for (const row of driveRows.rows) {
    const plain = decryptCbc(row.drive_oauth_token_enc);
    const newCt = encrypt(plain);
    await pool.query('UPDATE users SET drive_oauth_token_enc = $1 WHERE id = $2', [newCt, row.id]);
    reEncrypted++;
  }

  // ── pending_registrations.tec_password_enc ───────────────────────────────
  const pendingRows = await pool.query<{ chat_id: string; tec_password_enc: string }>(
    "SELECT chat_id, tec_password_enc FROM pending_registrations WHERE tec_password_enc IS NOT NULL AND tec_password_enc NOT LIKE 'gcm:%'",
  );
  for (const row of pendingRows.rows) {
    const plain = decryptCbc(row.tec_password_enc);
    const newCt = encrypt(plain);
    await pool.query('UPDATE pending_registrations SET tec_password_enc = $1 WHERE chat_id = $2', [
      newCt,
      row.chat_id,
    ]);
    reEncrypted++;
  }

  if (reEncrypted > 0) {
    console.log(`[crypto] Re-encrypted ${reEncrypted} CBC row(s) to AES-256-GCM`);
  }
}
