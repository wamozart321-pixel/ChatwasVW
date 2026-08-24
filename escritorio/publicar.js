/**
 * Publica una version nueva de la app de escritorio.
 *
 *   npm run publicar            sube la version que diga package.json
 *   npm run publicar -- 0.2.0   le pone esa version antes de compilar
 *
 * Compila el instalador y sube al servidor los tres archivos que necesita el
 * actualizador:
 *
 *   WhatsWV-Setup.exe   el instalador
 *   latest.yml          version y hash: es lo que consulta cada app instalada
 *   *.blockmap          permite bajar solo lo que cambio, no los 100 MB enteros
 *
 * El .exe conserva el mismo nombre siempre para que el enlace que se le pasa a
 * un asesor nuevo no cambie nunca. El latest.yml se reescribe apuntando a ese
 * nombre, porque electron-builder lo genera con la version adentro.
 */
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const SERVIDOR = 'root@107.170.72.128';
const DESTINO = '/srv/descargas';
const LLAVE = join(process.env.HOME ?? process.env.USERPROFILE, '.ssh', 'whatswv');
const SALIDA = join(__dirname, 'salida');

const correr = (cmd, args, opciones = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: __dirname, shell: true, ...opciones });

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

console.log(`==> compilando WhatsWV ${paquete.version}`);
correr('npx', ['electron-builder', '--win', '--publish', 'never']);

// --- archivos a subir --------------------------------------------------------

const instalador = readdirSync(SALIDA).find((f) => f.endsWith('.exe') && !f.includes('uninstaller'));
if (!instalador) {
  console.error('no se genero ningun instalador en salida/');
  process.exit(1);
}

const rutaYml = join(SALIDA, 'latest.yml');
if (!existsSync(rutaYml)) {
  console.error(
    'falta salida/latest.yml: revisa que package.json tenga la seccion "publish" en "build"',
  );
  process.exit(1);
}

// electron-builder escribe el nombre con la version adentro. Se reemplaza por
// el nombre fijo para que el enlace de descarga no cambie en cada version.
const NOMBRE_FIJO = 'WhatsWV-Setup.exe';
const yml = readFileSync(rutaYml, 'utf8').split(instalador).join(NOMBRE_FIJO);
writeFileSync(rutaYml, yml, 'utf8');

const blockmap = readdirSync(SALIDA).find((f) => f.endsWith('.exe.blockmap'));

console.log('==> subiendo al servidor');
correr('scp', [
  '-i', `"${LLAVE}"`,
  '-o', 'StrictHostKeyChecking=no',
  `"${join(SALIDA, instalador)}"`,
  `${SERVIDOR}:${DESTINO}/${NOMBRE_FIJO}`,
]);
correr('scp', [
  '-i', `"${LLAVE}"`,
  '-o', 'StrictHostKeyChecking=no',
  `"${rutaYml}"`,
  `${SERVIDOR}:${DESTINO}/latest.yml`,
]);
if (blockmap) {
  correr('scp', [
    '-i', `"${LLAVE}"`,
    '-o', 'StrictHostKeyChecking=no',
    `"${join(SALIDA, blockmap)}"`,
    `${SERVIDOR}:${DESTINO}/${NOMBRE_FIJO}.blockmap`,
  ]);
}

correr('ssh', [
  '-i', `"${LLAVE}"`,
  '-o', 'StrictHostKeyChecking=no',
  SERVIDOR,
  `"chmod 644 ${DESTINO}/* && ls -lh ${DESTINO}"`,
]);

console.log(`
publicada la ${paquete.version}.

Las apps instaladas la van a ver en menos de 4 horas, o al reabrirlas.
Se instala sola cuando el asesor cierra la app.

Enlace para instalaciones nuevas:
  https://bandeja.chatwasvw.com/instalar/${NOMBRE_FIJO}
`);
