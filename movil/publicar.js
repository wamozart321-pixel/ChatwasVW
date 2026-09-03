/**
 * Publica una versión nueva de la app de Android.
 *
 *   npm run publicar            sube la versión que diga package.json
 *   npm run publicar -- 0.2.0   le pone esa versión antes de compilar
 *
 * Sube dos archivos al servidor:
 *
 *   WhatsWV.apk    el instalador
 *   android.json   qué versión es la última; es lo que consulta cada app
 *                  instalada para saber si tiene que actualizarse
 *
 * El .apk conserva el mismo nombre siempre para que el enlace que se le pasa a
 * un asesor nuevo no cambie nunca.
 *
 * A diferencia de Windows, Android NO puede instalar solo: el sistema exige que
 * la persona confirme cada instalación que no venga de Play Store. Lo más lejos
 * que se puede llegar sin publicar en la tienda es avisar y dejar el botón,
 * que es lo que hace la bandeja.
 */
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SERVIDOR = 'root@107.170.72.128';
const DESTINO = '/srv/descargas';
const LLAVE = join(process.env.HOME ?? process.env.USERPROFILE, '.ssh', 'whatswv');
const SALIDA = join(__dirname, 'salida');

const correr = (cmd, args) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: __dirname, shell: true });

// --- version -----------------------------------------------------------------

const rutaPaquete = join(__dirname, 'package.json');
const paquete = JSON.parse(readFileSync(rutaPaquete, 'utf8'));

const pedida = process.argv[2];
if (pedida) {
  if (!/^\d+\.\d+\.\d+$/.test(pedida)) {
    console.error(`version invalida: ${pedida}. Se espera algo como 0.2.0`);
    process.exit(1);
  }
  paquete.version = pedida;
  writeFileSync(rutaPaquete, `${JSON.stringify(paquete, null, 2)}\n`, 'utf8');
  console.log(`==> version ${pedida}`);
}

// --- compilar ----------------------------------------------------------------

console.log(`==> compilando WhatsWV ${paquete.version}`);
correr('node', ['empaquetar.js']);

const apk = join(SALIDA, 'WhatsWV.apk');
if (!existsSync(apk)) {
  console.error('no se genero el .apk en salida/');
  process.exit(1);
}

const datos = readFileSync(apk);

// --- manifiesto --------------------------------------------------------------

/**
 * Lo que la app instalada consulta para saber si hay algo nuevo.
 *
 * Va como archivo estático al lado del .apk y no como endpoint de la API: así
 * lo sirve Caddy sin pasar por el servidor, y sigue estando aunque la bandeja
 * esté caída — que es justo cuando uno querría poder reinstalar.
 */
const manifiesto = {
  version: paquete.version,
  url: 'https://bandeja.chatwasvw.com/instalar/WhatsWV.apk',
  tamano: datos.length,
  sha256: createHash('sha256').update(datos).digest('hex'),
  publicada: new Date().toISOString(),
};

const rutaManifiesto = join(SALIDA, 'android.json');
writeFileSync(rutaManifiesto, `${JSON.stringify(manifiesto, null, 2)}\n`);

// --- subir -------------------------------------------------------------------

console.log('==> subiendo al servidor');
const subir = (origen, nombre) =>
  correr('scp', [
    '-i', `"${LLAVE}"`,
    '-o', 'StrictHostKeyChecking=no',
    `"${origen}"`,
    `${SERVIDOR}:${DESTINO}/${nombre}`,
  ]);

subir(apk, 'WhatsWV.apk');
subir(rutaManifiesto, 'android.json');

correr('ssh', [
  '-i', `"${LLAVE}"`,
  '-o', 'StrictHostKeyChecking=no',
  SERVIDOR,
  `"chmod 644 ${DESTINO}/* && ls -lh ${DESTINO}"`,
]);

console.log(`
publicada la ${paquete.version}.

Las apps instaladas la ven al abrirse y cada 4 horas, y avisan con un botón.
Android obliga a que el asesor confirme la instalación: no hay forma de
instalar en silencio sin publicar en Play Store.

Enlace para instalaciones nuevas:
  ${manifiesto.url}
`);
