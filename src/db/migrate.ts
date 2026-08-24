/**
 * Aplica las migraciones. Deliberadamente NO importa src/config/env.ts:
 * migrar la base no tiene por que exigir credenciales de Meta.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { configPostgres } from './conexion';

try {
  process.loadEnvFile();
} catch {
  /* sin .env: se usan las variables del entorno */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('falta DATABASE_URL (revisa tu .env)');
  process.exit(1);
}

async function main() {
  const pool = new Pool(configPostgres(url!, 2));

  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });

  const { rows } = await pool.query<{ tabla: string }>(
    `SELECT table_name AS tabla FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );

  await pool.end();
  console.log(`migraciones aplicadas. tablas: ${rows.map((r) => r.tabla).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
