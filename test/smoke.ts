/**
 * Smoke test sobre Postgres embebido (PGlite). No necesita servidor ni Docker.
 *   npm run test:smoke
 *
 * Verifica lo que de verdad puede romperse:
 *   1. el indice unico parcial + ON CONFLICT que evita conversaciones duplicadas
 *   2. la idempotencia de wa_message_id ante webhooks repetidos
 *   3. que los estados solo avancen aunque lleguen desordenados
 *   4. el calculo de la ventana de 24h
 *   5. la cola con FOR UPDATE SKIP LOCKED
 *   6. la validacion de firma X-Hub-Signature-256
 */
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { opcionElegida, pideHumano } from '../src/bot/flujo';
import {
  esFestivo,
  estaAbierto,
  festivosDe,
  parsearFranja,
  proximaApertura,
} from '../src/bot/horario';
import { extraerContenido, fechaDeMeta } from '../src/messages/contenido';
import { firmaValida } from '../src/whatsapp/signature';
import { coordenadasDe, esEnlaceCorto } from '../src/messages/ubicacion';
import { aE164 } from '../src/conversations/conversations.service';

let fallos = 0;

async function prueba(nombre: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok  ${nombre}`);
  } catch (e) {
    fallos++;
    console.error(`  FALLO  ${nombre}`);
    console.error(`         ${(e as Error).message}`);
  }
}

async function main() {
  const db = new PGlite();

  const archivo = readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort()[0];

  const sentencias = readFileSync(join('drizzle', archivo), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of sentencias) await db.exec(stmt);
  console.log(`\nesquema aplicado (${archivo})\n`);

  // --- helpers que replican el SQL de los servicios -------------------------

  const contacto = async (waId: string, nombre: string | null = null) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO contacts (wa_id, telefono, nombre) VALUES ($1, $1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET nombre = coalesce(excluded.nombre, contacts.nombre)
       RETURNING id`,
      [waId, nombre],
    );
    return r.rows[0].id;
  };

  const entrante = async (contactId: string, cuando: Date) => {
    const r = await db.query<{ id: string; window_expires_at: string; estado: string }>(
      `INSERT INTO conversations (contact_id, estado, last_inbound_at, window_expires_at, last_message_at)
       VALUES ($1, 'abierto', $2, $2::timestamptz + interval '24 hours', $2)
       ON CONFLICT (contact_id) WHERE estado <> 'resuelto'
       DO UPDATE SET
         estado            = 'abierto',
         last_inbound_at   = greatest(conversations.last_inbound_at,   excluded.last_inbound_at),
         window_expires_at = greatest(conversations.window_expires_at, excluded.window_expires_at),
         last_message_at   = greatest(conversations.last_message_at,   excluded.last_message_at)
       RETURNING id, window_expires_at, estado`,
      [contactId, cuando.toISOString()],
    );
    return r.rows[0];
  };

  const guardarEntrante = async (convId: string, waId: string, cuando: Date) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, wa_message_id, direccion, tipo, cuerpo,
                             status, status_rank, wa_timestamp)
       VALUES ($1, $2, 'in', 'text', 'hola', 'delivered', 2, $3)
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING id`,
      [convId, waId, cuando.toISOString()],
    );
    return r.rows;
  };

  const aplicarEstado = async (waId: string, nuevo: string, rango: number) => {
    const r = await db.query(
      `UPDATE messages SET status = $2, status_rank = $3
        WHERE wa_message_id = $1 AND ($2 = 'failed' OR status_rank < $3)
      RETURNING id`,
      [waId, nuevo, rango],
    );
    return r.rows.length;
  };

  const iso = (v: string | Date) => new Date(v).toISOString();

  // --- conversaciones ------------------------------------------------------

  console.log('conversaciones');

  await prueba('un contacto nunca tiene dos conversaciones vivas', async () => {
    const c = await contacto('51999000001', 'Chris');
    const a = await entrante(c, new Date('2026-08-20T15:00:00Z'));
    const b = await entrante(c, new Date('2026-08-20T15:05:00Z'));
    assert.equal(a.id, b.id, 'el segundo mensaje creo otra conversacion');

    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations WHERE contact_id = $1`,
      [c],
    );
    assert.equal(r.rows[0].n, 1);
  });

  await prueba('la ventana de 24h se corre con cada entrante', async () => {
    const c = await contacto('51999000002');
    await entrante(c, new Date('2026-08-20T10:00:00Z'));
    const b = await entrante(c, new Date('2026-08-20T18:00:00Z'));
    assert.equal(iso(b.window_expires_at), '2026-08-21T18:00:00.000Z');
  });

  await prueba('un webhook atrasado NO retrocede la ventana', async () => {
    const c = await contacto('51999000003');
    await entrante(c, new Date('2026-08-20T18:00:00Z'));
    const viejo = await entrante(c, new Date('2026-08-20T10:00:00Z'));
    assert.equal(
      iso(viejo.window_expires_at),
      '2026-08-21T18:00:00.000Z',
      'greatest() no protegio la ventana',
    );
  });

  await prueba('resolver la conversacion permite abrir una nueva', async () => {
    const c = await contacto('51999000004');
    const a = await entrante(c, new Date('2026-08-20T10:00:00Z'));
    await db.query(`UPDATE conversations SET estado = 'resuelto' WHERE id = $1`, [a.id]);
    const b = await entrante(c, new Date('2026-08-22T10:00:00Z'));
    assert.notEqual(a.id, b.id, 'reabrio una conversacion ya cerrada');
  });

  await prueba('un entrante reactiva una conversacion en pendiente', async () => {
    const c = await contacto('51999000005');
    const a = await entrante(c, new Date('2026-08-20T10:00:00Z'));
    await db.query(`UPDATE conversations SET estado = 'pendiente' WHERE id = $1`, [a.id]);
    const b = await entrante(c, new Date('2026-08-20T11:00:00Z'));
    assert.equal(b.id, a.id);
    assert.equal(b.estado, 'abierto');
  });

  // --- mensajes ------------------------------------------------------------

  console.log('\nmensajes');

  await prueba('el mismo webhook dos veces guarda un solo mensaje', async () => {
    const c = await contacto('51999000010');
    const conv = await entrante(c, new Date('2026-08-20T10:00:00Z'));
    const cuando = new Date('2026-08-20T10:00:00Z');
    const primera = await guardarEntrante(conv.id, 'wamid.DUP1', cuando);
    const segunda = await guardarEntrante(conv.id, 'wamid.DUP1', cuando);
    assert.equal(primera.length, 1, 'no inserto la primera vez');
    assert.equal(segunda.length, 0, 'el reintento de Meta duplico el mensaje');
  });

  await prueba('delivered que llega tarde no pisa a read', async () => {
    const c = await contacto('51999000011');
    const conv = await entrante(c, new Date('2026-08-20T10:00:00Z'));
    await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direccion, tipo, cuerpo,
                             status, status_rank, wa_timestamp)
       VALUES ($1, 'wamid.OUT1', 'out', 'text', 'hola', 'sent', 1, now())`,
      [conv.id],
    );

    assert.equal(await aplicarEstado('wamid.OUT1', 'read', 3), 1, 'no aplico read');
    assert.equal(
      await aplicarEstado('wamid.OUT1', 'delivered', 2),
      0,
      'delivered retrocedio el estado',
    );

    const r = await db.query<{ status: string }>(
      `SELECT status FROM messages WHERE wa_message_id = 'wamid.OUT1'`,
    );
    assert.equal(r.rows[0].status, 'read');
  });

  await prueba('failed se aplica siempre, sin importar el rango', async () => {
    assert.equal(
      await aplicarEstado('wamid.OUT1', 'failed', 0),
      1,
      'failed quedo bloqueado por el rango',
    );
  });

  // --- cola ----------------------------------------------------------------

  console.log('\ncola de webhooks');

  await prueba('SKIP LOCKED entrega cada evento una sola vez', async () => {
    await db.exec(`INSERT INTO webhook_events (payload) VALUES ('{"n":1}'), ('{"n":2}')`);

    await db.exec('BEGIN');
    const a = await db.query<{ id: number }>(
      `SELECT id FROM webhook_events
        WHERE processed_at IS NULL AND attempts < 5
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    assert.equal(a.rows.length, 1, 'no reclamo trabajo');
    await db.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [a.rows[0].id]);
    await db.exec('COMMIT');

    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM webhook_events WHERE processed_at IS NULL`,
    );
    assert.equal(r.rows[0].n, 1, 'el conteo de pendientes no cuadra');
  });

  await prueba('un evento agotado deja de reintentarse', async () => {
    await db.exec(
      `INSERT INTO webhook_events (payload, attempts, last_error) VALUES ('{"n":3}', 5, 'boom')`,
    );
    const r = await db.query(
      `SELECT id FROM webhook_events WHERE processed_at IS NULL AND attempts < 5`,
    );
    assert.equal(r.rows.length, 1, 'el evento agotado sigue en la cola');
  });

  // --- firma y parseo ------------------------------------------------------

  console.log('\nfirma y parseo');

  await prueba('firma valida pasa, cualquier alteracion no', () => {
    const secreto = 'secreto-de-prueba';
    const cuerpo = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
    const firma = 'sha256=' + createHmac('sha256', secreto).update(cuerpo).digest('hex');

    assert.equal(firmaValida(cuerpo, firma, secreto), true, 'rechazo una firma legitima');
    assert.equal(
      firmaValida(Buffer.concat([cuerpo, Buffer.from(' ')]), firma, secreto),
      false,
      'acepto un body alterado',
    );
    assert.equal(firmaValida(cuerpo, firma, 'otro-secreto'), false, 'acepto secreto incorrecto');
    assert.equal(firmaValida(cuerpo, undefined, secreto), false, 'acepto cabecera ausente');
    assert.equal(firmaValida(cuerpo, 'sha256=zzzz', secreto), false, 'acepto hex invalido');
    assert.equal(
      firmaValida(cuerpo, firma.replace('sha256=', ''), secreto),
      false,
      'acepto cabecera sin prefijo',
    );
  });

  await prueba('extrae contenido de los tipos principales', () => {
    assert.equal(
      extraerContenido({
        id: '1',
        from: 'x',
        timestamp: '1',
        type: 'text',
        text: { body: 'hola' },
      }).cuerpo,
      'hola',
    );

    const img = extraerContenido({
      id: '2',
      from: 'x',
      timestamp: '1',
      type: 'image',
      image: { id: 'MID', mime_type: 'image/jpeg', caption: 'mira esto' },
    });
    assert.equal(img.mediaId, 'MID');
    assert.equal(img.mediaMime, 'image/jpeg');
    assert.equal(img.cuerpo, 'mira esto');

    assert.equal(
      extraerContenido({
        id: '3',
        from: 'x',
        timestamp: '1',
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Si, quiero' } },
      }).cuerpo,
      'Si, quiero',
    );

    // Un tipo que Meta agregue manana no debe tumbar el worker.
    assert.equal(
      extraerContenido({ id: '4', from: 'x', timestamp: '1', type: 'tipo_futuro' }).cuerpo,
      '[tipo_futuro]',
    );
  });

  await prueba('convierte el epoch en segundos de Meta', () => {
    assert.equal(fechaDeMeta('1755702000').toISOString(), '2025-08-20T15:00:00.000Z');
    assert.ok(fechaDeMeta(undefined) instanceof Date, 'timestamp ausente debe caer a now()');
  });

  console.log('\nhorario y festivos');

  const ZONA = 'America/Bogota';
  const semana = parsearFranja('08:30-17:30');
  const sabado = parsearFranja('08:30-14:00');
  const horario = {
    zona: ZONA,
    porDia: [null, semana, semana, semana, semana, semana, sabado],
  };

  await prueba('los festivos de Colombia se calculan, no se listan', () => {
    // 18 por año. Una lista escrita a mano vence en diciembre y el bot empieza
    // a decir «estamos abiertos» un 6 de enero.
    assert.equal(festivosDe(2026).size, 18);
    assert.equal(festivosDe(2027).size, 18);

    // Fijos.
    assert.ok(festivosDe(2026).has('2026-01-01'), 'falta Año Nuevo');
    assert.ok(festivosDe(2026).has('2026-08-07'), 'falta Batalla de Boyacá');
    assert.ok(festivosDe(2026).has('2026-12-25'), 'falta Navidad');

    // Ley Emiliani: se corren al lunes siguiente.
    assert.ok(festivosDe(2026).has('2026-01-12'), 'Reyes no se movió al lunes');
    assert.ok(!festivosDe(2026).has('2026-01-06'), 'Reyes quedó en su fecha original');
    assert.ok(festivosDe(2026).has('2026-11-16'), 'Cartagena no se movió al lunes');

    // Semana Santa: no se mueve.
    assert.ok(festivosDe(2026).has('2026-04-02'), 'falta Jueves Santo');
    assert.ok(festivosDe(2026).has('2026-04-03'), 'falta Viernes Santo');

    // Móviles calculadas desde Pascua.
    assert.ok(festivosDe(2026).has('2026-05-18'), 'falta Ascensión');
    assert.ok(festivosDe(2026).has('2026-06-15'), 'falta Sagrado Corazón');
  });

  await prueba('el horario se evalúa en la zona del negocio', () => {
    // El servidor puede estar en cualquier zona: si se usara la suya, el bot
    // diría «estamos abiertos» a las 3 de la mañana.
    assert.equal(estaAbierto(new Date('2026-08-24T13:00:00Z'), horario), false, 'lunes 8:00');
    assert.equal(estaAbierto(new Date('2026-08-24T14:00:00Z'), horario), true, 'lunes 9:00');
    assert.equal(estaAbierto(new Date('2026-08-24T22:29:00Z'), horario), true, 'lunes 17:29');
    assert.equal(estaAbierto(new Date('2026-08-24T22:30:00Z'), horario), false, 'lunes 17:30');
  });

  await prueba('sábado corto, domingo cerrado', () => {
    assert.equal(estaAbierto(new Date('2026-08-29T18:00:00Z'), horario), true, 'sábado 13:00');
    assert.equal(estaAbierto(new Date('2026-08-29T19:30:00Z'), horario), false, 'sábado 14:30');
    assert.equal(estaAbierto(new Date('2026-08-30T16:00:00Z'), horario), false, 'domingo');
  });

  await prueba('un festivo cierra aunque sea día hábil', () => {
    const boyaca = new Date('2026-08-07T16:00:00Z'); // viernes 11:00
    assert.equal(esFestivo(boyaca, ZONA), true);
    assert.equal(estaAbierto(boyaca, horario), false, 'abrió en Batalla de Boyacá');
  });

  await prueba('la próxima apertura saltea domingos y festivos', () => {
    assert.match(proximaApertura(new Date('2026-08-29T20:00:00Z'), horario), /lunes/);
    // Jueves a la tarde: el viernes es Boyacá, así que abre el sábado.
    assert.match(proximaApertura(new Date('2026-08-06T23:00:00Z'), horario), /sábado/);
  });

  await prueba('un horario mal escrito falla al arrancar, no en caliente', () => {
    assert.throws(() => parsearFranja('8:30 a 17:30'));
    assert.throws(() => parsearFranja('17:30-08:30'), /después/);
    assert.equal(parsearFranja('cerrado'), null);
  });

  console.log('\ntelefonos');

  await prueba('completa el indicativo de los numeros locales', () => {
    // Un asesor escribe el celular como lo tiene en la agenda. Meta lo exige
    // en E.164 sin '+', asi que todas estas formas tienen que dar lo mismo.
    for (const entrada of [
      '3181875988',
      '318 187 5988',
      '+57 318 187 5988',
      '573181875988',
      '0057 318 1875988',
      '(318) 187-5988',
    ]) {
      assert.equal(aE164(entrada, '57'), '573181875988', `fallo con: ${entrada}`);
    }
  });

  await prueba('no le toca el indicativo a un numero extranjero', () => {
    // La regla es "10 digitos = local". Un numero mas largo ya trae indicativo
    // y anteponerle 57 lo convertiria en un numero que no existe.
    assert.equal(aE164('13055550123', '57'), '13055550123');
    assert.equal(aE164('4915112345678', '57'), '4915112345678');
  });

  console.log('\nubicaciones');

  await prueba('saca las coordenadas de lo que pega un asesor', () => {
    // Nadie escribe coordenadas: copia el enlace desde Maps. Estos son los
    // formatos que salen del telefono y del navegador.
    const esperado = { latitud: 4.6482, longitud: -74.0776 };

    for (const entrada of [
      'https://www.google.com/maps/@4.6482,-74.0776,17z',
      'https://maps.google.com/?q=4.6482,-74.0776',
      'https://www.google.com/maps/place/Repuestos/@4.6482,-74.0776,17z/data=!3m1!4b1',
      'https://www.google.com/maps/place/x/data=!4m6!3m5!1s0x1!8m2!3d4.6482!4d-74.0776',
      'https://www.google.com/maps/dir/?api=1&destination=4.6482,-74.0776',
      '4.6482, -74.0776',
      '4.6482,-74.0776',
    ]) {
      assert.deepEqual(coordenadasDe(entrada), esperado, `no lo reconocio: ${entrada}`);
    }
  });

  await prueba('no inventa una ubicacion cuando no hay ninguna', () => {
    // Mandar una coordenada equivocada es peor que no mandar nada: el cliente
    // maneja hasta el otro lado de la ciudad.
    for (const entrada of ['hola como estas', 'https://www.google.com/maps', '', '200, -74']) {
      assert.equal(coordenadasDe(entrada), null, `invento algo con: "${entrada}"`);
    }

    // 0,0 es el Golfo de Guinea: casi siempre significa que el parseo fallo.
    assert.equal(coordenadasDe('0,0'), null);
  });

  await prueba('reconoce los enlaces cortos, que hay que resolver aparte', () => {
    assert.equal(esEnlaceCorto('https://maps.app.goo.gl/abc123'), true);
    assert.equal(esEnlaceCorto('https://goo.gl/maps/abc123'), true);
    assert.equal(esEnlaceCorto('https://www.google.com/maps/@4.6,-74.0,17z'), false);
    assert.equal(esEnlaceCorto('4.6482, -74.0776'), false);
  });

  console.log('\nflujo del bot');

  await prueba('entiende el botón, el número y el texto suelto', () => {
    assert.equal(opcionElegida('', 'cotizar'), 'cotizar');
    assert.equal(opcionElegida('1'), 'cotizar');
    assert.equal(opcionElegida('cuanto vale un espejo'), 'cotizar');
    assert.equal(opcionElegida('quiero saber de mi pedido'), 'pedido');
    assert.equal(opcionElegida('3'), 'asesor');
    assert.equal(opcionElegida('askjdhaskjd'), null);
  });

  await prueba('detecta cuando el cliente pide una persona', () => {
    // Nadie tiene que quedar atrapado en un menú: es la queja número uno.
    for (const frase of ['quiero hablar con un asesor', 'me pasas con alguien', 'HUMANO']) {
      assert.equal(pideHumano(frase), true, `no detectó: "${frase}"`);
    }
    assert.equal(pideHumano('necesito pastillas de freno'), false);
  });

  await db.close();

  console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} PRUEBA(S) FALLARON\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
