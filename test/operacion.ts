/**
 * Pruebas del paso 4: archivos, plantillas, notas, etiquetas y métricas.
 *   npm start              (en otra terminal)
 *   npm run test:operacion
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { configPostgres } from '../src/db/conexion';
import { BASE, exigirEntornoSeguro } from './entorno';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}


const SECRETO = process.env.META_APP_SECRET ?? '';
const WABA = process.env.META_WABA_ID ?? '0';
const PHONE = process.env.META_PHONE_NUMBER_ID ?? '0';
const ALMACEN = process.env.ALMACEN_DIR ?? './almacen';
const CLAVE_DEMO = process.env.CLAVE_PRUEBAS ?? 'cambiar1234';

const pool = new Pool(configPostgres(process.env.DATABASE_URL ?? '', 2));

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

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, clave: CLAVE_DEMO }),
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

const telAleatorio = () =>
  '57' + String(Date.now()).slice(-8) + String(Math.floor(10 + Math.random() * 90));

async function nuevaConversacion(token: string, tel: string): Promise<string> {
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
              contacts: [{ profile: { name: 'Cliente Paso 4' }, wa_id: tel }],
              messages: [
                {
                  from: tel,
                  id: `wamid.SIM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'necesito un repuesto' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const firma = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
  await fetch(`${BASE}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma },
    body: cuerpo,
  });

  for (let i = 0; i < 25; i++) {
    const { cuerpo: lista } = await api(token, `/conversaciones?estado=todas&q=${tel}&asignado=todos`);
    if (lista?.length) return lista[0].id;
    await dormir(250);
  }
  throw new Error('la conversación no apareció');
}

/** PNG de 8x8 válido, para no depender de un archivo externo. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKUlEQVR4nGP8//8/AzUBEwOVwahBoway' +
    'wagFwwYAAP//AwDPqQPZ8pBHnwAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Inserta un mensaje con archivo directamente.
 *
 * No pasa por el webhook a propósito: un media_id inventado haría que la
 * descarga contra Meta fallara, y lo que se quiere probar acá es el almacén y
 * el endpoint que sirve el archivo, no la bajada.
 */
async function mensajeConArchivo(conversationId: string): Promise<string> {
  const relativa = join('pruebas', `${randomUUID()}.png`);
  const absoluta = join(ALMACEN, relativa);

  await mkdir(dirname(absoluta), { recursive: true });
  await writeFile(absoluta, PNG);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, wa_message_id, direccion, tipo, cuerpo,
                           media_mime, media_url, media_nombre, media_tamano,
                           status, status_rank, wa_timestamp)
     VALUES ($1, $2, 'in', 'image', 'foto', 'image/png', $3, 'repuesto.png', $4,
             'delivered', 2, now())
     RETURNING id`,
    [
      conversationId,
      `wamid.SIMIMG${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      relativa.split(/[\\/]/).join('/'),
      PNG.length,
    ],
  );

  return rows[0].id;
}

/** Misma condición que usa el resumen, para una conversación puntual. */
async function estaSinResponder(conversationId: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM conversations c
      WHERE c.id = $1
        AND c.estado <> 'resuelto'
        AND c.last_inbound_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM messages m
           WHERE m.conversation_id = c.id AND m.direccion = 'out'
             AND m.status <> 'failed' AND m.sent_by_user_id IS NOT NULL
             AND m.wa_timestamp > c.last_inbound_at
        )`,
    [conversationId],
  );
  return rows[0].n === 1;
}

async function main() {
  exigirEntornoSeguro();

  try {
    await fetch(`${BASE}/api/auth/login`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {
    console.error(`\n  El servidor no responde en ${BASE}. Levantalo con: npm start\n`);
    process.exit(1);
  }

  const tokenAndres = await login('andres@repuestos.com');
  const tokenDaniela = await login('daniela@repuestos.com');
  const tokenCarolina = await login('carolina@repuestos.com');

  const conv = await nuevaConversacion(tokenAndres, telAleatorio());

  console.log('\narchivos\n');

  // La fila se crea siempre: vive en la base, que es la misma para todos. Lo
  // unico que necesita el disco de esta maquina es LEER el archivo, asi que es
  // lo unico que se salta contra un servidor remoto.
  const messageId = await mensajeConArchivo(conv);

  await pruebaLocal('sirve el archivo con su tipo y contenido', async () => {
    const r = await fetch(`${BASE}/api/media/${messageId}`, {
      headers: { Authorization: `Bearer ${tokenAndres}` },
    });

    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');

    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.length, PNG.length, 'el archivo servido no coincide');
    assert.ok(bytes.equals(PNG), 'los bytes no son los mismos');
  });

  await prueba('sin token no entrega el archivo', async () => {
    // Son fotos de clientes: no pueden quedar accesibles con adivinar la URL.
    const r = await fetch(`${BASE}/api/media/${messageId}`);
    assert.equal(r.status, 401);
  });

  await prueba('un mensaje sin archivo da 404', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 AND media_url IS NULL LIMIT 1`,
      [conv],
    );
    const r = await fetch(`${BASE}/api/media/${rows[0].id}`, {
      headers: { Authorization: `Bearer ${tokenAndres}` },
    });
    assert.equal(r.status, 404);
  });

  await prueba('el hilo marca cuáles tienen archivo', async () => {
    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const conFoto = cuerpo.find((m: any) => m.id === messageId);

    assert.ok(conFoto, 'el mensaje con foto no aparece en el hilo');
    assert.equal(conFoto.tieneMedia, true);
    assert.equal(conFoto.mediaMime, 'image/png');
    assert.equal(conFoto.mediaNombre, 'repuesto.png');
  });

  await prueba('el tope de archivo lo dicta el servidor', async () => {
    // Si el front lo tuviera hardcodeado, algún día dejarían de coincidir y el
    // asesor descubriría el límite recién cuando el envío falle.
    const { status, cuerpo } = await api(tokenAndres, '/config');
    assert.equal(status, 200);
    assert.equal(typeof cuerpo.maxArchivoMB, 'number');
    assert.ok(
      cuerpo.maxArchivoMB > 0 && cuerpo.maxArchivoMB <= 16,
      'fuera del rango que acepta WhatsApp',
    );
  });

  console.log('\nnotas internas\n');

  let notaId = '';

  await prueba('se agrega y aparece en la conversación', async () => {
    const { status, cuerpo } = await api(tokenAndres, `/conversaciones/${conv}/notas`, {
      method: 'POST',
      body: JSON.stringify({ cuerpo: 'el cliente ya pagó la seña' }),
    });
    assert.ok(status < 300, `no se pudo crear (${status})`);
    notaId = cuerpo.id;

    const { cuerpo: lista } = await api(tokenAndres, `/conversaciones/${conv}/notas`);
    assert.ok(
      lista.some((n: any) => n.id === notaId && n.autor === 'Andrés Gómez'),
      'la nota no figura con su autor',
    );
  });

  await prueba('una nota vacía se rechaza', async () => {
    const { status } = await api(tokenAndres, `/conversaciones/${conv}/notas`, {
      method: 'POST',
      body: JSON.stringify({ cuerpo: '   ' }),
    });
    assert.equal(status, 400);
  });

  await prueba('un asesor no puede borrar la nota de otro', async () => {
    const { status } = await api(tokenDaniela, `/notas/${notaId}`, { method: 'DELETE' });
    assert.equal(status, 400, 'Daniela pudo borrar una nota de Andrés');
  });

  await prueba('un supervisor sí puede borrarla', async () => {
    const { status } = await api(tokenCarolina, `/notas/${notaId}`, { method: 'DELETE' });
    assert.ok(status < 300, `la supervisora no pudo borrar (${status})`);

    const { cuerpo: lista } = await api(tokenAndres, `/conversaciones/${conv}/notas`);
    assert.ok(!lista.some((n: any) => n.id === notaId), 'la nota sigue ahí');
  });

  await prueba('las notas no salen como mensajes', async () => {
    // Si se colaran en messages, se le mandarían al cliente.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE conversation_id = $1 AND cuerpo LIKE '%pagó la seña%'`,
      [conv],
    );
    assert.equal((rows[0] as any).n, 0, 'una nota interna terminó en la tabla de mensajes');
  });

  console.log('\neliminar mensajes\n');

  await prueba('un entrante se saca de la bandeja y queda la lápida', async () => {
    const { cuerpo: antes } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const entrante = antes.find((m: any) => m.direccion === 'in' && !m.eliminado);

    const { status } = await api(tokenAndres, `/mensajes/${entrante.id}`, { method: 'DELETE' });
    assert.ok(status < 300, `no se pudo eliminar (${status})`);

    const { cuerpo: despues } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const marcado = despues.find((m: any) => m.id === entrante.id);

    assert.ok(marcado, 'el mensaje desapareció del hilo en vez de quedar marcado');
    assert.equal(marcado.eliminado, true);
    assert.equal(marcado.eliminadoPor, 'Andrés Gómez');
    // El contenido no puede seguir viajando al front aunque quede en la base.
    assert.equal(marcado.cuerpo, null, 'el cuerpo sigue llegando al front');
  });

  await prueba('el contenido se conserva en la base para auditoría', async () => {
    const { rows } = await pool.query(
      `SELECT cuerpo, eliminado_en, eliminado_por FROM messages
        WHERE conversation_id = $1 AND eliminado_en IS NOT NULL LIMIT 1`,
      [conv],
    );
    assert.ok(rows.length, 'no quedó registro');
    assert.ok((rows[0] as any).cuerpo, 'se borró el cuerpo: se pierde la auditoría');
    assert.ok((rows[0] as any).eliminado_por, 'no quedó quién lo eliminó');
  });

  await prueba('queda asentado en el registro de eventos', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events
        WHERE conversation_id = $1 AND tipo = 'mensaje_eliminado'`,
      [conv],
    );
    assert.ok((rows[0] as any).n >= 1, 'no se registró el evento');
  });

  await prueba('eliminar dos veces el mismo da 404', async () => {
    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const yaEliminado = cuerpo.find((m: any) => m.eliminado);

    const { status } = await api(tokenAndres, `/mensajes/${yaEliminado.id}`, { method: 'DELETE' });
    assert.equal(status, 404);
  });

  await prueba('un asesor no puede eliminar el saliente de otro', async () => {
    // Lo manda Daniela; Andrés no debería poder sacarlo del hilo.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, wa_message_id, direccion, tipo, cuerpo,
                             status, status_rank, sent_by_user_id, wa_timestamp)
       SELECT $1, $2, 'out', 'text', 'mensaje de Daniela', 'sent', 1, u.id, now()
         FROM users u WHERE u.email = 'daniela@repuestos.com'
       RETURNING id`,
      [conv, `wamid.SIMDEL${Date.now().toString(36)}`],
    );

    const { status } = await api(tokenAndres, `/mensajes/${rows[0].id}`, { method: 'DELETE' });
    assert.equal(status, 403, 'Andrés pudo eliminar un mensaje de Daniela');

    // Y la supervisora sí puede.
    const { status: conSupervisor } = await api(tokenCarolina, `/mensajes/${rows[0].id}`, {
      method: 'DELETE',
    });
    assert.ok(conSupervisor < 300, `la supervisora no pudo (${conSupervisor})`);
  });

  await prueba('la vista previa del chat ignora los eliminados', async () => {
    const tel = telAleatorio();
    const otra = await nuevaConversacion(tokenAndres, tel);

    // Se elimina el último ENTRANTE: los salientes del bot no son de Andrés y
    // el servidor se los rechazaría con 403.
    const { cuerpo: hilo } = await api(tokenAndres, `/conversaciones/${otra}/mensajes`);
    const ultimo = [...hilo].reverse().find((m: any) => m.direccion === 'in' && !m.eliminado);
    assert.ok(ultimo, 'no hay entrante para eliminar');

    const borrado = await api(tokenAndres, `/mensajes/${ultimo.id}`, { method: 'DELETE' });
    assert.ok(borrado.status < 300, `no se pudo eliminar (${borrado.status})`);

    const { cuerpo: lista } = await api(
      tokenAndres,
      `/conversaciones?estado=todas&q=${tel}&asignado=todos`,
    );
    const fila = lista.find((c: any) => c.id === otra);

    assert.notEqual(
      fila.vistaPrevia,
      ultimo.cuerpo,
      'la lista sigue mostrando el mensaje eliminado',
    );
  });

  /**
   * Las etiquetas que crea esta suite, para borrarlas al terminar.
   *
   * Sin esto quedaban en la base para siempre: cada corrida dejaba cuatro
   * (prueba-, filtro-, otra-, dup-) y despues de dos semanas habia 56 en la
   * fila de filtros de la bandeja, todas basura.
   */
  const etiquetasCreadas: string[] = [];

  console.log('\netiquetas\n');

  await prueba('se crea, se aplica y aparece en la bandeja', async () => {
    const nombre = `prueba-${Date.now().toString(36)}`;
    const { cuerpo: etiqueta } = await api(tokenAndres, '/etiquetas', {
      method: 'POST',
      body: JSON.stringify({ nombre, color: 'amber' }),
    });
    etiquetasCreadas.push(etiqueta.id);
    assert.ok(etiqueta.id, 'no devolvió la etiqueta creada');

    const { cuerpo: puestas } = await api(tokenAndres, `/conversaciones/${conv}/etiquetas`, {
      method: 'POST',
      body: JSON.stringify({ tagId: etiqueta.id }),
    });
    assert.ok(puestas.some((e: any) => e.nombre === nombre));

    const { cuerpo: lista } = await api(
      tokenAndres,
      `/conversaciones?estado=todas&q=&asignado=todos`,
    );
    const fila = lista.find((c: any) => c.id === conv);
    assert.ok(
      fila?.etiquetas?.some((e: any) => e.nombre === nombre),
      'la etiqueta no llega en la lista de chats',
    );

    const { cuerpo: sinEtiqueta } = await api(
      tokenAndres,
      `/conversaciones/${conv}/etiquetas/${etiqueta.id}`,
      { method: 'DELETE' },
    );
    assert.ok(!sinEtiqueta.some((e: any) => e.nombre === nombre), 'no se quitó');
  });

  await prueba('la lista se puede filtrar por etiqueta', async () => {
    const nombre = `filtro-${Date.now().toString(36)}`;
    const { cuerpo: etiqueta } = await api(tokenAndres, '/etiquetas', {
      method: 'POST',
      body: JSON.stringify({ nombre, color: 'violet' }),
    });
    etiquetasCreadas.push(etiqueta.id);

    // Se etiqueta una sola conversación de todas las que existen.
    await api(tokenAndres, `/conversaciones/${conv}/etiquetas`, {
      method: 'POST',
      body: JSON.stringify({ tagId: etiqueta.id }),
    });

    const { cuerpo: filtradas } = await api(
      tokenAndres,
      `/conversaciones?estado=todas&q=&asignado=todos&etiqueta=${etiqueta.id}`,
    );

    assert.equal(filtradas.length, 1, `devolvió ${filtradas.length} en vez de 1`);
    assert.equal(filtradas[0].id, conv);

    const { cuerpo: todas } = await api(
      tokenAndres,
      '/conversaciones?estado=todas&q=&asignado=todos',
    );
    assert.ok(todas.length > filtradas.length, 'el filtro no acotó nada');
  });

  await prueba('con dos etiquetas la conversación no sale repetida', async () => {
    // Con un JOIN en vez de EXISTS, cada etiqueta duplicaría la fila.
    const segunda = await api(tokenAndres, '/etiquetas', {
      method: 'POST',
      body: JSON.stringify({ nombre: `otra-${Date.now().toString(36)}`, color: 'sky' }),
    });
    etiquetasCreadas.push(segunda.cuerpo.id);

    await api(tokenAndres, `/conversaciones/${conv}/etiquetas`, {
      method: 'POST',
      body: JSON.stringify({ tagId: segunda.cuerpo.id }),
    });

    const { cuerpo } = await api(
      tokenAndres,
      `/conversaciones?estado=todas&q=&asignado=todos&etiqueta=${segunda.cuerpo.id}`,
    );

    const veces = cuerpo.filter((c: any) => c.id === conv).length;
    assert.equal(veces, 1, `la conversación aparece ${veces} veces`);
  });

  await prueba('un id de etiqueta inexistente devuelve vacío, no error', async () => {
    const { status, cuerpo } = await api(
      tokenAndres,
      '/conversaciones?estado=todas&q=&asignado=todos&etiqueta=00000000-0000-0000-0000-000000000000',
    );
    assert.equal(status, 200);
    assert.equal(cuerpo.length, 0);
  });

  await prueba('aplicar dos veces la misma no duplica', async () => {
    const nombre = `dup-${Date.now().toString(36)}`;
    const { cuerpo: etiqueta } = await api(tokenAndres, '/etiquetas', {
      method: 'POST',
      body: JSON.stringify({ nombre, color: 'sky' }),
    });
    etiquetasCreadas.push(etiqueta.id);

    await api(tokenAndres, `/conversaciones/${conv}/etiquetas`, {
      method: 'POST',
      body: JSON.stringify({ tagId: etiqueta.id }),
    });
    const { cuerpo: segunda } = await api(tokenAndres, `/conversaciones/${conv}/etiquetas`, {
      method: 'POST',
      body: JSON.stringify({ tagId: etiqueta.id }),
    });

    assert.equal(
      segunda.filter((e: any) => e.nombre === nombre).length,
      1,
      'la etiqueta quedó duplicada',
    );
  });

  console.log('\nmétricas\n');

  await prueba('el resumen de cola trae los conteos', async () => {
    const { status, cuerpo } = await api(tokenCarolina, '/metricas/resumen');
    assert.equal(status, 200);

    for (const campo of ['sinAsignar', 'totalChats', 'pendientes', 'sinLeer', 'sinResponder']) {
      assert.equal(typeof cuerpo[campo], 'number', `falta o no es número: ${campo}`);
    }
  });

  await prueba('el rendimiento lista a todo el equipo', async () => {
    const { status, cuerpo } = await api(tokenCarolina, '/metricas/rendimiento?dias=30');
    assert.equal(status, 200);
    assert.ok(cuerpo.length >= 7, 'faltan asesores');

    const andres = cuerpo.find((d: any) => d.nombre === 'Andrés Gómez');
    assert.ok(andres, 'Andrés no figura');
    assert.equal(typeof andres.atendidas, 'number');
    assert.equal(typeof andres.enviados, 'number');
    assert.ok(
      andres.medianaRespuestaSeg === null || typeof andres.medianaRespuestaSeg === 'number',
      'la mediana debería ser número o null',
    );
  });

  await prueba('cada número del resumen se puede desglosar', async () => {
    const { cuerpo: resumen } = await api(tokenCarolina, '/metricas/resumen');

    for (const categoria of ['sin_asignar', 'total', 'sin_leer', 'sin_responder', 'espera']) {
      const { status, cuerpo } = await api(tokenCarolina, `/metricas/cola/${categoria}`);
      assert.equal(status, 200, `falló ${categoria}`);
      assert.ok(Array.isArray(cuerpo), `${categoria} no devolvió lista`);

      for (const f of cuerpo) {
        assert.ok(f.id && f.telefono, `${categoria}: fila incompleta`);
      }
    }

    // Cada desglose tiene que cuadrar con su contador, o el panel miente.
    // Y todas las tarjetas cuentan lo mismo: conversaciones, no mensajes.
    const equivalencias: [string, keyof typeof resumen][] = [
      ['sin_asignar', 'sinAsignar'],
      ['total', 'totalChats'],
      ['sin_leer', 'sinLeer'],
      ['sin_responder', 'sinResponder'],
    ];

    for (const [categoria, campo] of equivalencias) {
      const { cuerpo: filas } = await api(tokenCarolina, `/metricas/cola/${categoria}`);
      assert.equal(
        filas.length,
        Math.min(resumen[campo] as number, 50),
        `el desglose de "${categoria}" no coincide con su contador`,
      );
    }
  });

  await prueba('el desglose viene ordenado por quién espera hace más', async () => {
    const { cuerpo } = await api(tokenCarolina, '/metricas/cola/sin_leer');
    if (cuerpo.length < 2) return; // nada que ordenar

    const esperas = cuerpo.map((f: any) => f.esperandoSeg ?? 0);
    const ordenado = [...esperas].sort((a, b) => b - a);
    assert.deepEqual(esperas, ordenado, 'no está ordenado de mayor a menor espera');
  });

  await prueba('el total cuenta abiertas y pendientes, no las resueltas', async () => {
    const { cuerpo: antes } = await api(tokenCarolina, '/metricas/resumen');

    const tel = telAleatorio();
    const nueva = await nuevaConversacion(tokenAndres, tel);

    const { cuerpo: conNueva } = await api(tokenCarolina, '/metricas/resumen');
    assert.equal(conNueva.totalChats, antes.totalChats + 1, 'no sumó la conversación nueva');

    // Pendiente sigue siendo trabajo: tiene que seguir contando.
    await api(tokenAndres, `/conversaciones/${nueva}/estado`, {
      method: 'POST',
      body: JSON.stringify({ estado: 'pendiente' }),
    });
    const { cuerpo: pendiente } = await api(tokenCarolina, '/metricas/resumen');
    assert.equal(pendiente.totalChats, conNueva.totalChats, 'pasarla a pendiente la descontó');

    // Resuelta ya no.
    await api(tokenAndres, `/conversaciones/${nueva}/estado`, {
      method: 'POST',
      body: JSON.stringify({ estado: 'resuelto' }),
    });
    const { cuerpo: resuelta } = await api(tokenCarolina, '/metricas/resumen');
    assert.equal(resuelta.totalChats, conNueva.totalChats - 1, 'la resuelta sigue contando');
  });

  await prueba('«sin responder» no es lo mismo que «sin leer»', async () => {
    const tel = telAleatorio();
    const nueva = await nuevaConversacion(tokenAndres, tel);

    // Abrirla borra el no leído, pero nadie contestó: tiene que seguir contando
    // como sin responder. Es justo el caso que se cae del radar.
    await api(tokenAndres, `/conversaciones/${nueva}/leida`, { method: 'POST' });

    const { cuerpo: detalle } = await api(tokenAndres, `/conversaciones/${nueva}`);
    assert.equal(detalle.noLeidos, 0, 'no se limpió el contador de no leídos');

    const { cuerpo: sinLeer } = await api(tokenCarolina, '/metricas/cola/sin_leer');
    assert.ok(
      !sinLeer.some((f: any) => f.id === nueva),
      'sigue figurando como sin leer después de abrirla',
    );

    // Se consulta esta conversación puntual y no la lista: el desglose corta en
    // 50 filas ordenadas por antigüedad, y la más nueva queda fuera del corte.
    assert.equal(await estaSinResponder(nueva), true, 'la abrieron sin contestar y no figura');
  });

  await prueba('un envío fallido no cuenta como respuesta', async () => {
    const tel = telAleatorio();
    const nueva = await nuevaConversacion(tokenAndres, tel);

    // Un saliente que nunca llegó no puede tapar que el cliente sigue esperando.
    await pool.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direccion, tipo, cuerpo,
                             status, status_rank, wa_timestamp)
       VALUES ($1, $2, 'out', 'text', 'no llegó', 'failed', 0, now() + interval '1 minute')`,
      [nueva, `wamid.SIMFAIL${Date.now().toString(36)}`],
    );

    assert.equal(
      await estaSinResponder(nueva),
      true,
      'un mensaje fallido la sacó de «sin responder»',
    );
  });

  await prueba('responder la saca de «sin responder»', async () => {
    const tel = telAleatorio();
    const nueva = await nuevaConversacion(tokenAndres, tel);

    await pool.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direccion, tipo, cuerpo,
                             status, status_rank, sent_by_user_id, wa_timestamp)
       SELECT $1, $2, 'out', 'text', 'ya te cotizo', 'sent', 1, u.id, now() + interval '1 minute'
         FROM users u WHERE u.email = 'andres@repuestos.com'`,
      [nueva, `wamid.SIMOK${Date.now().toString(36)}`],
    );

    assert.equal(
      await estaSinResponder(nueva),
      false,
      'sigue como sin responder después de contestarla',
    );
  });

  await prueba('una categoría inventada da 400', async () => {
    const { status } = await api(tokenCarolina, '/metricas/cola/lo_que_sea');
    assert.equal(status, 400);
  });

  await prueba('el rango de días se acota', async () => {
    // 9999 días no puede convertirse en un escaneo de toda la tabla.
    const { status } = await api(tokenCarolina, '/metricas/rendimiento?dias=9999');
    assert.equal(status, 200);
  });

  console.log('\nplantillas\n');

  await prueba('sincroniza contra Meta y lista', async () => {
    const { status, cuerpo } = await api(tokenAndres, '/plantillas/sincronizar', {
      method: 'POST',
    });
    assert.ok(status < 300, `la sincronización falló (${status})`);
    assert.equal(typeof cuerpo.sincronizadas, 'number');

    const { cuerpo: lista } = await api(tokenAndres, '/plantillas');
    assert.ok(Array.isArray(lista), 'la lista no es un array');

    for (const p of lista) {
      assert.equal(typeof p.textoCuerpo, 'string');
      assert.equal(typeof p.variablesCuerpo, 'number');
    }
  });

  await prueba('una plantilla inexistente da 404', async () => {
    const { status } = await api(
      tokenAndres,
      '/plantillas/00000000-0000-0000-0000-000000000000/enviar',
      { method: 'POST', body: JSON.stringify({ conversationId: conv }) },
    );
    assert.equal(status, 404);
  });

  await pool.end().catch(() => undefined);

  console.log('\nescribirle a alguien que no escribio');

  const telNuevo = telAleatorio();
  let convNueva = '';

  await prueba('abre el chat y le completa el indicativo', async () => {
    const { cuerpo } = await api(tokenAndres, '/conversaciones', {
      method: 'POST',
      body: JSON.stringify({ telefono: telNuevo.slice(2), nombre: 'Cliente Nuevo' }),
    });

    convNueva = cuerpo.id;
    assert.equal(cuerpo.telefono, telNuevo, 'no completo el indicativo');
    // Nunca escribio: la ventana tiene que estar cerrada.
    assert.equal(cuerpo.ventanaAbierta, false);
  });

  await prueba('el mismo numero no abre un chat duplicado', async () => {
    const { cuerpo } = await api(tokenAndres, '/conversaciones', {
      method: 'POST',
      body: JSON.stringify({ telefono: '+' + telNuevo }),
    });
    assert.equal(cuerpo.id, convNueva, 'creo una conversacion aparte');
  });

  await prueba('no deja mandarle texto libre', async () => {
    // Es la regla de WhatsApp, no una decision nuestra: sin un mensaje del
    // cliente en las ultimas 24 h solo salen plantillas aprobadas.
    const { status } = await api(tokenAndres, `/conversaciones/${convNueva}/mensajes`, {
      method: 'POST',
      body: JSON.stringify({ texto: 'hola' }),
    });
    assert.equal(status, 422, 'dejo mandar texto con la ventana cerrada');
  });

  await prueba('rechaza un numero que no es un numero', async () => {
    for (const mal of ['123', 'abcdef', '']) {
      const { status } = await api(tokenAndres, '/conversaciones', {
        method: 'POST',
        body: JSON.stringify({ telefono: mal }),
      });
      assert.equal(status, 400, `acepto: "${mal}"`);
    }
  });

  // Se borran las etiquetas que creo esta corrida. Con tokenCarolina porque es
  // supervisora: un asesor no puede borrar una etiqueta de todo el equipo.
  for (const id of etiquetasCreadas) {
    await api(tokenCarolina, `/etiquetas/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} PRUEBA(S) FALLARON\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
