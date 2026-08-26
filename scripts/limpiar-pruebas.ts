/**
 * Borra las conversaciones simuladas y deja solo las de clientes de verdad.
 *
 *   npm run limpiar-pruebas -- --produccion               muestra que haria
 *   npm run limpiar-pruebas -- --produccion --de-verdad   lo hace
 *
 * Sin --produccion corre contra la base que diga el .env, que es la de
 * desarrollo.
 *
 * Durante el desarrollo se generaron cientos de contactos y conversaciones
 * falsas. Ensucian la bandeja y falsean todas las metricas: "314 abiertas"
 * cuando en realidad hay 7.
 *
 * Como se distingue lo real: un mensaje que vino de Meta trae un
 * `wa_message_id` con el formato de ellos (`wamid.HB...`). Los de las
 * simulaciones los invente yo, con prefijos propios. Es la unica marca que no
 * se puede confundir — el nombre del contacto o el numero se prestan a error,
 * y aca borrar de mas significa perder la conversacion de un cliente.
 *
 * SIEMPRE hacer un respaldo antes. Esto no se puede deshacer.
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { configPostgres } from '../src/db/conexion';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

/**
 * Contra que base corre.
 *
 * Con --produccion lee la cadena del respaldo del .env del servidor, para no
 * tener que dejar el .env local apuntando a produccion: si alguien despues
 * corre las pruebas sin darse cuenta, escriben sobre los datos reales.
 */
function urlDeLaBase(): string | undefined {
  if (!process.argv.includes('--produccion')) return process.env.DATABASE_URL;

  try {
    const archivo = readFileSync('.env.respaldo-produccion', 'utf8');
    return archivo.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
  } catch {
    console.error('falta .env.respaldo-produccion; copialo del servidor primero');
    process.exit(1);
  }
}

const url = urlDeLaBase();
if (!url) {
  console.error('falta DATABASE_URL');
  process.exit(1);
}

const deVerdad = process.argv.includes('--de-verdad');
const pool = new Pool(configPostgres(url, 2));

async function main() {
  const { rows: reales } = await pool.query<{ wa_id: string; nombre: string; n: number }>(`
    SELECT ct.wa_id, coalesce(ct.nombre, '') AS nombre,
           count(*) FILTER (WHERE m.direccion = 'in' AND m.wa_message_id LIKE 'wamid.HB%')::int AS n
      FROM contacts ct
      JOIN conversations c ON c.contact_id = ct.id
      JOIN messages m ON m.conversation_id = c.id
     GROUP BY ct.wa_id, ct.nombre
    HAVING count(*) FILTER (WHERE m.direccion = 'in' AND m.wa_message_id LIKE 'wamid.HB%') > 0
     ORDER BY ct.wa_id
  `);

  if (!reales.length) {
    console.error(`
  No se encontro ningun contacto con mensajes de Meta.

  Eso significaria borrar TODO, asi que se corta aca. Si de verdad queres
  vaciar la base, usa 'npm run simular -- limpiar'.
`);
    process.exit(1);
  }

  const conservar = reales.map((r) => r.wa_id);

  console.log('\nSE CONSERVAN (tienen mensajes que vinieron de Meta):\n');
  for (const r of reales) {
    console.log(`   +${r.wa_id.padEnd(14)} ${r.nombre.slice(0, 22).padEnd(24)} ${r.n} mensajes reales`);
  }

  const { rows: aBorrar } = await pool.query<{ contactos: number; conversaciones: number; mensajes: number }>(
    `SELECT
       (SELECT count(*)::int FROM contacts WHERE wa_id <> ALL($1::text[]))          AS contactos,
       (SELECT count(*)::int FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
         WHERE ct.wa_id <> ALL($1::text[]))                                         AS conversaciones,
       (SELECT count(*)::int FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          JOIN contacts ct ON ct.id = c.contact_id
         WHERE ct.wa_id <> ALL($1::text[]))                                         AS mensajes`,
    [conservar],
  );

  const { contactos, conversaciones, mensajes } = aBorrar[0];
  console.log(`\nSE BORRAN:\n`);
  console.log(`   ${contactos} contactos · ${conversaciones} conversaciones · ${mensajes} mensajes`);

  if (!deVerdad) {
    console.log(`
  Esto fue solo una vista previa. Para hacerlo:

      npm run limpiar-pruebas -- --produccion --de-verdad

  Antes, un respaldo. Esto no se deshace.
`);
    await pool.end();
    return;
  }

  const cliente = await pool.connect();
  try {
    // Todo o nada: si algo falla a mitad, no queda una conversacion sin sus
    // mensajes ni un mensaje apuntando a una conversacion que ya no existe.
    await cliente.query('BEGIN');

    const { rows: convs } = await cliente.query<{ id: string }>(
      `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE ct.wa_id <> ALL($1::text[])`,
      [conservar],
    );
    const ids = convs.map((c) => c.id);

    console.log('\nborrando...');
    for (const tabla of ['messages', 'notes', 'conversation_tags', 'events']) {
      const r = await cliente.query(
        `DELETE FROM ${tabla} WHERE conversation_id = ANY($1::uuid[])`,
        [ids],
      );
      console.log(`   ${tabla.padEnd(19)} ${r.rowCount}`);
    }

    const c = await cliente.query(`DELETE FROM conversations WHERE id = ANY($1::uuid[])`, [ids]);
    console.log(`   conversations       ${c.rowCount}`);

    const ct = await cliente.query(`DELETE FROM contacts WHERE wa_id <> ALL($1::text[])`, [conservar]);
    console.log(`   contacts            ${ct.rowCount}`);

    await cliente.query('COMMIT');
    console.log('\nlisto.\n');
  } catch (e) {
    await cliente.query('ROLLBACK');
    console.error(`\nno se borro nada, se deshizo todo: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
}

void main();
