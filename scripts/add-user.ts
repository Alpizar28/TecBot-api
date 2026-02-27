import 'dotenv/config';
import crypto from 'crypto';
import pg from 'pg';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    console.error('ERROR: DB_ENCRYPTION_KEY debe ser un hex string de 64 caracteres en el .env');
    process.exit(1);
}

function encrypt(plainText: string): string {
    const key = Buffer.from(ENCRYPTION_KEY as string, 'hex');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    const argv = process.argv.slice(2);
    if (argv.length < 5) {
        console.log('Uso: npx tsx scripts/add-user.ts <name> <tec_username> <tec_password> <telegram_chat_id> <drive_root_folder_id>');
        process.exit(1);
    }

    const [name, tec_username, tec_password, telegram_chat_id, drive_root_folder_id] = argv;
    const encrypted_pwd = encrypt(tec_password);

    try {
        await pool.query(
            `INSERT INTO users (name, tec_username, tec_password_enc, telegram_chat_id, drive_root_folder_id, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             ON CONFLICT (tec_username) DO UPDATE 
             SET tec_password_enc = EXCLUDED.tec_password_enc, 
                 telegram_chat_id = EXCLUDED.telegram_chat_id, 
                 drive_root_folder_id = EXCLUDED.drive_root_folder_id`,
            [name, tec_username, encrypted_pwd, telegram_chat_id, drive_root_folder_id]
        );
        console.log(`✅ Usuario ${name} (${tec_username}) registrado/actualizado con éxito.`);
    } catch (err) {
        console.error('❌ Error al insertar usuario:', err);
    } finally {
        await pool.end();
    }
}

run();
