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

  await prueba('una respuesta cita el mensaje al que contesta', async () => {
    // La cita se guarda apuntando a NUESTRA fila, no al wamid de Meta: el hilo
    // necesita saber quien lo dijo y que decia, y eso sale de la fila.
    const { cuerpo: antes } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const original = antes.find((m: any) => m.direccion === 'in');
    assert.ok(original, 'no hay ningun entrante al que responder');

    // Meta rechaza el envio por la lista blanca del numero de prueba, pero la
    // fila se escribe antes de llamar, que es lo que se mira aca.
    await api(tokenAndres, `/conversaciones/${conv}/mensajes`, {
      method: 'POST',
      body: JSON.stringify({ texto: 'te respondo esto', respondeA: original.id }),
    });

    const { cuerpo: despues } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const respuesta = despues.find((m: any) => m.cuerpo === 'te respondo esto');

    assert.ok(respuesta, 'no quedo la respuesta en el hilo');
    assert.ok(respuesta.citado, 'la respuesta salio sin cita');
    assert.equal(respuesta.citado.id, original.id, 'cita el mensaje equivocado');
    assert.equal(respuesta.citado.cuerpo, original.cuerpo, 'la cita no trae el texto del original');
    assert.equal(respuesta.citado.direccion, 'in');
  });

  await prueba('citar un mensaje inexistente no impide responder', async () => {
    // Perder la cita es molesto; no poder contestarle al cliente lo es mucho
    // mas. Asi que un id que no existe sale sin cita en vez de fallar.
    const { cuerpo: hilo } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`, {
      method: 'POST',
      body: JSON.stringify({
        texto: 'sale igual',
        respondeA: '00000000-0000-0000-0000-000000000000',
      }),
    }).then(() => api(tokenAndres, `/conversaciones/${conv}/mensajes`));

    const suelta = hilo.find((m: any) => m.cuerpo === 'sale igual');
    assert.ok(suelta, 'no se envio el mensaje');
    assert.equal(suelta.citado, null, 'invento una cita');
  });

  await prueba('un texto se reenvia a otro chat', async () => {
    // Meta rechaza el envio por la lista blanca del numero de prueba, pero la
    // fila se escribe antes de llamar, que es lo que se mira aca.
    const otra = await nuevaConversacion(tokenAndres, telAleatorio());

    const { cuerpo: origen } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const texto = origen.find((m: any) => m.tipo === 'text' && m.cuerpo);
    assert.ok(texto, 'no hay ningun texto que reenviar');

    await api(tokenAndres, `/mensajes/${texto.id}/reenviar`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: otra }),
    });

    const { cuerpo: destino } = await api(tokenAndres, `/conversaciones/${otra}/mensajes`);
    const llegado = destino.find((m: any) => m.direccion === 'out' && m.cuerpo === texto.cuerpo);

    assert.ok(llegado, 'el texto no llego a la otra conversacion');
    assert.equal(llegado.reenviado, true, 'no quedo marcado como reenviado');
  });

  await prueba('un archivo se reenvia sin volver a subirlo a mano', async () => {
    // El id de media que devuelve Meta vale 30 dias y no se guarda, asi que el
    // reenvio parte de nuestra copia en disco y la vuelve a subir.
    const otra = await nuevaConversacion(tokenAndres, telAleatorio());

    await api(tokenAndres, `/mensajes/${messageId}/reenviar`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: otra }),
    });

    const { cuerpo: destino } = await api(tokenAndres, `/conversaciones/${otra}/mensajes`);
    const foto = destino.find((m: any) => m.direccion === 'out' && m.tipo === 'image');

    assert.ok(foto, 'la foto no llego a la otra conversacion');
    assert.equal(foto.reenviado, true, 'no quedo marcada como reenviada');
    assert.equal(foto.mediaNombre, 'repuesto.png', 'perdio el nombre del archivo');
  });

  await prueba('no se reenvia un mensaje a su propia conversacion', async () => {
    const { cuerpo: hilo } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const alguno = hilo.find((m: any) => m.cuerpo);

    const { status } = await api(tokenAndres, `/mensajes/${alguno.id}/reenviar`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: conv }),
    });
    assert.equal(status, 400, 'dejo reenviarlo a donde ya estaba');
  });

  await prueba('reenviar un mensaje que no existe da 404', async () => {
    const { status } = await api(
      tokenAndres,
      '/mensajes/00000000-0000-0000-0000-000000000000/reenviar',
      { method: 'POST', body: JSON.stringify({ conversationId: conv }) },
    );
    assert.equal(status, 404);
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
  await pruebaLocal('el nombre del archivo no se escribe como texto, salvo en un documento', async () => {
    // El nombre de una nota de voz lo inventa la bandeja
    // («nota-de-voz-2026-08-27221916.ogg»): escrito al lado del reproductor no
    // le dice nada a nadie. El de un documento si es la informacion util — sin
    // el, en la lista de chats la vista previa quedaria vacia.
    //
    // Solo local: contra el numero de prueba de Meta el envio se rechaza por la
    // lista blanca, que es justo lo que hace falta (la fila se escribe ANTES de
    // llamar a Meta). Con el numero de produccion, en cambio, un telefono
    // inventado podria ser el de alguien de verdad.
    async function mandar(nombre: string, mime: string, datos: Buffer) {
      const fd = new FormData();
      fd.append('archivo', new Blob([datos], { type: mime }), nombre);
      await fetch(`${BASE}/api/conversaciones/${conv}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenAndres}` },
        body: fd,
      });
    }

    await mandar('captura-2026.png', 'image/png', PNG);
    await mandar('cotizacion-4321.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'));

    const { cuerpo: hilo } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const salientes = hilo.filter((m: any) => m.direccion === 'out');

    const foto = salientes.find((m: any) => m.mediaNombre === 'captura-2026.png');
    assert.ok(foto, 'no quedo la foto en el hilo');
    assert.equal(foto.cuerpo ?? null, null, 'la foto escribe el nombre del archivo como texto');

    const doc = salientes.find((m: any) => m.mediaNombre === 'cotizacion-4321.pdf');
    assert.ok(doc, 'no quedo el documento en el hilo');
    assert.equal(doc.cuerpo, 'cotizacion-4321.pdf', 'el documento perdio su nombre');
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

  await prueba('una nota puede ser informacion en vez de comentario', async () => {
    // Dos clases: `interna` es un comentario del equipo, `informacion` es un
    // dato del pedido. Van en colores distintos en el hilo.
    const { status, cuerpo } = await api(tokenAndres, `/conversaciones/${conv}/notas`, {
      method: 'POST',
      body: JSON.stringify({ cuerpo: 'alternador ref 037903025K', tipo: 'informacion' }),
    });
    assert.ok(status < 300, `no se pudo crear (${status})`);
    assert.equal(cuerpo.tipo, 'informacion');

    const { cuerpo: lista } = await api(tokenAndres, `/conversaciones/${conv}/notas`);
    const guardada = lista.find((n: any) => n.id === cuerpo.id);
    assert.equal(guardada.tipo, 'informacion', 'el tipo no se guardo');
  });

  await prueba('sin decir el tipo, la nota es interna', async () => {
    // Las notas que ya existian no tienen tipo escrito: tienen que seguir
    // siendo lo que eran.
    const { cuerpo } = await api(tokenAndres, `/conversaciones/${conv}/notas`, {
      method: 'POST',
      body: JSON.stringify({ cuerpo: 'sin tipo' }),
    });
    assert.equal(cuerpo.tipo, 'interna');
  });

  await prueba('un tipo inventado se rechaza', async () => {
    const { status } = await api(tokenAndres, `/conversaciones/${conv}/notas`, {
      method: 'POST',
      body: JSON.stringify({ cuerpo: 'algo', tipo: 'urgente' }),
    });
    assert.equal(status, 400);
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

  console.log('\nfoto del contacto\n');

  // No es la foto de perfil de WhatsApp: esa no se puede leer. La Cloud API no
  // la expone, y la unica via que la tiene —una sesion de WhatsApp Web— exige
  // que el numero este en la app normal, cosa que deja de ser cierta al migrar
  // a la API. Esta la pone el equipo.
  await prueba('una imagen del hilo se puede usar como foto', async () => {
    const { cuerpo: antes } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.equal(antes.tieneFoto, false, 'arranca sin foto');

    const { status } = await api(tokenAndres, `/contactos/${antes.contactoId}/foto-de-mensaje`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    });
    assert.ok(status < 300, `no se pudo poner (${status})`);

    const { cuerpo: despues } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.equal(despues.tieneFoto, true, 'el detalle no dice que tiene foto');

    const { cuerpo: lista } = await api(tokenAndres, '/conversaciones?estado=todas&asignado=todos');
    const suya = lista.find((c: any) => c.id === conv);
    assert.equal(suya.tieneFoto, true, 'la lista de chats no la muestra');
  });

  await pruebaLocal('la foto se sirve, y sólo con token', async () => {
    const { cuerpo: det } = await api(tokenAndres, `/conversaciones/${conv}`);

    const con = await fetch(`${BASE}/api/contactos/${det.contactoId}/foto`, {
      headers: { Authorization: `Bearer ${tokenAndres}` },
    });
    assert.equal(con.status, 200);
    assert.match(con.headers.get('content-type') ?? '', /^image\//);

    // Son fotos de clientes: no pueden quedar accesibles con adivinar la URL.
    const sin = await fetch(`${BASE}/api/contactos/${det.contactoId}/foto`);
    assert.equal(sin.status, 401);
  });

  await prueba('un mensaje sin imagen no sirve de foto', async () => {
    const { cuerpo: det } = await api(tokenAndres, `/conversaciones/${conv}`);
    const { cuerpo: hilo } = await api(tokenAndres, `/conversaciones/${conv}/mensajes`);
    const texto = hilo.find((m: any) => m.tipo === 'text');

    const { status } = await api(tokenAndres, `/contactos/${det.contactoId}/foto-de-mensaje`, {
      method: 'POST',
      body: JSON.stringify({ messageId: texto.id }),
    });
    assert.equal(status, 404);
  });

  await prueba('la foto se puede quitar', async () => {
    const { cuerpo: det } = await api(tokenAndres, `/conversaciones/${conv}`);
    const { status } = await api(tokenAndres, `/contactos/${det.contactoId}/foto`, {
      method: 'DELETE',
    });
    assert.ok(status < 300);

    const { cuerpo: despues } = await api(tokenAndres, `/conversaciones/${conv}`);
    assert.equal(despues.tieneFoto, false);
  });

  console.log('\npermisos por rol\n');

  await prueba('un asesor no puede ver las conversaciones de otro', async () => {
    // El numero de cada uno lo puede ver cualquiera —hace falta para saber a
    // quien pasarle un chat—, pero abrir la lista de otro es supervisar su
    // trabajo, y eso le toca a quien supervisa.
    const { cuerpo: equipo } = await api(tokenAndres, '/equipo');
    const otro = equipo.find((m: any) => m.nombre !== 'Andrés Gómez');
    assert.ok(otro, 'no hay otro asesor con quien probar');

    const { status } = await api(tokenAndres, `/equipo/${otro.id}/conversaciones`);
    assert.equal(status, 403, 'un asesor pudo espiar la carga de otro');
  });

  await prueba('un supervisor si puede', async () => {
    const { cuerpo: equipo } = await api(tokenCarolina, '/equipo');
    const alguno = equipo[0];

    const { status, cuerpo } = await api(tokenCarolina, `/equipo/${alguno.id}/conversaciones`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(cuerpo), 'no devolvio una lista');
  });

  await prueba('las cuentas son solo del admin', async () => {
    // Ni el supervisor ni el asesor: crear, borrar, cambiar claves y roles es
    // del administrador y de nadie mas.
    for (const [quien, token] of [
      ['asesor', tokenAndres],
      ['supervisor', tokenCarolina],
    ] as const) {
      const { status } = await api(token, '/admin/usuarios', {
        method: 'POST',
        body: JSON.stringify({
          nombre: 'Colado',
          email: `colado.${Date.now()}@chatwasvw.com`,
          clave: 'unaClaveLarga123',
          rol: 'asesor',
        }),
      });
      assert.equal(status, 403, `un ${quien} pudo crear una cuenta`);

      const { status: listar } = await api(token, '/admin/usuarios');
      assert.equal(listar, 403, `un ${quien} pudo listar las cuentas`);
    }
  });

  console.log('\nsesiones\n');

  // Dos ranuras por asesor: el celular y la computadora. El limite es por TIPO
  // y no un contador hasta dos, para que un segundo celular cierre el primer
  // celular y no la computadora.
  const AGENTE = {
    pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    appWindows:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Electron/43.0 Safari/537.36',
    celular:
      'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    apk: 'Mozilla/5.0 (Linux; Android 14; SM-A546E; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
  };

  async function entrarComo(agente: string): Promise<string> {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': agente },
      body: JSON.stringify({ email: 'daniela@repuestos.com', clave: CLAVE_DEMO }),
    });
    const cuerpo = (await r.json()) as { token?: string };
    assert.ok(cuerpo.token, `no entro con ${agente.slice(0, 30)}`);
    return cuerpo.token;
  }

  const sigueViva = async (token: string) =>
    (await fetch(`${BASE}/api/auth/yo`, { headers: { Authorization: `Bearer ${token}` } })).ok;

  await prueba('el celular y la computadora conviven', async () => {
    const pc = await entrarComo(AGENTE.pc);
    const celular = await entrarComo(AGENTE.celular);

    assert.ok(await sigueViva(pc), 'entrar del celular cerro la computadora');
    assert.ok(await sigueViva(celular), 'la sesion del celular no quedo');
  });

  await prueba('un segundo celular cierra el primero, no la computadora', async () => {
    const pc = await entrarComo(AGENTE.pc);
    const celular = await entrarComo(AGENTE.celular);
    const otroCelular = await entrarComo(AGENTE.apk);

    assert.equal(await sigueViva(celular), false, 'el celular viejo tenia que cerrarse');
    assert.ok(await sigueViva(otroCelular), 'el celular nuevo tenia que quedar');
    assert.ok(await sigueViva(pc), 'la computadora no se toca');
  });

  await prueba('la app de Windows ocupa la ranura de escritorio', async () => {
    // Su User-Agent tambien dice "Chrome": si no se mirara "Electron" primero,
    // seria una tercera ranura y el limite de dos dejaria de valer.
    const navegador = await entrarComo(AGENTE.pc);
    await entrarComo(AGENTE.appWindows);

    assert.equal(await sigueViva(navegador), false, 'quedaron dos sesiones de escritorio');
  });

  await prueba('salir cierra la sesion en el servidor', async () => {
    // Sin esto, salir solo borraba el token del navegador: la ranura seguia
    // ocupada hasta que el token venciera.
    const token = await entrarComo(AGENTE.pc);
    await fetch(`${BASE}/api/auth/salir`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(await sigueViva(token), false, 'la sesion seguia viva despues de salir');
  });

  await prueba('nunca hay mas de dos sesiones abiertas', async () => {
    for (const agente of [AGENTE.pc, AGENTE.celular, AGENTE.apk, AGENTE.appWindows, AGENTE.pc]) {
      await entrarComo(agente);
    }

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE u.email = $1 AND s.revocada_en IS NULL`,
      ['daniela@repuestos.com'],
    );
    assert.ok(rows[0].n <= 2, `quedaron ${rows[0].n} sesiones abiertas`);
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

  await prueba('el selector no muestra las plantillas de ejemplo de Meta', async () => {
    // La cuenta trae de fabrica hello_world y las de la tienda «Jasper's
    // Market», en ingles. No se pueden borrar sin control total sobre la cuenta
    // de WhatsApp, asi que se filtran por idioma: una plantilla en ingles no se
    // le manda a un cliente de Bogota.
    const { cuerpo: lista } = await api(tokenAndres, '/plantillas');

    const enOtroIdioma = lista.filter((p: any) => p.idioma !== 'es');
    assert.deepEqual(
      enOtroIdioma.map((p: any) => p.nombre),
      [],
      'el selector muestra plantillas que no son del idioma del negocio',
    );

    assert.ok(
      lista.some((p: any) => p.nombre === 'seguimiento_consulta'),
      'se filtraron tambien las del negocio',
    );
  });

  await prueba('el selector no muestra las plantillas de prueba', async () => {
    // Las que quedaron de probar tampoco se pueden borrar de la cuenta, y esas
    // si estan en espanol: el filtro por idioma no las agarra. Se esconden por
    // nombre, para que nadie mande «Prueba temporal.» a un cliente.
    const { cuerpo: lista } = await api(tokenAndres, '/plantillas');

    const dePrueba = lista.filter((p: any) => /^prueba|_tmp$/i.test(p.nombre));
    assert.deepEqual(
      dePrueba.map((p: any) => p.nombre),
      [],
      'el selector muestra plantillas de prueba',
    );
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
