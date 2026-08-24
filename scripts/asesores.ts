/**
 * Alta y gestión de asesores desde la terminal. No hay pantalla de registro a
 * propósito: nadie debería poder crearse una cuenta solo en una bandeja interna.
 *
 *   npm run asesores -- listar
 *   npm run asesores -- crear "Ana Pérez" ana@repuestos.com unaClave123 asesor
 *   npm run asesores -- clave ana@repuestos.com otraClave456
 *   npm run asesores -- baja ana@repuestos.com
 *   npm run asesores -- demo          crea los 7 del equipo con clave temporal
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { configPostgres } from '../src/db/conexion';
import { users } from '../src/db/schema';
import { hashear } from '../src/auth/password';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const pool = new Pool(configPostgres(process.env.DATABASE_URL ?? '', 2));
const db = drizzle(pool, { schema: { users } });

const ROLES = ['admin', 'supervisor', 'asesor'] as const;
type Rol = (typeof ROLES)[number];

async function listar() {
  const filas = await db
    .select({
      nombre: users.nombre,
      email: users.email,
      rol: users.rol,
      activo: users.activo,
      tieneClave: users.passwordHash,
      ultimaConexion: users.ultimaConexion,
    })
    .from(users)
    .orderBy(users.nombre);

  if (!filas.length) {
    console.log('\nno hay asesores. Creá uno con: npm run asesores -- crear "Nombre" email clave\n');
    return;
  }

  console.log();
  for (const f of filas) {
    const estado = !f.activo ? 'BAJA' : f.tieneClave ? 'ok' : 'SIN CLAVE';
    const visto = f.ultimaConexion
      ? new Date(f.ultimaConexion).toLocaleString('es')
      : 'nunca entró';
    console.log(
      `  ${estado.padEnd(10)} ${f.rol.padEnd(11)} ${f.nombre.padEnd(20)} ${f.email.padEnd(28)} ${visto}`,
    );
  }
  console.log();
}

async function crear(nombre: string, email: string, clave: string, rol: Rol = 'asesor') {
  if (clave.length < 8) {
    console.error('la clave debe tener al menos 8 caracteres');
    process.exit(1);
  }
  if (!ROLES.includes(rol)) {
    console.error(`rol inválido. Opciones: ${ROLES.join(', ')}`);
    process.exit(1);
  }

  const [fila] = await db
    .insert(users)
    .values({
      nombre,
      email: email.trim().toLowerCase(),
      passwordHash: await hashear(clave),
      rol,
    })
    .onConflictDoUpdate({
      target: users.email,
      // Reactiva y actualiza si el email ya existía: sirve para reingresos.
      set: { nombre, rol, activo: true },
    })
    .returning();

  console.log(`${fila.nombre} <${fila.email}> · rol ${fila.rol}`);
}

async function cambiarClave(email: string, clave: string) {
  if (clave.length < 8) {
    console.error('la clave debe tener al menos 8 caracteres');
    process.exit(1);
  }

  const filas = await db
    .update(users)
    .set({ passwordHash: await hashear(clave) })
    .where(eq(users.email, email.trim().toLowerCase()))
    .returning({ nombre: users.nombre });

  if (!filas.length) {
    console.error('no existe ese email');
    process.exit(1);
  }
  console.log(`clave actualizada para ${filas[0].nombre}`);
}

async function baja(email: string) {
  const filas = await db
    .update(users)
    .set({ activo: false })
    .where(eq(users.email, email.trim().toLowerCase()))
    .returning({ nombre: users.nombre });

  if (!filas.length) {
    console.error('no existe ese email');
    process.exit(1);
  }
  // No se borra: las conversaciones que atendió deben seguir apuntando a alguien.
  console.log(`${filas[0].nombre} dado de baja (el historial se conserva)`);
}

async function demo() {
  const CLAVE = 'cambiar1234';

  const equipo: [string, string, Rol][] = [
    ['Jhon Pardo', 'jhon@repuestos.com', 'admin'],
    ['Carolina Ruiz', 'carolina@repuestos.com', 'supervisor'],
    ['Andrés Gómez', 'andres@repuestos.com', 'asesor'],
    ['Daniela Ortiz', 'daniela@repuestos.com', 'asesor'],
    ['Felipe Ramírez', 'felipe@repuestos.com', 'asesor'],
    ['Marcela Díaz', 'marcela@repuestos.com', 'asesor'],
    ['Sebastián Rojas', 'sebastian@repuestos.com', 'asesor'],
  ];

  for (const [nombre, email, rol] of equipo) await crear(nombre, email, CLAVE, rol);

  console.log(`\nlos 7 creados con la clave temporal: ${CLAVE}`);
  console.log('cambiala con: npm run asesores -- clave <email> <nuevaClave>\n');
}

async function main() {
  const [comando, ...args] = process.argv.slice(2);

  switch (comando) {
    case 'listar':
      await listar();
      break;
    case 'crear':
      if (args.length < 3) {
        console.error('uso: npm run asesores -- crear "Nombre" email clave [rol]');
        process.exit(1);
      }
      await crear(args[0], args[1], args[2], (args[3] as Rol) ?? 'asesor');
      break;
    case 'clave':
      if (args.length < 2) {
        console.error('uso: npm run asesores -- clave <email> <nuevaClave>');
        process.exit(1);
      }
      await cambiarClave(args[0], args[1]);
      break;
    case 'baja':
      if (!args[0]) {
        console.error('uso: npm run asesores -- baja <email>');
        process.exit(1);
      }
      await baja(args[0]);
      break;
    case 'demo':
      await demo();
      break;
    default:
      console.log('comandos: listar | crear | clave | baja | demo');
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message ?? e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
