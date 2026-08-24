/**
 * Administracion de usuarios.
 *
 * Es la parte con mas superficie de dano del sistema: quien entre aca puede
 * crear cuentas, cambiar claves ajenas y dejar a todo el equipo afuera. Las
 * pruebas apuntan sobre todo a lo que NO tiene que poder hacerse.
 *
 *   npm run test:admin
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BASE, exigirEntornoSeguro } from './entorno';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}



/** Se pasan por variable de entorno para poder correr contra produccion. */
const ADMIN_EMAIL = process.env.ADMIN_PRUEBAS ?? 'jhon@chatwasvw.com';
const ADMIN_CLAVE = process.env.ADMIN_CLAVE_PRUEBAS ?? '';
const ASESOR_EMAIL = process.env.ASESOR_PRUEBAS ?? 'yeiner@chatwasvw.com';
const ASESOR_CLAVE = process.env.ASESOR_CLAVE_PRUEBAS ?? '';

let fallos = 0;

async function prueba(nombre: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${nombre}`);
  } catch (e) {
    fallos++;
    console.log(`  FALLO  ${nombre}`);
    console.log(`         ${(e as Error).message.split('\n')[0]}`);
  }
}

async function login(email: string, clave: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, clave }),
  });
  if (!r.ok) return null;
  return ((await r.json()) as { token: string }).token;
}

async function api(token: string | null, ruta: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${ruta}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: r.status, cuerpo: (await r.json().catch(() => null)) as any };
}

async function main() {
  exigirEntornoSeguro();

  if (!ADMIN_CLAVE || !ASESOR_CLAVE) {
    console.error(`
  Faltan las claves. Esta suite toca cuentas reales, asi que no lleva
  ninguna escrita adentro:

    ADMIN_CLAVE_PRUEBAS=... ASESOR_CLAVE_PRUEBAS=... npm run test:admin
`);
    process.exit(1);
  }

  const admin = await login(ADMIN_EMAIL, ADMIN_CLAVE);
  const asesor = await login(ASESOR_EMAIL, ASESOR_CLAVE);

  if (!admin || !asesor) {
    console.error(`\n  No se pudo entrar en ${BASE}. Revisa las claves.\n`);
    process.exit(1);
  }

  console.log('\nquien puede entrar\n');

  await prueba('sin token no se llega al panel', async () => {
    assert.equal((await api(null, '/api/admin/usuarios')).status, 401);
  });

  await prueba('un asesor tiene prohibido el panel', async () => {
    assert.equal((await api(asesor, '/api/admin/usuarios')).status, 403);
  });

  await prueba('el admin ve la lista completa', async () => {
    const r = await api(admin, '/api/admin/usuarios');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.cuerpo) && r.cuerpo.length > 0);
    // Los dados de baja tambien: si no, no habria forma de reactivarlos.
    assert.ok(r.cuerpo.some((u: any) => u.activo === false), 'no vinieron los de baja');
  });

  await prueba('un asesor no puede darse el rol de admin', async () => {
    const lista = (await api(admin, '/api/admin/usuarios')).cuerpo;
    const yo = lista.find((u: any) => u.email === ASESOR_EMAIL);

    const r = await api(asesor, `/api/admin/usuarios/${yo.id}/rol`, {
      method: 'POST',
      body: JSON.stringify({ rol: 'admin' }),
    });
    assert.equal(r.status, 403);

    // Y de verdad no cambio, no solo respondio feo.
    const despues = (await api(admin, '/api/admin/usuarios')).cuerpo;
    assert.equal(despues.find((u: any) => u.email === ASESOR_EMAIL).rol, 'asesor');
  });

  console.log('\nvalidaciones\n');

  const nuevo = () => ({
    nombre: 'Prueba Automatica',
    email: `prueba.${randomUUID().slice(0, 8)}@chatwasvw.com`,
    clave: 'claveDePrueba1',
    rol: 'asesor',
  });

  await prueba('rechaza una clave corta', async () => {
    const r = await api(admin, '/api/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify({ ...nuevo(), clave: '123' }),
    });
    assert.equal(r.status, 400);
    assert.match(r.cuerpo.message, /8 caracteres/);
  });

  await prueba('rechaza un correo mal formado', async () => {
    const r = await api(admin, '/api/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify({ ...nuevo(), email: 'no-es-un-correo' }),
    });
    assert.equal(r.status, 400);
  });

  await prueba('rechaza un correo repetido', async () => {
    const r = await api(admin, '/api/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify({ ...nuevo(), email: ASESOR_EMAIL }),
    });
    assert.equal(r.status, 409);
  });

  await prueba('rechaza un rol inventado', async () => {
    const r = await api(admin, '/api/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify({ ...nuevo(), rol: 'jefe' }),
    });
    assert.equal(r.status, 400);
  });

  console.log('\nno quedarse sin administradores\n');

  await prueba('un admin no puede darse de baja a si mismo', async () => {
    const lista = (await api(admin, '/api/admin/usuarios')).cuerpo;
    const yo = lista.find((u: any) => u.email === ADMIN_EMAIL);

    const r = await api(admin, `/api/admin/usuarios/${yo.id}/estado`, {
      method: 'POST',
      body: JSON.stringify({ activo: false }),
    });
    assert.equal(r.status, 403);
    assert.equal(await login(ADMIN_EMAIL, ADMIN_CLAVE) !== null, true, 'se quedo afuera');
  });

  await prueba('no se puede quitar el rol al ultimo admin', async () => {
    const lista = (await api(admin, '/api/admin/usuarios')).cuerpo;
    const admins = lista.filter((u: any) => u.rol === 'admin' && u.activo);
    const yo = admins.find((u: any) => u.email === ADMIN_EMAIL);
    const otros = admins.filter((u: any) => u.email !== ADMIN_EMAIL);

    // Se dejan de lado los demas para que quede uno solo, y se restauran al final.
    for (const o of otros) {
      await api(admin, `/api/admin/usuarios/${o.id}/rol`, {
        method: 'POST',
        body: JSON.stringify({ rol: 'asesor' }),
      });
    }

    try {
      const r = await api(admin, `/api/admin/usuarios/${yo.id}/rol`, {
        method: 'POST',
        body: JSON.stringify({ rol: 'asesor' }),
      });
      assert.equal(r.status, 409, 'dejo al sistema sin ningun administrador');
    } finally {
      for (const o of otros) {
        await api(admin, `/api/admin/usuarios/${o.id}/rol`, {
          method: 'POST',
          body: JSON.stringify({ rol: 'admin' }),
        });
      }
    }
  });

  console.log('\nciclo de vida de un usuario\n');

  const datos = nuevo();
  let creadoId = '';

  await prueba('lo crea y puede entrar', async () => {
    const r = await api(admin, '/api/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify(datos),
    });
    assert.equal(r.status, 201);
    creadoId = r.cuerpo.id;
    assert.ok(await login(datos.email, datos.clave), 'no pudo entrar con su clave');
  });

  await prueba('al cambiarle la clave, la vieja deja de servir', async () => {
    const r = await api(admin, `/api/admin/usuarios/${creadoId}/clave`, {
      method: 'POST',
      body: JSON.stringify({ clave: 'otraClaveDistinta' }),
    });
    assert.equal(r.status, 201);
    assert.equal(await login(datos.email, datos.clave), null, 'la clave vieja todavia entra');
    assert.ok(await login(datos.email, 'otraClaveDistinta'), 'la nueva no entra');
  });

  await prueba('dado de baja no entra, y reactivado si', async () => {
    await api(admin, `/api/admin/usuarios/${creadoId}/estado`, {
      method: 'POST',
      body: JSON.stringify({ activo: false }),
    });
    assert.equal(await login(datos.email, 'otraClaveDistinta'), null, 'entra estando de baja');

    await api(admin, `/api/admin/usuarios/${creadoId}/estado`, {
      method: 'POST',
      body: JSON.stringify({ activo: true }),
    });
    assert.ok(await login(datos.email, 'otraClaveDistinta'), 'no entra tras reactivarlo');
  });

  // No se borra: se deja de baja para no dejar cuentas de prueba con acceso.
  await api(admin, `/api/admin/usuarios/${creadoId}/estado`, {
    method: 'POST',
    body: JSON.stringify({ activo: false }),
  });

  console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} PRUEBA(S) FALLARON\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
