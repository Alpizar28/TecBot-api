/**
 * Configura (o desactiva) el destino StudyOS de un usuario.
 *
 * Uso:
 *   npx tsx scripts/set-studyos.ts <tec_username> <studyos_url> <sync_token>
 *   npx tsx scripts/set-studyos.ts <tec_username> --off
 *
 * El token se cifra con AES-256-GCM (mismo formato que el resto de secretos).
 * Requiere DATABASE_URL y DB_ENCRYPTION_KEY en el entorno/.env.
 */
import 'dotenv/config';
import pg from 'pg';
import { encrypt } from '@tec-brain/database';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const [username, urlOrFlag, token] = process.argv.slice(2);
  if (!username || !urlOrFlag || (urlOrFlag !== '--off' && !token)) {
    console.log('Uso: npx tsx scripts/set-studyos.ts <tec_username> <studyos_url> <sync_token>');
    console.log('     npx tsx scripts/set-studyos.ts <tec_username> --off');
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
            [username, urlOrFlag.replace(/\/+$/, ''), encrypt(token as string)],
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
