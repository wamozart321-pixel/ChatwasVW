/**
 * Simula webhooks de Meta contra el servidor local, firmados igual que los de verdad.
 *
 *   npm run simular -- demo                          carga conversaciones de ejemplo
 *   npm run simular -- limpiar                       borra TODO lo simulado
 *   npm run simular -- entrante 573001112233 "hola"  un mensaje entrante
 *   npm run simular -- media 573001112233               una foto entrante
 *   npm run simular -- estado wamid.XXX read         un cambio de estado
 *
 * No es un atajo que saltea codigo: el payload entra por POST /webhooks/whatsapp
 * y recorre firma -> cola -> worker -> base, exactamente como uno real. Lo unico
 * que no toca es la red de Meta.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { configPostgres } from '../src/db/conexion';
import { esBaseDeProduccion } from './es-produccion';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const PUERTO = process.env.PORT ?? '3000';
const BASE = `http://localhost:${PUERTO}`;
const SECRETO = process.env.META_APP_SECRET ?? '';
const WABA = process.env.META_WABA_ID ?? '0';
const PHONE = process.env.META_PHONE_NUMBER_ID ?? '0';

if (!SECRETO) {
  console.error('falta META_APP_SECRET en el .env');
  process.exit(1);
}

/**
 * Corta temprano y con un mensaje entendible si el servidor no esta arriba.
 * Sin esto, node escupe un AggregateError de ECONNREFUSED que no le dice nada
 * a nadie sobre cual es el problema real.
 */
async function exigirServidor(): Promise<void> {
  try {
    await fetch(`${BASE}/webhooks/whatsapp?hub.mode=x`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error(
      [
        '',
        `  El servidor no responde en ${BASE}.`,
        '',
        '  Tiene que estar corriendo en OTRA terminal. Abri una nueva y ejecuta:',
        '',
        '      npm start',
        '',
        '  Esa terminal queda ocupada mostrando el log: es lo normal, un servidor',
        '  no termina. NO le des Ctrl+C. Volve a esta terminal y repeti el comando.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/** Firma y envia. El cuerpo se serializa UNA vez: la firma cubre esos bytes exactos. */
async function enviarWebhook(payload: unknown): Promise<void> {
  const cuerpo = JSON.stringify(payload);
  const firma = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpo).digest('hex');

  const r = await fetch(`${BASE}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma },
    body: cuerpo,
  });

  if (!r.ok) {
    console.error(`el webhook respondio ${r.status}: ${await r.text()}`);
    process.exit(1);
  }
}

const sobre = (value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field: 'messages', value }] }],
});

const epoch = (d = new Date()) => String(Math.floor(d.getTime() / 1000));

let contador = 0;
const idMensaje = () =>
  `wamid.SIM${Date.now().toString(36).toUpperCase()}${(contador++).toString().padStart(3, '0')}`;

async function entrante(telefono: string, texto: string, nombre?: string, cuando = new Date()) {
  const id = idMensaje();
  await enviarWebhook(
    sobre({
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '+1 555-674-8683', phone_number_id: PHONE },
      contacts: [{ profile: { name: nombre ?? `Cliente ${telefono.slice(-4)}` }, wa_id: telefono }],
      messages: [
        {
          from: telefono,
          id,
          timestamp: epoch(cuando),
          type: 'text',
          text: { body: texto },
        },
      ],
    }),
  );
  return id;
}

async function estado(waMessageId: string, status: string, telefono = '573001112233') {
  await enviarWebhook(
    sobre({
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '+1 555-674-8683', phone_number_id: PHONE },
      statuses: [
        { id: waMessageId, status, timestamp: epoch(), recipient_id: telefono },
      ],
    }),
  );
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Conversaciones de ejemplo, con el tono real de un negocio de repuestos. */
async function demo() {
  const guiones: { tel: string; nombre: string; mensajes: string[] }[] = [
    {
      tel: '573001112233',
      nombre: 'Carlos Ramirez',
      mensajes: [
        'Buenas, tienen pastillas de freno para Golf 2015?',
        'Es el 1.4 TSI',
        'Cuanto me sale con instalacion?',
      ],
    },
    {
      tel: '573014445566',
      nombre: 'Andrea Molina',
      mensajes: [
        'Hola! Necesito un espejo retrovisor derecho para Jetta',
        'Modelo 2018',
      ],
    },
    {
      tel: '573027778899',
      nombre: 'Jhon Vasquez',
      mensajes: ['Buenos dias, hacen envios a Medellin?'],
    },
    {
      tel: '573112223344',
      nombre: 'Luisa Fernanda',
      mensajes: [
        'Buenas tardes',
        'Me pasaron su numero, necesito un kit de embrague para Tiguan',
        'Es urgente, el carro esta varado',
      ],
    },
    {
      tel: '573155556677',
      nombre: 'Miguel Torres',
      mensajes: ['Tienen amortiguadores para Passat 2016?'],
    },
    {
      tel: '573188889900',
      nombre: 'Sandra Pena',
      mensajes: [
        'Hola, ayer pregunte por unos bujes',
        'Ya los consiguieron?',
      ],
    },
  ];

  console.log('cargando conversaciones de ejemplo...\n');

  // Se reparten hacia atras en el tiempo para que la lista quede ordenada
  // de forma realista, no todas en el mismo segundo.
  let minutosAtras = guiones.length * 25;

  for (const g of guiones) {
    for (const texto of g.mensajes) {
      const cuando = new Date(Date.now() - minutosAtras * 60_000);
      await entrante(g.tel, texto, g.nombre, cuando);
      minutosAtras = Math.max(1, minutosAtras - 3);
      await dormir(120);
    }
    console.log(`  ${g.nombre.padEnd(18)} ${g.mensajes.length} mensaje(s)`);
    minutosAtras = Math.max(1, minutosAtras - 8);
  }

  console.log('\nlisto. Abri la bandeja para verlas.');
}

/**
 * Borra unicamente lo simulado: los wa_message_id propios llevan prefijo SIM/RT/DUP,
 * asi que los mensajes reales de Meta nunca se tocan.
 *
 * Los prefijos no llevan '_' a proposito: en LIKE de SQL el guion bajo es un
 * comodin de un caracter, y un patron como 'wamid.DUP_RT%' no hace lo que parece.
 */
async function limpiar() {
  const pool = new Pool(configPostgres(process.env.DATABASE_URL ?? '', 2));
  try {
    const { rows } = await pool.query(`
      WITH simuladas AS (
        SELECT DISTINCT c.id
          FROM conversations c
          JOIN messages m ON m.conversation_id = c.id
         WHERE m.wa_message_id LIKE 'wamid.SIM%'
            OR m.wa_message_id LIKE 'wamid.RT%'
            OR m.wa_message_id LIKE 'wamid.DUP%'
      ),
      -- Solo se borran las conversaciones donde TODO es simulado.
      seguras AS (
        SELECT s.id FROM simuladas s
         WHERE NOT EXISTS (
           SELECT 1 FROM messages m
            WHERE m.conversation_id = s.id
              AND m.wa_message_id IS NOT NULL
              AND m.wa_message_id NOT LIKE 'wamid.SIM%'
              AND m.wa_message_id NOT LIKE 'wamid.RT%'
              AND m.wa_message_id NOT LIKE 'wamid.DUP%'
         )
      ),
      borradas AS (
        DELETE FROM conversations WHERE id IN (SELECT id FROM seguras) RETURNING contact_id
      )
      SELECT count(*)::int AS n FROM borradas
    `);

    // Contactos que quedaron sin ninguna conversacion.
    const huerfanos = await pool.query(`
      DELETE FROM contacts ct
       WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = ct.id)
      RETURNING id
    `);

    // Etiquetas que quedaron sin usar. Las pruebas crean varias con nombre
    // aleatorio y sin esto se acumulan hasta tapar la barra lateral.
    const etiquetas = await pool.query(
      `DELETE FROM tags t
        WHERE NOT EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.tag_id = t.id)
       RETURNING id`,
    );

    console.log(
      `borradas ${rows[0].n} conversaciones simuladas, ${huerfanos.rowCount} contactos ` +
        `y ${etiquetas.rowCount} etiquetas sin usar`,
    );
    console.log('los mensajes reales de Meta quedaron intactos');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** CRC32, que es lo que exige cada chunk del formato PNG. */
function crc32(datos: Buffer): number {
  let c = ~0;
  for (const byte of datos) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo: string, datos: Buffer): Buffer {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);

  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));

  return Buffer.concat([largo, cuerpo, crc]);
}

/**
 * PNG con degradado, generado a mano.
 *
 * Se genera en vez de incrustar un base64 porque una imagen de verdad tiene que
 * tener tamanno real: con una de 8x8 la interfaz "funciona" pero no se ve nada,
 * y una prueba visual que no se ve no prueba nada.
 */
function pngDePrueba(ancho: number, alto: number): Buffer {
  const crudo = Buffer.alloc(alto * (1 + ancho * 3));
  let i = 0;

  for (let y = 0; y < alto; y++) {
    crudo[i++] = 0; // filtro: ninguno
    for (let x = 0; x < ancho; x++) {
      crudo[i++] = Math.round(30 + (x / ancho) * 60); // R
      crudo[i++] = Math.round(120 + (y / alto) * 80); // G
      crudo[i++] = Math.round(90 + (x / ancho) * 40); // B
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // color: RGB
  // 10..12 quedan en 0: compresion, filtro e interlazado estandar

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(crudo)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Inserta una foto entrante directamente en la base y el almacen.
 *
 * A diferencia del resto, este comando NO pasa por el webhook: un media_id
 * inventado haria que la descarga contra Meta fallara. Sirve para ver como se
 * comporta la interfaz con imagenes, no para probar el camino de entrada.
 */
async function media(telefono: string) {
  await exigirServidor();
  await entrante(telefono, 'te mando la foto del repuesto');

  const pool = new Pool(configPostgres(process.env.DATABASE_URL ?? '', 2));
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT c.id FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
        WHERE ct.wa_id = $1 AND c.estado <> 'resuelto'
        ORDER BY c.last_message_at DESC LIMIT 1`,
      [telefono],
    );

    if (!rows.length) {
      console.error('no aparecio la conversacion; probá de nuevo');
      process.exit(1);
    }

    const png = pngDePrueba(480, 360);

    const relativa = join(
      String(new Date().getUTCFullYear()),
      String(new Date().getUTCMonth() + 1).padStart(2, '0'),
      `${randomUUID()}.png`,
    );
    const absoluta = join(process.env.ALMACEN_DIR ?? './almacen', relativa);

    await mkdir(dirname(absoluta), { recursive: true });
    await writeFile(absoluta, png);

    await pool.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direccion, tipo, cuerpo,
                             media_mime, media_url, media_nombre, media_tamano,
                             status, status_rank, wa_timestamp)
       VALUES ($1, $2, 'in', 'image', 'foto del repuesto',
               'image/png', $3, 'repuesto.png', $4, 'delivered', 2, now())`,
      [rows[0].id, `wamid.SIMIMG${Date.now().toString(36)}`, relativa.split(/[\/]/).join('/'), png.length],
    );

    console.log(`foto agregada a la conversacion de ${telefono}`);
    console.log('(abri la bandeja: deberia verse la imagen en el hilo)');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main() {
  // Simula conversaciones falsas, y "limpiar" borra todo lo simulado. Ninguna de
  // las dos tiene nada que hacer en la base de verdad.
  if (esBaseDeProduccion(process.env.DATABASE_URL) && process.env.PRUEBAS_EN_PRODUCCION !== 'si') {
    console.error(
      '\n  El .env apunta a la base de PRODUCCIÓN: simular escribe conversaciones falsas' +
        '\n  y "limpiar" vacía la bandeja. No se corre acá.\n',
    );
    process.exit(1);
  }

  const [comando, ...args] = process.argv.slice(2);

  switch (comando) {
    case 'demo':
      await exigirServidor();
      await demo();
      break;

    case 'limpiar':
      await limpiar();
      break;

    case 'media': {
      const [tel] = args;
      if (!tel) {
        console.error('uso: npm run simular -- media <telefono>');
        process.exit(1);
      }
      await media(tel);
      break;
    }

    case 'entrante': {
      const [tel, ...resto] = args;
      if (!tel || !resto.length) {
        console.error('uso: npm run simular -- entrante <telefono> "<texto>"');
        process.exit(1);
      }
      await exigirServidor();
      const id = await entrante(tel, resto.join(' '));
      console.log(`entrante simulado: ${id}`);
      break;
    }

    case 'estado': {
      const [id, st] = args;
      if (!id || !st) {
        console.error('uso: npm run simular -- estado <wamid> <sent|delivered|read|failed>');
        process.exit(1);
      }
      await exigirServidor();
      await estado(id, st);
      console.log(`estado '${st}' enviado para ${id}`);
      break;
    }

    default:
      console.log(
        'comandos: demo | limpiar | media <tel> | entrante <tel> "<texto>" | estado <wamid> <status>',
      );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
