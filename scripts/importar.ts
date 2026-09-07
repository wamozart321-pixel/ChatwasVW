/**
 * Trae a la bandeja los clientes y los chats que están en el celular.
 *
 *   npm run importar -- contactos clientes.csv
 *   npm run importar -- mensajes chats.json
 *   npm run importar -- chats carpeta-de-exportaciones/ --yo "Repuestos VW"
 *
 * Sin `--de-verdad` sólo dice qué haría. Es a propósito: un archivo mal armado
 * puede meter cientos de contactos basura en la bandeja de trabajo, y sacarlos
 * después es peor que revisarlos antes.
 *
 * Con `--produccion` corre contra el servidor; sin eso, contra la base que diga
 * el .env, que es la de desarrollo.
 *
 * ---
 *
 * CONTACTOS: un CSV con el teléfono y el nombre.
 *
 * Si trae encabezado, las columnas se buscan por nombre, así que sirve tal cual
 * sale de una herramienta de exportación aunque traiga trece columnas:
 *
 *   country_code,country_name,phone_number,...,saved_name,public_name,...
 *   +57,Colombia,+573248559947,...,F Por Siempre,...
 *
 * Sin encabezado se toman las dos primeras columnas, teléfono y nombre.
 *
 * MENSAJES: el .json que suelta `herramientas/exportar-whatsapp.js`, que es lo
 * que se corre en WhatsApp Web para sacar los chats sin pagar una extensión.
 *
 * CHATS: la exportación del propio WhatsApp, un `.txt` por conversación.
 * En el celular: abrir el chat -> ⋮ -> Más -> Exportar chat -> Sin archivos.
 *
 *   4/9/26, 10:32 a. m. - Chris: tienen el alternador del Gol?
 *   4/9/26, 10:35 a. m. - Repuestos VW: si, lo tenemos
 *
 * `--yo` dice cuál de los dos nombres es el negocio, para saber qué mensaje
 * salió y cuál entró. El nombre del archivo tiene que traer el teléfono del
 * cliente, que es como WhatsApp los exporta cuando el contacto no está en la
 * agenda; si no, se pasa con `--telefono`.
 *
 * Lo que se importa queda marcado como importado y NO reabre la ventana de
 * 24 h: son mensajes viejos, y WhatsApp cuenta el tiempo desde que el cliente
 * escribe de verdad. Sirve para consultar el historial, no para responderlo.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Pool } from 'pg';
import { configPostgres } from '../src/db/conexion';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const argv = process.argv.slice(2);
const modo = argv[0];
const ruta = argv[1];
const deVerdad = argv.includes('--de-verdad');

function opcion(nombre: string): string | undefined {
  const i = argv.indexOf(`--${nombre}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Igual que en la bandeja: 10 dígitos es un celular colombiano sin indicativo. */
function aE164(valor: string): string {
  const digitos = valor.replace(/\D/g, '').replace(/^00/, '');
  if (!digitos) return '';
  if (digitos.length === 10 && digitos.startsWith('3')) return '57' + digitos;
  return digitos;
}

function urlDeLaBase(): string | undefined {
  if (!argv.includes('--produccion')) return process.env.DATABASE_URL;

  const respaldo = '.env.respaldo-produccion';
  try {
    const linea = readFileSync(respaldo, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='));
    return linea?.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
  } catch {
    console.error(`falta ${respaldo}, que es de donde se saca la cadena de produccion`);
    return undefined;
  }
}

const url = urlDeLaBase();
if (!url) process.exit(1);
const pool = new Pool(configPostgres(url, 3));

// --- contactos ---------------------------------------------------------------

interface Cliente {
  telefono: string;
  nombre: string | null;
}

/**
 * Parte una línea de CSV respetando las comillas.
 *
 * No sirve partir por el separador a secas: un nombre como "Autos, S.A."
 * correría todas las columnas de ahí en adelante y el teléfono terminaría
 * siendo otra cosa. Dentro de comillas, dos comillas seguidas son una comilla.
 */
function partirLinea(linea: string, separador: string): string[] {
  const celdas: string[] = [];
  let actual = '';
  let entreComillas = false;

  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];

    if (entreComillas) {
      if (c === '"') {
        if (linea[i + 1] === '"') {
          actual += '"';
          i++;
        } else {
          entreComillas = false;
        }
      } else {
        actual += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === separador) {
      celdas.push(actual.trim());
      actual = '';
    } else {
      actual += c;
    }
  }

  celdas.push(actual.trim());
  return celdas;
}

/**
 * En qué columna está cada cosa.
 *
 * Por nombre y no por posición: la exportación de una herramienta cualquiera
 * trae una docena de columnas y el teléfono no es la primera. Van en orden de
 * preferencia — `saved_name` es como lo tiene guardado el negocio, y es mejor
 * nombre que el `public_name`, que lo elige el propio cliente.
 *
 * `country_name` queda fuera a propósito: contiene "name", y si no se descarta
 * todos los contactos terminarían llamándose "Colombia".
 */
const COLUMNA_TELEFONO = [
  'phone_number',
  'telefono',
  'numero',
  'celular',
  'movil',
  'wa_id',
  'formatted_phone',
  'phone',
];

const COLUMNA_NOMBRE = [
  'saved_name',
  'nombre',
  'public_name',
  'display_name',
  'formatted_name',
  'name',
];

function columnas(encabezado: string[]): { telefono: number; nombre: number } | null {
  const limpio = encabezado.map((c) => c.toLowerCase().trim());

  const buscar = (candidatos: string[], excluir: string[]) => {
    for (const candidato of candidatos) {
      const i = limpio.findIndex((c) => c === candidato);
      if (i >= 0) return i;
    }
    for (const candidato of candidatos) {
      const i = limpio.findIndex(
        (c) => c.includes(candidato) && !excluir.some((e) => c.includes(e)),
      );
      if (i >= 0) return i;
    }
    return -1;
  };

  const telefono = buscar(COLUMNA_TELEFONO, ['country']);
  if (telefono < 0) return null;

  return { telefono, nombre: buscar(COLUMNA_NOMBRE, ['country', 'file']) };
}

function leerCsv(archivo: string): Cliente[] {
  // El caracter invisible del principio es la marca que Excel y las
  // extensiones ponen al abrir el archivo; sin quitarla, la primera columna del
  // encabezado nunca coincide con nada.
  const texto = readFileSync(archivo, 'utf8').replace(/^\ufeff/, '');
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length === 0) return [];

  const primera = lineas[0]!;
  // Punto y coma es lo que sale de un Excel en español.
  const separador =
    (primera.match(/;/g)?.length ?? 0) > (primera.match(/,/g)?.length ?? 0) ? ';' : ',';

  const donde = columnas(partirLinea(primera, separador)) ?? { telefono: 0, nombre: 1 };
  const clientes: Cliente[] = [];

  for (const linea of lineas) {
    const celdas = partirLinea(linea, separador);
    const telefono = aE164(celdas[donde.telefono] ?? '');

    // El encabezado y cualquier fila sin telefono valido se saltan solos: un
    // numero de WhatsApp nunca baja de 8 digitos. Ahi caen tambien las filas
    // que una herramienta tapa para cobrar por verlas.
    if (telefono.length < 8) continue;

    const nombre = donde.nombre >= 0 ? (celdas[donde.nombre] ?? '').trim() : '';

    // Un "nombre" que es el propio numero no es un nombre: asi deja la
    // exportacion a los contactos que no estan en la agenda.
    clientes.push({
      telefono,
      nombre: nombre && aE164(nombre) !== telefono ? nombre : null,
    });
  }

  return clientes;
}

async function importarContactos(archivo: string) {
  const clientes = leerCsv(archivo);
  console.log(`\n  ${clientes.length} contactos en el archivo\n`);

  if (clientes.length === 0) {
    console.log('  ninguna fila tenia un telefono valido. Revisa el formato.\n');
    return;
  }

  const { rows: existentes } = await pool.query<{ wa_id: string }>(
    'SELECT wa_id FROM contacts WHERE wa_id = ANY($1)',
    [clientes.map((c) => c.telefono)],
  );
  const yaEstan = new Set(existentes.map((f) => f.wa_id));

  const nuevos = clientes.filter((c) => !yaEstan.has(c.telefono));

  console.log(`  ya estaban: ${yaEstan.size}`);
  console.log(`  se agregan: ${nuevos.length}\n`);

  for (const c of nuevos.slice(0, 10)) {
    console.log(`     +${c.telefono}  ${c.nombre ?? '(sin nombre)'}`);
  }
  if (nuevos.length > 10) console.log(`     … y ${nuevos.length - 10} mas`);

  if (!deVerdad) {
    console.log('\n  SIMULACRO. Para hacerlo de verdad, agrega --de-verdad\n');
    return;
  }

  for (const c of nuevos) {
    await pool.query(
      `INSERT INTO contacts (wa_id, telefono, nombre) VALUES ($1, $1, $2)
       ON CONFLICT (wa_id) DO NOTHING`,
      [c.telefono, c.nombre],
    );
  }

  console.log(`\n  listo: ${nuevos.length} contactos agregados\n`);
}

// --- guardar un chat ---------------------------------------------------------

interface Mensaje {
  cuando: Date;
  /** Si lo mandó el negocio. Lo demás entró. */
  mio: boolean;
  texto: string;
}

async function guardarChat(telefono: string, nombre: string | null, mensajes: Mensaje[]) {
  const { rows: contacto } = await pool.query<{ id: string }>(
    `INSERT INTO contacts (wa_id, telefono, nombre) VALUES ($1, $1, $2)
     ON CONFLICT (wa_id) DO UPDATE SET nombre = coalesce(contacts.nombre, EXCLUDED.nombre)
     RETURNING id`,
    [telefono, nombre],
  );
  const contactId = contacto[0]!.id;

  /*
   * La conversacion queda resuelta y con la ventana cerrada.
   *
   * Son mensajes viejos: dejarla abierta la pondria arriba en la bandeja como
   * si un cliente estuviera esperando respuesta, y WhatsApp igual no dejaria
   * escribir — la ventana de 24 h la abre un mensaje de verdad, no una fila que
   * pusimos nosotros.
   *
   * Se reusa la que ya haya de ese contacto en vez de crear otra: correr el
   * importador dos veces con el mismo archivo dejaba el historial duplicado en
   * dos conversaciones, y eso alguien lo iba a hacer.
   */
  const { rows: existente } = await pool.query<{ id: string }>(
    'SELECT id FROM conversations WHERE contact_id = $1 ORDER BY created_at LIMIT 1',
    [contactId],
  );

  let conversationId = existente[0]?.id;

  if (!conversationId) {
    const { rows: creada } = await pool.query<{ id: string }>(
      `INSERT INTO conversations (contact_id, estado, unread_count, last_inbound_at)
       VALUES ($1, 'resuelto', 0, $2)
       RETURNING id`,
      [contactId, mensajes.at(-1)?.cuando ?? new Date()],
    );
    conversationId = creada[0]!.id;
  }

  for (const m of mensajes) {
    await pool.query(
      `INSERT INTO messages
         (conversation_id, wa_message_id, direccion, tipo, cuerpo, status, status_rank,
          wa_timestamp, raw)
       VALUES ($1, $2, $3, 'text', $4, 'delivered', 2, $5, $6)
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [
        conversationId,
        // Calculado a partir del mensaje, no al azar: asi correr el importador
        // dos veces con el mismo archivo da los mismos identificadores y el
        // ON CONFLICT lo absorbe, en vez de duplicar el historial. Alguien va a
        // reimportar — porque agrego un chat a la carpeta, o porque no supo si
        // la primera vez funciono.
        'wamid.IMPORTADO' +
          createHash('sha1')
            .update(`${telefono}|${m.cuando.toISOString()}|${m.mio}|${m.texto}`)
            .digest('hex'),
        m.mio ? 'out' : 'in',
        m.texto,
        m.cuando,
        JSON.stringify({ importado: true }),
      ],
    );
  }
}

// --- mensajes: el .json de la herramienta ------------------------------------

interface ChatExportado {
  telefono?: string;
  nombre?: string | null;
  mensajes?: { cuando?: string; mio?: boolean; texto?: string }[];
}

async function importarMensajes(archivo: string) {
  const crudo: unknown = JSON.parse(readFileSync(archivo, 'utf8'));
  const chats: ChatExportado[] = Array.isArray(crudo)
    ? (crudo as ChatExportado[])
    : ((crudo as { chats?: ChatExportado[] }).chats ?? []);

  console.log(`\n  ${chats.length} chats en el archivo\n`);

  let total = 0;

  for (const chat of chats) {
    const telefono = aE164(chat.telefono ?? '');
    if (telefono.length < 8) {
      console.log(`  SALTADO  ${chat.telefono ?? '(sin telefono)'}: no es un numero`);
      continue;
    }

    const mensajes: Mensaje[] = (chat.mensajes ?? [])
      .map((m) => ({
        cuando: new Date(m.cuando ?? ''),
        mio: m.mio === true,
        texto: (m.texto ?? '').trim(),
      }))
      .filter((m) => m.texto && !Number.isNaN(m.cuando.getTime()))
      .sort((a, b) => a.cuando.getTime() - b.cuando.getTime());

    if (mensajes.length === 0) continue;

    const desde = mensajes[0]!.cuando.toLocaleDateString('es');
    const hasta = mensajes.at(-1)!.cuando.toLocaleDateString('es');
    const quien = (chat.nombre ?? '(sin nombre)').padEnd(26).slice(0, 26);
    console.log(`  +${telefono}  ${quien}  ${String(mensajes.length).padStart(4)} msg  ${desde} a ${hasta}`);

    total += mensajes.length;
    if (deVerdad) await guardarChat(telefono, chat.nombre?.trim() || null, mensajes);
  }

  console.log(`\n  ${total} mensajes en total`);
  if (!deVerdad) console.log('\n  SIMULACRO. Para hacerlo de verdad, agrega --de-verdad');
  console.log('');
}

// --- chats: la exportación del propio WhatsApp -------------------------------

interface LineaChat {
  cuando: Date;
  quien: string;
  texto: string;
}

/**
 * Una línea de la exportación de WhatsApp.
 *
 * El formato cambia con el idioma y la región del teléfono: la fecha puede ser
 * d/m/aa o m/d/aa, la hora de 12 o de 24, y el separador un guión normal o uno
 * largo. Por eso la expresión es floja y la fecha se arma a mano en vez de
 * dársela a `new Date`, que interpretaría 4/9 como 9 de abril.
 *
 * Se asume día/mes, que es lo que usa un teléfono en español.
 */
const INICIO_DE_LINEA =
  /^‎?\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?\s?m\.?)?\]?\s*[-–]\s*([^:]+):\s?([\s\S]*)$/i;

function interpretar(linea: string): LineaChat | null {
  const m = INICIO_DE_LINEA.exec(linea);
  if (!m) return null;

  const [, d, mes, anio, hh, mm, meridiano, quien, texto] = m;

  let hora = Number(hh);
  if (meridiano) {
    const esPm = /p/i.test(meridiano);
    if (esPm && hora !== 12) hora += 12;
    if (!esPm && hora === 12) hora = 0;
  }

  const año = Number(anio) < 100 ? 2000 + Number(anio) : Number(anio);
  const cuando = new Date(año, Number(mes) - 1, Number(d), hora, Number(mm));

  if (Number.isNaN(cuando.getTime())) return null;

  return { cuando, quien: quien.trim(), texto: texto.trim() };
}

/** Un chat entero: las líneas sueltas se pegan a la anterior. */
function leerChat(archivo: string): LineaChat[] {
  const lineas = readFileSync(archivo, 'utf8').split(/\r?\n/);
  const mensajes: LineaChat[] = [];

  for (const linea of lineas) {
    const nueva = interpretar(linea);

    if (nueva) {
      mensajes.push(nueva);
    } else if (mensajes.length > 0 && linea.trim()) {
      // Un mensaje de varios renglones: el resto no vuelve a traer la fecha.
      mensajes[mensajes.length - 1]!.texto += '\n' + linea.trim();
    }
  }

  // Lo que WhatsApp mete y no es un mensaje de nadie.
  const RUIDO = [
    /cifrados de extremo a extremo/i,
    /<Multimedia omitido>/i,
    /se eliminó este mensaje/i,
    /^\s*$/,
  ];

  return mensajes.filter((m) => !RUIDO.some((r) => r.test(m.texto)));
}

async function importarChats(carpeta: string, yo: string) {
  const archivos = statSync(carpeta).isDirectory()
    ? readdirSync(carpeta)
        .filter((f) => f.toLowerCase().endsWith('.txt'))
        .map((f) => join(carpeta, f))
    : [carpeta];

  console.log(`\n  ${archivos.length} archivo(s) de chat\n`);

  let totalMensajes = 0;

  for (const archivo of archivos) {
    const lineas = leerChat(archivo);

    // WhatsApp nombra la exportacion con el contacto: si no esta en la agenda,
    // ahi va el telefono.
    const telefono = aE164(opcion('telefono') ?? basename(archivo));

    if (telefono.length < 8) {
      console.log(`  SALTADO  ${basename(archivo)}: no se pudo sacar el telefono del nombre`);
      console.log('           pasalo con --telefono 573001234567\n');
      continue;
    }

    const deEllos = [...new Set(lineas.map((m) => m.quien).filter((q) => q !== yo))];
    console.log(
      `  ${basename(archivo)}  ->  +${telefono}  ${lineas.length} mensajes` +
        (deEllos.length ? `  (cliente: ${deEllos.join(', ')})` : ''),
    );

    if (lineas.length > 0) {
      const desde = lineas[0]!.cuando.toLocaleDateString('es');
      const hasta = lineas.at(-1)!.cuando.toLocaleDateString('es');
      console.log(`     del ${desde} al ${hasta}`);
    }

    totalMensajes += lineas.length;
    if (!deVerdad) continue;

    await guardarChat(
      telefono,
      deEllos[0] ?? null,
      lineas.map((l) => ({ cuando: l.cuando, mio: l.quien === yo, texto: l.texto })),
    );
  }

  console.log(`\n  ${totalMensajes} mensajes en total`);
  if (!deVerdad) console.log('\n  SIMULACRO. Para hacerlo de verdad, agrega --de-verdad');
  console.log('');
}

// --- arranque ----------------------------------------------------------------

async function main() {
  if (!modo || !ruta) {
    console.log(`
  Trae a la bandeja los clientes y chats que estan en el celular.

    npm run importar -- contactos clientes.csv
    npm run importar -- mensajes chats.json
    npm run importar -- chats carpeta/ --yo "Repuestos VW"

  Sin --de-verdad solo dice que haria.
  Con --produccion corre contra el servidor.
`);
    process.exit(1);
  }

  if (modo === 'contactos') {
    await importarContactos(ruta);
  } else if (modo === 'mensajes') {
    await importarMensajes(ruta);
  } else if (modo === 'chats') {
    const yo = opcion('yo');
    if (!yo) {
      console.error('\n  falta --yo "Nombre del negocio en WhatsApp"');
      console.error('  es lo que dice quien mando cada mensaje en la exportacion\n');
      process.exit(1);
    }
    await importarChats(ruta, yo);
  } else {
    console.error(`modo desconocido: ${modo}. Se espera "contactos", "mensajes" o "chats"`);
    process.exit(1);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${(e as Error).message}\n`);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
