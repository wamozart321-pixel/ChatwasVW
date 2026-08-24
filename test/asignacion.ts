/**
 * Prueba end-to-end del paso 3, contra el servidor levantado.
 *   npm run dev              (en otra terminal)
 *   npm run test:asignacion
 *
 * Lo que verifica es exactamente el problema de 7 asesores sobre un solo número:
 * que dos no puedan quedarse con la misma conversación, que el cliente vuelva
 * con quien ya lo atendió, y que nadie pueda soltar lo ajeno.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { configPostgres } from '../src/db/conexion';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const BASE = process.env.BASE_PRUEBAS ?? `http://localhost:${process.env.PORT ?? '3000'}`;
const SECRETO = process.env.META_APP_SECRET ?? '';
const WABA = process.env.META_WABA_ID ?? '0';
const PHONE = process.env.META_PHONE_NUMBER_ID ?? '0';
const CLAVE_DEMO = process.env.CLAVE_PRUEBAS ?? 'cambiar1234';
const DEV_KEY = process.env.DEV_API_KEY ?? '';

// Acceso directo para envejecer asignaciones: no hay forma de viajar en el
// tiempo por HTTP, y esperar 5 minutos reales no es una prueba.
const pool = new Pool(configPostgres(process.env.DATABASE_URL ?? '', 2));

async function envejecerAsignacion(conversationId: string, minutos: number) {
  await pool.query(
    `UPDATE conversations SET assigned_at = now() - make_interval(mins => $2) WHERE id = $1`,
    [conversationId, minutos],
  );
}

async function correrRescate(): Promise<number> {
  const r = await fetch(`${BASE}/dev/rescatar`, {
    method: 'POST',
    headers: { 'x-dev-key': DEV_KEY },
  });

  // Si el endpoint no contesta bien hay que fallar ACA. Las dos pruebas que
  // comprueban que el rescate NO tocó algo pasarían igual sin que hubiera
  // corrido nada, y taparían un rescate completamente roto.
  if (!r.ok) {
    throw new Error(`/dev/rescatar respondió ${r.status}: los endpoints de prueba están apagados`);
  }

  return ((await r.json()) as any).devueltasALaCola;
}

let fallos = 0;

async function prueba(nombre: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${nombre}`);
  } catch (e) {
    fallos++;
    console.error(`  FALLO  ${nombre}`);
    console.error(`         ${(e as Error).message}`);
  }
}

/**
 * Contra un servidor remoto hay pruebas que no pueden correr: unas escriben en
 * el disco donde vive el almacen, otras usan los endpoints /dev, que en
 * produccion estan apagados. Se saltan avisando, en vez de fallar o —peor—
 * pasar sin haber comprobado nada.
 */
const REMOTO = !!process.env.BASE_PRUEBAS;

async function pruebaLocal(nombre: string, fn: () => Promise<void>) {
  if (REMOTO) {
    console.log(`  --  ${nombre}  (solo contra un servidor local)`);
    return;
  }
  await prueba(nombre, fn);
}

async function login(email: string, clave = CLAVE_DEMO): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, clave }),
  });
  if (!r.ok) throw new Error(`login de ${email} falló: ${r.status}`);
  return ((await r.json()) as any).token;
}

async function api(token: string, ruta: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}/api${ruta}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const texto = await r.text();
  return { status: r.status, cuerpo: texto ? JSON.parse(texto) : null };
}

async function webhookEntrante(telefono: string, texto: string, nombre = 'Cliente Prueba') {
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE },
              contacts: [{ profile: { name: nombre }, wa_id: telefono }],
              messages: [
                {
                  from: telefono,
                  id: `wamid.RT${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: texto },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const firma = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
  const r = await fetch(`${BASE}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma },
    body: cuerpo,
  });
  assert.equal(r.status, 200, 'el webhook no respondió 200');
}

function conectar(token: string): Socket {
  return io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
}

function esperar<T = any>(socket: Socket, evento: string, ms = 8000): Promise<T> {
  return new Promise((resolver, rechazar) => {
    const t = setTimeout(() => rechazar(new Error(`no llegó '${evento}' en ${ms}ms`)), ms);
    socket.once(evento, (d: T) => {
      clearTimeout(t);
      resolver(d);
    });
  });
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Crea una conversación y la deja lista para que la tome un asesor.
 *
 * Pasa por el bot a propósito: desde que existe, un cliente nuevo no llega
 * directo a la cola — primero contesta el menú. Saltearlo acá haría que estas
 * pruebas verifiquen un camino que en producción ya no ocurre.
 */
async function nuevaConversacion(token: string, tel: string): Promise<string> {
  await webhookEntrante(tel, 'hola, necesito una cotización');

  let id = '';
  for (let i = 0; i < 30; i++) {
    const { cuerpo } = await api(token, `/conversaciones?estado=todas&q=${tel}&asignado=todos`);
    if (cuerpo?.length) {
      id = cuerpo[0].id;
      break;
    }
    await dormir(250);
  }
  if (!id) throw new Error('la conversación no apareció en la bandeja');

  // Pedir un asesor corta el flujo del bot y libera la conversación al ruteo.
  await webhookEntrante(tel, 'quiero hablar con un asesor');

  for (let i = 0; i < 40; i++) {
    const { rows } = await pool.query<{ bot_paso: string | null }>(
      `SELECT bot_paso FROM conversations WHERE id = $1`,
      [id],
    );
    if (rows[0]?.bot_paso === null) return id;
    await dormir(250);
  }
  throw new Error('el bot no entregó la conversación');
}

/**
 * Número irrepetible. Con un rango chico las colisiones convierten a un
 * "cliente nuevo" en uno conocido, y entonces actúa el ruteo pegajoso en vez
 * del reparto: la prueba mide otra cosa y falla de forma intermitente.
 */
const telAleatorio = () =>
  '57' + String(Date.now()).slice(-8) + String(Math.floor(10 + Math.random() * 90));

/**
 * Espera a que el SERVIDOR reconozca la presencia.
 *
 * El cliente recibe 'connect' apenas termina el handshake, pero handleConnection
 * todavía está validando el token contra la base — un viaje a Neon. Hasta que
 * eso vuelve, el asesor no se unió a su sala y no cuenta para el reparto.
 * Dormir un rato fijo hace la prueba inestable; esto observa el estado real.
 */
async function esperarPresencia(
  token: string,
  nombre: string,
  esperado: boolean,
  ms = 8000,
): Promise<void> {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    const { cuerpo } = await api(token, '/equipo');
    const miembro = (cuerpo ?? []).find((m: any) => m.nombre === nombre);
    if (miembro?.conectado === esperado) return;
    await dormir(150);
  }
  throw new Error(`la presencia de ${nombre} nunca llegó a ${esperado}`);
}

/**
 * Espera a que el ruteo asigne.
 *
 * El worker rutea DESPUÉS de guardar el mensaje, así que la conversación ya
 * aparece en la bandeja cuando todavía no tiene dueño: leer la asignación
 * apenas vuelve nuevaConversacion() es una carrera.
 */
/**
 * Espera a que el webhook cree la conversacion nueva de un contacto conocido.
 *
 * Antes se dormia un plazo fijo. No alcanza: el worker procesa en serie y la
 * cola puede venir cargada de las pruebas anteriores, asi que la prueba fallaba
 * por lenta y no por el ruteo.
 */
async function esperarOtraConversacion(
  token: string,
  tel: string,
  exceptoId: string,
  ms = 20000,
): Promise<any | null> {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    const { cuerpo } = await api(token, `/conversaciones?estado=todas&q=${tel}&asignado=todos`);
    const otra = (cuerpo ?? []).find((c: any) => c.id !== exceptoId);
    if (otra) return otra;
    await dormir(250);
  }
  return null;
}

async function esperarAsignacion(
  token: string,
  convId: string,
  ms = 6000,
): Promise<string | null> {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    const { cuerpo } = await api(token, `/conversaciones/${convId}`);
    if (cuerpo?.asignadoId) return cuerpo.asignadoId;
    await dormir(200);
  }
  return null;
}

async function main() {
  try {
    await fetch(`${BASE}/api/auth/login`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {
    console.error(
      [
        '',
        `  El servidor no responde en ${BASE}.`,
        '',
        '  Levantalo en OTRA terminal con:  npm start',
        '  y creá los asesores con:         npm run asesores -- demo',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log('\nautenticación\n');

  let tokenAndres = '';
  let tokenDaniela = '';
  let tokenCarolina = '';

  await prueba('login válido devuelve token', async () => {
    tokenAndres = await login('andres@repuestos.com');
    assert.ok(tokenAndres.length > 20, 'el token parece vacío');

    const { status, cuerpo } = await api(tokenAndres, '/auth/yo');
    assert.equal(status, 200);
    assert.equal(cuerpo.email, 'andres@repuestos.com');
    assert.equal(cuerpo.rol, 'asesor');
  });

  await prueba('contraseña incorrecta es rechazada', async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'andres@repuestos.com', clave: 'incorrecta' }),
    });
    assert.equal(r.status, 401);
  });

  await prueba('email inexistente también da 401, no 404', async () => {
    // Un 404 revelaría qué emails existen.
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nadie@repuestos.com', clave: CLAVE_DEMO }),
    });
    assert.equal(r.status, 401);
  });

  await prueba('sin token no se entra a la bandeja', async () => {
    const r = await fetch(`${BASE}/api/conversaciones`);
    assert.equal(r.status, 401);
  });

  await prueba('token inventado es rechazado', async () => {
    const { status } = await api('no.es.un.token', '/conversaciones');
    assert.equal(status, 401);
  });

  tokenDaniela = await login('daniela@repuestos.com');
  tokenCarolina = await login('carolina@repuestos.com');

  console.log('\nasignación\n');

  await prueba('dos asesores a la vez: exactamente uno se la queda', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());

    // Las dos peticiones salen juntas, sin esperar una a la otra.
    const [a, d] = await Promise.all([
      api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' }),
      api(tokenDaniela, `/conversaciones/${conv}/tomar`, { method: 'POST' }),
    ]);

    const exitos = [a, d].filter((r) => r.status === 200 || r.status === 201);
    const conflictos = [a, d].filter((r) => r.status === 409);

    assert.equal(exitos.length, 1, `ganaron ${exitos.length} en vez de 1`);
    assert.equal(conflictos.length, 1, 'el perdedor no recibió 409');
    assert.ok(
      conflictos[0].cuerpo?.mensaje?.includes('primero'),
      'el 409 no dice quién la tomó',
    );

    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.ok(cuerpo.asignadoId, 'quedó sin dueño después de la carrera');
  });

  await prueba('tomar dos veces la propia no rompe ni roba', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());
    await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });
    const segunda = await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });

    assert.ok(segunda.status < 300, 'tomar la propia debería ser idempotente');
    assert.equal(segunda.cuerpo?.yaEra, true);
  });

  await prueba('un asesor no puede soltar la conversación de otro', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());
    await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });

    const intento = await api(tokenDaniela, `/conversaciones/${conv}/soltar`, { method: 'POST' });
    assert.equal(intento.status, 403, 'Daniela pudo soltar lo de Andrés');

    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.ok(cuerpo.asignadoId, 'la conversación quedó libre igual');
  });

  await prueba('un supervisor sí puede reasignar lo ajeno', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());
    await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });

    const { cuerpo: yoDaniela } = await api(tokenDaniela, '/auth/yo');
    const r = await api(tokenCarolina, `/conversaciones/${conv}/asignar`, {
      method: 'POST',
      body: JSON.stringify({ asesorId: yoDaniela.id }),
    });
    assert.ok(r.status < 300, `la supervisora no pudo reasignar (${r.status})`);

    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.equal(cuerpo.asignadoId, yoDaniela.id);
  });

  await prueba('soltar la devuelve a la cola', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());
    await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });
    await api(tokenAndres, `/conversaciones/${conv}/soltar`, { method: 'POST' });

    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.equal(cuerpo.asignadoId, null);

    const { cuerpo: libres } = await api(
      tokenAndres,
      '/conversaciones?estado=todas&q=&asignado=sin_asignar',
    );
    assert.ok(
      libres.some((c: any) => c.id === conv),
      'no aparece en el filtro "sin asignar"',
    );
  });

  await prueba('el filtro "míos" solo trae las propias', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());
    await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });

    const { cuerpo: mias } = await api(
      tokenAndres,
      '/conversaciones?estado=todas&q=&asignado=mios',
    );
    assert.ok(mias.some((c: any) => c.id === conv), 'falta la propia');

    const { cuerpo: deDaniela } = await api(
      tokenDaniela,
      '/conversaciones?estado=todas&q=&asignado=mios',
    );
    assert.ok(
      !deDaniela.some((c: any) => c.id === conv),
      'Daniela ve una conversación de Andrés en "míos"',
    );
  });

  /**
   * Deja al asesor sin carga activa. Las pruebas anteriores le fueron acumulando
   * conversaciones y, pasado el tope, el ruteo pegajoso deja de asignarle a
   * propósito: sin esto la prueba de abajo falla en la segunda corrida.
   */
  async function vaciarBandejaDe(token: string) {
    const { cuerpo } = await api(token, '/conversaciones?estado=todas&q=&asignado=mios');
    for (const c of cuerpo ?? []) {
      await api(token, `/conversaciones/${c.id}/estado`, {
        method: 'POST',
        body: JSON.stringify({ estado: 'resuelto' }),
      });
    }
  }

  console.log('\nruteo pegajoso\n');

  await vaciarBandejaDe(tokenAndres);

  await prueba('el cliente vuelve con el asesor que ya lo atendió', async () => {
    const tel = telAleatorio();
    const socket = conectar(tokenAndres); // debe estar conectado para recibir ruteo
    try {
      await esperar(socket, 'connect');

      const conv = await nuevaConversacion(tokenAndres, tel);
      await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });
      await api(tokenAndres, `/conversaciones/${conv}/estado`, {
        method: 'POST',
        body: JSON.stringify({ estado: 'resuelto' }),
      });

      // Vuelve días después: se abre una conversación nueva.
      await webhookEntrante(tel, 'hola de nuevo, quedé pensando');

      const nueva = await esperarOtraConversacion(tokenAndres, tel, conv);
      assert.ok(nueva, 'no se creó una conversación nueva');

      const { cuerpo: yoAndres } = await api(tokenAndres, '/auth/yo');
      assert.equal(
        await esperarAsignacion(tokenAndres, nueva.id),
        yoAndres.id,
        'la conversación no volvió al asesor anterior',
      );
    } finally {
      socket.close();
    }
  });

  await prueba('no vuelve con el asesor previo si no está conectado', async () => {
    const tel = telAleatorio();

    // Felipe se loguea, toma y resuelve, pero NO abre socket.
    const tokenFelipe = await login('felipe@repuestos.com');
    const conv = await nuevaConversacion(tokenFelipe, tel);
    await api(tokenFelipe, `/conversaciones/${conv}/tomar`, { method: 'POST' });
    await api(tokenFelipe, `/conversaciones/${conv}/estado`, {
      method: 'POST',
      body: JSON.stringify({ estado: 'resuelto' }),
    });

    const { cuerpo: yoFelipe } = await api(tokenFelipe, '/auth/yo');

    await webhookEntrante(tel, 'vuelvo a escribir');

    const nueva = await esperarOtraConversacion(tokenFelipe, tel, conv);
    assert.ok(nueva, 'no se creó una conversación nueva');

    // Un momento mas por si el ruteo llega tarde: la afirmacion es negativa y
    // sin esta pausa pasaria sola, antes de que hubiera nada que asignar.
    await dormir(1500);

    // Se relee: el objeto de arriba se trajo antes de la pausa y su asignado
    // estaria vacio siempre, con lo cual la prueba no comprobaria nada.
    const { cuerpo: alFinal } = await api(tokenFelipe, `/conversaciones/${nueva.id}`);

    // Puede quedar en la cola o irse al reparto por carga: las dos cosas están
    // bien. Lo que no puede pasar es volver con quien no está mirando la bandeja.
    assert.notEqual(
      alFinal.asignadoId,
      yoFelipe.id,
      'le asignó trabajo a alguien que no estaba conectado',
    );
  });

  console.log('\ntiempo real\n');

  await prueba('el socket exige token válido', async () => {
    const s = conectar('token.falso.aca');
    try {
      await Promise.race([esperar(s, 'no-autorizado', 5000), esperar(s, 'disconnect', 5000)]);
    } finally {
      s.close();
    }
  });

  await prueba('"está escribiendo" llega a los demás, no a uno mismo', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());

    const sA = conectar(tokenAndres);
    const sD = conectar(tokenDaniela);
    try {
      await Promise.all([esperar(sA, 'connect'), esperar(sD, 'connect')]);
      sA.emit('ver', conv);
      sD.emit('ver', conv);
      await dormir(400);

      let seVioASiMismo = false;
      sA.on('escribiendo', () => {
        seVioASiMismo = true;
      });

      const recibido = esperar<{ asesor: { nombre: string } }>(sD, 'escribiendo');
      sA.emit('escribiendo', conv);

      const evento = await recibido;
      assert.equal(evento.asesor.nombre, 'Andrés Gómez');

      await dormir(300);
      assert.equal(seVioASiMismo, false, 'el asesor se ve escribir a sí mismo');
    } finally {
      sA.close();
      sD.close();
    }
  });

  await prueba('tomar una conversación avisa a toda la bandeja', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());

    const sD = conectar(tokenDaniela);
    try {
      await esperar(sD, 'connect');
      const aviso = esperar<{ conversationId: string }>(sD, 'conversacion:actualizada');

      await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });

      const evento = await aviso;
      assert.equal(evento.conversationId, conv);
    } finally {
      sD.close();
    }
  });

  await prueba('reasignar avisa directo al asesor destino', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());
    await api(tokenAndres, `/conversaciones/${conv}/tomar`, { method: 'POST' });

    const sD = conectar(tokenDaniela);
    try {
      await esperar(sD, 'connect');
      const aviso = esperar<{ conversationId: string; por: string }>(sD, 'conversacion:asignada');

      const { cuerpo: yoDaniela } = await api(tokenDaniela, '/auth/yo');
      await api(tokenAndres, `/conversaciones/${conv}/asignar`, {
        method: 'POST',
        body: JSON.stringify({ asesorId: yoDaniela.id }),
      });

      const evento = await aviso;
      assert.equal(evento.conversationId, conv);
      assert.equal(evento.por, 'Andrés Gómez');
    } finally {
      sD.close();
    }
  });

  console.log('\nequipo\n');

  await prueba('el panel de equipo refleja carga y presencia', async () => {
    const s = conectar(tokenAndres);
    try {
      await esperar(s, 'connect');
      await dormir(300);

      const { cuerpo } = await api(tokenCarolina, '/equipo');
      assert.ok(Array.isArray(cuerpo) && cuerpo.length >= 7, 'faltan asesores en el panel');

      const andres = cuerpo.find((m: any) => m.nombre === 'Andrés Gómez');
      assert.ok(andres, 'Andrés no figura');
      assert.equal(andres.conectado, true, 'no detectó a Andrés conectado');
      assert.ok(andres.activas > 0, 'no cuenta las conversaciones que tiene encima');
      assert.ok(andres.tope > 0, 'no informa el tope');
    } finally {
      s.close();
    }
  });

  console.log('\npresencia\n');

  async function conectadoSegunApi(nombre: string): Promise<boolean> {
    const { cuerpo } = await api(tokenCarolina, '/equipo');
    return cuerpo.find((m: any) => m.nombre === nombre)?.conectado === true;
  }

  await prueba('desconectarse limpia la presencia', async () => {
    const s = conectar(await login('marcela@repuestos.com'));
    await esperar(s, 'connect');
    await dormir(300);
    assert.equal(await conectadoSegunApi('Marcela Díaz'), true, 'no la detectó al conectar');

    s.close();
    await dormir(600);
    assert.equal(
      await conectadoSegunApi('Marcela Díaz'),
      false,
      'quedó marcada como conectada después de cerrar',
    );
  });

  await prueba('cerrar durante el login no deja fantasmas', async () => {
    const token = await login('sebastian@repuestos.com');

    // Cerrar de inmediato: la validación del token todavía está en vuelo, que es
    // justo la ventana donde un mapa de presencia paralelo se corrompía.
    for (let i = 0; i < 5; i++) {
      const s = conectar(token);
      s.close();
    }
    await dormir(1500);

    assert.equal(
      await conectadoSegunApi('Sebastián Rojas'),
      false,
      'quedó un socket fantasma tras conectar y cerrar rápido',
    );
  });

  await prueba('dos pestañas: cerrar una no lo desconecta', async () => {
    const token = await login('marcela@repuestos.com');
    const a = conectar(token);
    const b = conectar(token);
    try {
      await Promise.all([esperar(a, 'connect'), esperar(b, 'connect')]);
      await dormir(300);

      a.close();
      await dormir(600);
      assert.equal(
        await conectadoSegunApi('Marcela Díaz'),
        true,
        'cerrar una pestaña la marcó desconectada',
      );
    } finally {
      b.close();
    }
    await dormir(600);
    assert.equal(await conectadoSegunApi('Marcela Díaz'), false, 'no se limpió al final');
  });

  console.log('\nreparto por menor carga\n');

  // Que se cierren los sockets de las pruebas anteriores antes de medir presencia.
  await dormir(1000);

  await prueba('un cliente nuevo va al asesor conectado', async () => {
    await vaciarBandejaDe(tokenDaniela);

    const sD = conectar(tokenDaniela);
    try {
      await esperar(sD, 'connect');
      await esperarPresencia(tokenDaniela, 'Daniela Ortiz', true);

      const { cuerpo: yoDaniela } = await api(tokenDaniela, '/auth/yo');
      const conv = await nuevaConversacion(tokenDaniela, telAleatorio());

      assert.equal(
        await esperarAsignacion(tokenDaniela, conv),
        yoDaniela.id,
        'no lo repartió al único asesor conectado',
      );
    } finally {
      sD.close();
    }
  });

  await prueba('elige al de menor carga entre varios', async () => {
    await vaciarBandejaDe(tokenAndres);
    await vaciarBandejaDe(tokenDaniela);

    // El socket de Daniela viene de la prueba anterior y tarda en cerrarse. Si
    // sigue viva cuando se cargan las dos de Andrés, se las lleva ella y las
    // cargas quedan al revés: la prueba fallaba por arrastre, no por el reparto.
    await esperarPresencia(tokenDaniela, 'Daniela Ortiz', false);

    // Primero sólo Andrés conectado: se le cargan dos.
    const sA = conectar(tokenAndres);
    await esperar(sA, 'connect');
    await esperarPresencia(tokenAndres, 'Andrés Gómez', true);

    const { cuerpo: yoAndres } = await api(tokenAndres, '/auth/yo');
    for (let i = 0; i < 2; i++) {
      const c = await nuevaConversacion(tokenAndres, telAleatorio());
      assert.equal(
        await esperarAsignacion(tokenAndres, c),
        yoAndres.id,
        'la carga previa no quedó sobre Andrés: la prueba no mediría nada',
      );
    }

    // Entra Daniela con cero encima: la siguiente tiene que ser suya.
    const sD = conectar(tokenDaniela);
    try {
      await esperar(sD, 'connect');
      await esperarPresencia(tokenDaniela, 'Daniela Ortiz', true);

      const { cuerpo: yoDaniela } = await api(tokenDaniela, '/auth/yo');
      const conv = await nuevaConversacion(tokenDaniela, telAleatorio());

      assert.equal(
        await esperarAsignacion(tokenDaniela, conv),
        yoDaniela.id,
        'no eligió al asesor con menos conversaciones activas',
      );
    } finally {
      sA.close();
      sD.close();
    }
  });

  /**
   * Invariante del reparto, en vez de un resultado concreto.
   *
   * Afirmar "no se lo asignó a nadie" es frágil: basta que alguien tenga la
   * bandeja abierta en el navegador para que la prueba falle sin que haya nada
   * roto. Lo que sí tiene que cumplirse siempre es la REGLA: si repartió, fue a
   * un asesor conectado y por debajo del tope.
   */
  await prueba('si reparte, es a un asesor conectado y bajo el tope', async () => {
    const s = conectar(tokenCarolina); // una supervisora, que no debe recibir
    try {
      await esperar(s, 'connect');
      await esperarPresencia(tokenCarolina, 'Carolina Ruiz', true);

      const conv = await nuevaConversacion(tokenCarolina, telAleatorio());
      await dormir(2000); // margen para que el ruteo corra

      const { cuerpo } = await api(tokenCarolina, `/conversaciones/${conv}`);
      if (!cuerpo.asignadoId) return; // quedó en la cola: válido

      const { cuerpo: equipo } = await api(tokenCarolina, '/equipo');
      const quien = equipo.find((m: any) => m.id === cuerpo.asignadoId);

      assert.ok(quien, 'la asignó a alguien que no está en el equipo');
      assert.equal(quien.conectado, true, 'la asignó a alguien desconectado');
      assert.equal(quien.rol, 'asesor', `la asignó a un ${quien.rol}`);
      assert.ok(quien.activas <= quien.tope, 'la asignó a alguien por encima del tope');
    } finally {
      s.close();
    }
  });

  console.log('\nrescate\n');

  await pruebaLocal('devuelve a la cola lo automático sin respuesta', async () => {
    await vaciarBandejaDe(tokenAndres);

    const s = conectar(tokenAndres);
    try {
      await esperar(s, 'connect');
      await esperarPresencia(tokenAndres, 'Andrés Gómez', true);

      const conv = await nuevaConversacion(tokenAndres, telAleatorio());
      assert.ok(
        await esperarAsignacion(tokenAndres, conv),
        'no se asignó, la prueba no verifica nada',
      );

      await envejecerAsignacion(conv, 30);
      const devueltas = await correrRescate();
      assert.ok(devueltas >= 1, 'el rescate no devolvió ninguna');

      const { cuerpo: despues } = await api(tokenAndres, `/conversaciones/${conv}`);
      assert.equal(despues.asignadoId, null, 'siguió asignada tras el rescate');
    } finally {
      s.close();
    }
  });

  await pruebaLocal('no toca lo que alguien tomó a mano', async () => {
    const conv = await nuevaConversacion(tokenAndres, telAleatorio());
    await dormir(2000); // dejar que el ruteo haga lo suyo, si va a hacerlo

    // La asigna la supervisora: eso la marca como manual, sin depender de que
    // el reparto automático se la haya dado o no a Andrés.
    const { cuerpo: yoAndres } = await api(tokenAndres, '/auth/yo');
    const r = await api(tokenCarolina, `/conversaciones/${conv}/asignar`, {
      method: 'POST',
      body: JSON.stringify({ asesorId: yoAndres.id }),
    });
    assert.ok(r.status < 300, `no se pudo asignar a mano (${r.status})`);

    await envejecerAsignacion(conv, 30);
    await correrRescate();

    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.equal(
      cuerpo.asignadoId,
      yoAndres.id,
      'le quitó una conversación que le habían asignado a mano',
    );
  });

  await pruebaLocal('no toca aquella donde el asesor sí contestó', async () => {
    await vaciarBandejaDe(tokenAndres);

    const s = conectar(tokenAndres);
    try {
      await esperar(s, 'connect');
      await esperarPresencia(tokenAndres, 'Andrés Gómez', true);

      const conv = await nuevaConversacion(tokenAndres, telAleatorio());
      assert.ok(
        await esperarAsignacion(tokenAndres, conv),
        'no se asignó, la prueba no verifica nada',
      );

      // Marcarla leída deja unread_count en 0: el asesor la está atendiendo.
      await api(tokenAndres, `/conversaciones/${conv}/leida`, { method: 'POST' });

      await envejecerAsignacion(conv, 30);
      await correrRescate();

      const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}`);
      assert.ok(cuerpo.asignadoId, 'rescató una conversación que ya estaba atendida');
    } finally {
      s.close();
    }
  });

  await pool.end().catch(() => undefined);

  console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} PRUEBA(S) FALLARON\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
