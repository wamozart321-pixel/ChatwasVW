/**
 * Prueba del bot automático, contra el servidor levantado.
 *   npm start           (en otra terminal)
 *   npm run test:bot
 *
 * Se verifica el estado en la base y no los mensajes salientes: con el número
 * de prueba de Meta los envíos fallan por la lista blanca, pero el flujo tiene
 * que avanzar igual — si el bot se trabara cuando no puede responder, una caída
 * de Meta dejaría a todos los clientes colgados a mitad del menú.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const telAleatorio = () =>
  '57' + String(Date.now()).slice(-8) + String(Math.floor(10 + Math.random() * 90));

/** Manda un entrante firmado. `botonId` simula que tocó un botón. */
async function entrante(telefono: string, texto: string, botonId?: string) {
  const mensaje: Record<string, unknown> = {
    from: telefono,
    id: `wamid.SIMBOT${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: botonId ? 'interactive' : 'text',
  };

  if (botonId) {
    mensaje.interactive = { type: 'button_reply', button_reply: { id: botonId, title: texto } };
  } else {
    mensaje.text = { body: texto };
  }

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
              contacts: [{ profile: { name: 'Cliente Bot' }, wa_id: telefono }],
              messages: [mensaje],
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

interface EstadoBot {
  id: string;
  bot_paso: string | null;
  bot_datos: Record<string, string>;
  bot_intentos: number;
  assigned_to: string | null;
}

/** Espera a que el worker procese y devuelve el estado del bot. */
async function esperarPaso(
  telefono: string,
  esperado: string | null,
  ms = 8000,
): Promise<EstadoBot> {
  const hasta = Date.now() + ms;
  let ultimo: EstadoBot | null = null;

  while (Date.now() < hasta) {
    const { rows } = await pool.query<EstadoBot>(
      `SELECT c.id, c.bot_paso, c.bot_datos, c.bot_intentos, c.assigned_to
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE ct.wa_id = $1 AND c.estado <> 'resuelto'
        ORDER BY c.last_message_at DESC LIMIT 1`,
      [telefono],
    );

    ultimo = rows[0] ?? null;
    if (ultimo && ultimo.bot_paso === esperado) return ultimo;
    await dormir(250);
  }

  throw new Error(
    `el bot quedó en "${ultimo?.bot_paso ?? 'sin conversación'}" y se esperaba "${esperado}"`,
  );
}

/** Paso y dueno actuales de una conversacion. */
async function estadoDelBot(conversationId: string) {
  const { rows } = await pool.query<{ bot_paso: string | null; assigned_to: string | null }>(
    `SELECT bot_paso, assigned_to FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return rows[0];
}

/** Repite `fn` hasta que devuelva true o se acabe el tiempo. */
async function esperarHasta(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if (await fn()) return true;
    await dormir(2000);
  }
  return false;
}

async function main() {
  exigirEntornoSeguro();

  try {
    await fetch(`${BASE}/webhooks/whatsapp?hub.mode=x`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error(`\n  El servidor no responde en ${BASE}. Levantalo con: npm start\n`);
    process.exit(1);
  }

  console.log('\nflujo completo\n');

  await prueba('el primer mensaje dispara el saludo y abre el menú', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'buenas, necesito algo');

    const estado = await esperarPaso(tel, 'menu');
    assert.equal(estado.assigned_to, null, 'se asignó a un asesor estando el bot a cargo');
  });

  await prueba('elegir «cotizar» pide el vehículo', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'hola');
    await esperarPaso(tel, 'menu');

    await entrante(tel, 'Cotizar repuesto', 'cotizar');
    const estado = await esperarPaso(tel, 'vehiculo');
    assert.equal(estado.bot_datos.motivo, 'Cotizar un repuesto');
  });

  await prueba('recolecta vehículo y repuesto, y entrega a un humano', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'hola');
    await esperarPaso(tel, 'menu');

    await entrante(tel, 'cotizar', 'cotizar');
    await esperarPaso(tel, 'vehiculo');

    await entrante(tel, 'Golf 2015 1.4 TSI');
    const conRepuesto = await esperarPaso(tel, 'repuesto');
    assert.equal(conRepuesto.bot_datos.vehiculo, 'Golf 2015 1.4 TSI');

    await entrante(tel, 'pastillas de freno');
    const final = await esperarPaso(tel, null);

    assert.equal(final.bot_datos.repuesto, 'pastillas de freno');

    // La nota es lo que el asesor ve antes de abrir el chat.
    const { rows } = await pool.query<{ cuerpo: string; user_id: string | null }>(
      `SELECT cuerpo, user_id FROM notes WHERE conversation_id = $1`,
      [final.id],
    );

    assert.equal(rows.length, 1, 'no dejó la nota con lo recolectado');
    assert.match(rows[0].cuerpo, /Golf 2015/, 'la nota no trae el vehículo');
    assert.match(rows[0].cuerpo, /pastillas de freno/, 'la nota no trae el repuesto');
    assert.equal(rows[0].user_id, null, 'la nota del bot figura escrita por una persona');
  });

  await prueba('el vehículo queda guardado en el contacto para la próxima', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'hola');
    await esperarPaso(tel, 'menu');
    await entrante(tel, 'cotizar', 'cotizar');
    await esperarPaso(tel, 'vehiculo');
    await entrante(tel, 'Jetta 2018');
    await esperarPaso(tel, 'repuesto');

    const { rows } = await pool.query<{ atributos: Record<string, string> }>(
      `SELECT atributos FROM contacts WHERE wa_id = $1`,
      [tel],
    );
    assert.equal(rows[0].atributos.vehiculo, 'Jetta 2018', 'no lo guardó en el contacto');
  });

  console.log('\nsalidas de emergencia\n');

  await prueba('pedir un asesor corta el flujo donde esté', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'hola');
    await esperarPaso(tel, 'menu');
    await entrante(tel, 'cotizar', 'cotizar');
    await esperarPaso(tel, 'vehiculo');

    // A mitad del flujo. Nadie tiene que quedar atrapado en el menú.
    await entrante(tel, 'mejor quiero hablar con un asesor');
    const estado = await esperarPaso(tel, null);
    assert.equal(estado.bot_paso, null, 'el bot siguió a cargo');
  });

  await prueba('tras dos veces sin entender, pasa a un humano', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'hola');
    await esperarPaso(tel, 'menu');

    await entrante(tel, 'xyzzy');
    await dormir(1200);
    await entrante(tel, 'qwerty');
    await dormir(1200);
    await entrante(tel, 'asdfgh');

    const estado = await esperarPaso(tel, null);
    assert.equal(estado.bot_paso, null, 'siguió insistiendo con el menú');
  });

  await prueba('si un humano ya la tiene, el bot no se mete', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'hola');
    const estado = await esperarPaso(tel, 'menu');

    // Un asesor la toma a mitad del flujo.
    await pool.query(
      `UPDATE conversations SET assigned_to = (SELECT id FROM users WHERE email = $2),
                                bot_paso = 'menu'
        WHERE id = $1`,
      [estado.id, 'andres@repuestos.com'],
    );

    const { rows: antes } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direccion = 'out'`,
      [estado.id],
    );

    await entrante(tel, 'cotizar', 'cotizar');
    await dormir(2000);

    const { rows: despues } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direccion = 'out'`,
      [estado.id],
    );

    assert.equal(
      despues[0].n,
      antes[0].n,
      'el bot respondió encima de una conversación que atendía una persona',
    );
  });

  console.log('\nmétricas\n');

  await prueba('una respuesta del bot no cuenta como atendida', async () => {
    const tel = telAleatorio();
    await entrante(tel, 'hola');
    const estado = await esperarPaso(tel, 'menu');

    // El bot ya contestó. Si eso contara como respuesta, «sin responder»
    // quedaría en cero para siempre y taparía que ninguna persona atendió.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages
        WHERE conversation_id = $1 AND direccion = 'out' AND sent_by_user_id IS NULL`,
      [estado.id],
    );
    assert.ok(rows[0].n > 0, 'el bot no dejó ningún mensaje');

    const { rows: sinResponder } = await pool.query<{ n: number }>(
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
      [estado.id],
    );
    assert.equal(sinResponder[0].n, 1, 'el bot la sacó de «sin responder»');
  });

  console.log('\nnadie se queda en el limbo');

  await prueba('lo que queda a mitad del flujo termina con un asesor', async () => {
    // El caso real: el cliente contesta dos preguntas y se distrae, o el
    // webhook de su respuesta llega tarde. Mientras el bot "atiende", la
    // conversacion no esta asignada a nadie NI aparece en la cola, asi que
    // nadie se entera de que hay alguien esperando.
    const tel = telAleatorio();

    await entrante(tel, 'Buenas tardes');
    const conv = (await esperarPaso(tel, 'menu')).id;

    await entrante(tel, '1'); // cotizar
    await esperarPaso(tel, 'vehiculo');
    await entrante(tel, 'Jetta 2009');
    await esperarPaso(tel, 'repuesto');

    const antes = await estadoDelBot(conv);
    assert.ok(antes.bot_paso, 'la prueba no sirve: el bot ya habia soltado la conversacion');
    assert.equal(antes.assigned_to, null, 'se asigno sola, no mide el limbo');

    // Se envejece a mano en vez de esperar los minutos de verdad.
    await pool.query(
      `UPDATE conversations SET updated_at = clock_timestamp() - interval '2 hours' WHERE id = $1`,
      [conv],
    );

    const salio = await esperarHasta(async () => !(await estadoDelBot(conv)).bot_paso, 90_000);
    assert.ok(salio, 'la conversacion quedo trabada a mitad del flujo');

    // Y con la nota de lo que alcanzo a averiguar: el asesor no puede tener
    // que leer todo el hilo para enterarse de que ya le preguntaron el auto.
    const { rows } = await pool.query(
      `SELECT cuerpo FROM notes WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [conv],
    );
    assert.ok(rows[0], 'no dejo ninguna nota');
    assert.match(rows[0].cuerpo, /Jetta 2009/, 'la nota no trae lo que el bot averiguo');
  });

  await prueba('si un asesor la toma, el bot cierra y deja la nota', async () => {
    const tel = telAleatorio();

    await entrante(tel, 'Buenas');
    const conv = (await esperarPaso(tel, 'menu')).id;
    await entrante(tel, '1');
    await esperarPaso(tel, 'vehiculo');

    assert.ok((await estadoDelBot(conv)).bot_paso, 'el bot no quedo a mitad del flujo');

    // La toma un asesor mientras el bot todavia preguntaba.
    await pool.query(
      `UPDATE conversations SET assigned_to = (SELECT id FROM users WHERE email = 'andres@repuestos.com'),
              assigned_at = clock_timestamp() WHERE id = $1`,
      [conv],
    );

    const cerro = await esperarHasta(async () => !(await estadoDelBot(conv)).bot_paso, 90_000);
    assert.ok(cerro, 'el flujo del bot quedo abierto con la conversacion ya tomada');

    const { rows } = await pool.query(
      `SELECT cuerpo FROM notes WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [conv],
    );
    assert.match(rows[0].cuerpo, /asesor tomó/, 'la nota no dice por que se cerro');
  });

  console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} PRUEBA(S) FALLARON\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
