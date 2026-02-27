import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs all SQL migration files in order. Safe to run multiple times.
 */
export async function runMigrations(migrationsDir?: string): Promise<void> {
    const pool = getPool();
    const dir = migrationsDir ?? path.join(__dirname, 'migrations');

    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (file.includes('seed')) continue; // Seeds run separately
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        console.log(`[DB] Running migration: ${file}`);
        await pool.query(sql);
    }

    console.log('[DB] All migrations applied.');
}
