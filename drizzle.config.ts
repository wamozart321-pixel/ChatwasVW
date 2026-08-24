import type { Config } from 'drizzle-kit';

// Config independiente de src/config/env.ts a proposito: 'drizzle-kit generate'
// no necesita credenciales de Meta, solo la base.
try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
