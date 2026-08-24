import type { PoolConfig } from 'pg';

/**
 * Config del pool de Postgres.
 *
 * El parametro sslmode se saca de la URL y el TLS se configura aparte, por dos razones:
 *   - pg va a cambiar como interpreta sslmode=require (hoy avisa con un warning).
 *   - sslmode=require de libpq cifra pero NO valida el certificado. Aca se valida.
 *
 * Neon, Supabase y RDS presentan cadenas de certificados validas, asi que
 * rejectUnauthorized: true funciona sin configuracion extra.
 */
export function configPostgres(url: string, max = 10): PoolConfig {
  let limpia = url;
  let pideTls = /\bsslmode=(require|verify-ca|verify-full)\b/.test(url);

  try {
    const u = new URL(url);
    const modo = u.searchParams.get('sslmode');
    pideTls = modo !== null && modo !== 'disable';
    u.searchParams.delete('sslmode');
    limpia = u.toString();
  } catch {
    // URL rara: se deja tal cual y se decide por el regex de arriba.
  }

  return {
    connectionString: limpia,
    max,
    ssl: pideTls ? { rejectUnauthorized: true } : undefined,
  };
}
