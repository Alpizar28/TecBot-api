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
    const compiledDir = path.join(__dirname, 'migrations');
    const sourceDir = path.join(__dirname, '..', 'src', 'migrations');
    const dir = migrationsDir ?? (fs.existsSync(compiledDir) ? compiledDir : sourceDir);

    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

  // Core and bot start together in production. Serialize schema changes so two
  // CREATE TABLE IF NOT EXISTS statements cannot race on a new deployment.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('tec-brain-migrations'))");
    try {
      for (const file of files) {
        if (file.includes('seed')) continue; // Seeds run separately
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        console.log(`[DB] Running migration: ${file}`);
        await client.query(sql);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('tec-brain-migrations'))");
    }
  } finally {
    client.release();
  }

  console.log('[DB] All migrations applied.');
}
