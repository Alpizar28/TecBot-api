/**
 * Lista o desactiva usuarios (los saca del ciclo de scraping sin borrar datos).
 *
 * Uso (local o dentro del contenedor core, donde DATABASE_URL ya está):
 *   pnpm tsx scripts/remove-user.ts list [patrón]
 *   pnpm tsx scripts/remove-user.ts deactivate <tec_username>
 *   pnpm tsx scripts/remove-user.ts activate <tec_username>
 *
 * Desactivar pone is_active = FALSE: getActiveUsers() deja de incluirlo y el
 * orquestador no vuelve a scrapear su cuenta. Sus notificaciones y archivos
 * quedan en la base (borrado real = DELETE manual, con cascada).
 *
 * Autocontenido igual que set-studyos.ts: pg resuelto desde packages/database.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromDatabase = createRequire(
  path.resolve(path.dirname(process.argv[1] ?? '.'), '../packages/database/package.json'),
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = requireFromDatabase('pg') as typeof import('pg');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const [cmd, arg] = process.argv.slice(2);

  try {
    if (cmd === 'list') {
      const res = arg
        ? await pool.query(
            `SELECT name, tec_username, is_active FROM users
             WHERE tec_username ILIKE $1 OR name ILIKE $1 ORDER BY created_at`,
            [`%${arg}%`],
          )
        : await pool.query(
            `SELECT name, tec_username, is_active FROM users ORDER BY created_at`,
          );
      if (res.rowCount === 0) {
        console.log('Sin resultados.');
        return;
      }
      for (const u of res.rows) {
        console.log(`${u.is_active ? 'ACTIVO  ' : 'inactivo'}  ${u.tec_username}  (${u.name})`);
      }
      return;
    }

    if (cmd === 'deactivate' || cmd === 'activate') {
      if (!arg) {
        console.error(`Uso: pnpm tsx scripts/remove-user.ts ${cmd} <tec_username>`);
        process.exit(1);
      }
      const active = cmd === 'activate';
      const res = await pool.query(
        `UPDATE users SET is_active = $2 WHERE tec_username = $1 RETURNING name`,
        [arg, active],
      );
      if (res.rowCount === 0) {
        console.error(`❌ No existe usuario con tec_username=${arg}`);
        process.exit(1);
      }
      console.log(
        active
          ? `✅ ${arg} (${res.rows[0].name}) reactivado.`
          : `✅ ${arg} (${res.rows[0].name}) desactivado: fuera del ciclo de scraping.`,
      );
      return;
    }

    console.log('Uso: pnpm tsx scripts/remove-user.ts list [patrón]');
    console.log('     pnpm tsx scripts/remove-user.ts deactivate <tec_username>');
    console.log('     pnpm tsx scripts/remove-user.ts activate <tec_username>');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
