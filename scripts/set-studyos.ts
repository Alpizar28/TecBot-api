/**
 * Configura (o desactiva) el destino StudyOS de un usuario.
 *
 * Uso (local o dentro del contenedor core, donde DATABASE_URL y
 * DB_ENCRYPTION_KEY ya están en el entorno):
 *   pnpm tsx scripts/set-studyos.ts <tec_username> <studyos_url> <sync_token>
 *   pnpm tsx scripts/set-studyos.ts <tec_username> --off
 *
 * Autocontenido a propósito: el root del workspace no depende de
 * @tec-brain/database, así que ciframos con node:crypto (mismo formato
 * AES-256-GCM "gcm:<iv>:<tag>:<ct>" que packages/database/src/crypto.ts)
 * y resolvemos pg desde packages/database vía createRequire.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

// process.argv[1] = ruta de este script; funciona igual en ESM y CJS
// (import.meta no está permitido cuando tsx compila a CommonJS).
const requireFromDatabase = createRequire(
  path.resolve(path.dirname(process.argv[1] ?? '.'), '../packages/database/package.json'),
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = requireFromDatabase('pg') as typeof import('pg');

const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY ?? '';
if (ENCRYPTION_KEY.length !== 64) {
  console.error('ERROR: DB_ENCRYPTION_KEY debe ser un hex string de 64 caracteres.');
  process.exit(1);
}

function encryptGcm(plainText: string): string {
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return `gcm:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const [username, urlOrFlag, token] = process.argv.slice(2);
  if (!username || !urlOrFlag || (urlOrFlag !== '--off' && !token)) {
    console.log('Uso: pnpm tsx scripts/set-studyos.ts <tec_username> <studyos_url> <sync_token>');
    console.log('     pnpm tsx scripts/set-studyos.ts <tec_username> --off');
    process.exit(1);
  }

  try {
    const res =
      urlOrFlag === '--off'
        ? await pool.query(
            `UPDATE users SET studyos_url = NULL, studyos_token_enc = NULL WHERE tec_username = $1`,
            [username],
          )
        : await pool.query(
            `UPDATE users SET studyos_url = $2, studyos_token_enc = $3 WHERE tec_username = $1`,
            [username, urlOrFlag.replace(/\/+$/, ''), encryptGcm(token as string)],
          );

    if (res.rowCount === 0) {
      console.error(`❌ No existe usuario con tec_username=${username}`);
      process.exit(1);
    }
    console.log(
      urlOrFlag === '--off'
        ? `✅ StudyOS desactivado para ${username}.`
        : `✅ StudyOS configurado para ${username}: ${urlOrFlag}`,
    );
  } finally {
    await pool.end();
  }
}

run();
