import pg from 'pg';

const { Pool } = pg;

/**
 * Singleton PostgreSQL connection pool.
 * Reads DATABASE_URL from environment.
 */
let pool: pg.Pool | null = null;

export function getPool(databaseUrl?: string): pg.Pool {
    if (!pool) {
        const url = databaseUrl ?? process.env.DATABASE_URL;
        if (!url) {
            throw new Error('DATABASE_URL environment variable is required');
        }
        pool = new Pool({
            connectionString: url,
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        });

        pool.on('error', (err) => {
            console.error('[DB] Unexpected pool error:', err);
        });
    }
    return pool;
}

export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

export type { pg };
