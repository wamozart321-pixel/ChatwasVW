/**
 * Arma el zip de la extensión para pasarla a otro computador.
 *
 *   npm run exportador:empaquetar
 *
 * Queda en `herramientas/salida/`. Adentro va un INSTALAR.txt, porque el zip lo
 * va a abrir alguien que no leyó nada de esto.
 *
 * ---
 *
 * No hay instalador de un clic, y no es por falta de ganas.
 *
 * Chrome y Opera bloquean instalar una extensión desde un archivo: desde 2014
 * sólo aceptan las de su tienda. Un `.crx` suelto no se instala ni arrastrándolo
 * a la ventana. Las salidas son tres:
 *
 *   1. Descomprimir y cargarla a mano, que es esto. Un minuto por computador y
 *      no depende de nadie.
 *   2. Publicarla en la Chrome Web Store. Cuesta 5 dólares una vez y hay que
 *      esperar la revisión de Google, que para una extensión que lee WhatsApp
 *      puede terminar en un rechazo.
 *   3. Forzarla por política de Windows, tocando el registro en cada máquina y
 *      dejando el .crx en un servidor. Es lo que hacen las empresas, y sirve si
 *      esto se va a usar seguido.
 *
 * Para una migración que se hace una vez, la 1 es la razonable. Si hay que
 * repetirlo seguido, la 3 se puede armar.
 */
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } = require('node:fs');
const { join } = require('node:path');

const AQUI = __dirname;
const EXTENSION = join(AQUI, 'extension');
const SALIDA = join(AQUI, 'salida');

const version = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')).version;
const nombre = `whatswv-exportar-${version}`;
const armado = join(SALIDA, nombre);
const zip = join(SALIDA, `${nombre}.zip`);

rmSync(armado, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(SALIDA, { recursive: true });

cpSync(EXTENSION, armado, { recursive: true });

writeFileSync(
  join(armado, 'INSTALAR.txt'),
  [
    'WhatsWV — exportar contactos y chats de WhatsApp',
    '',
    '1. Descomprimir esta carpeta en un sitio donde se pueda quedar.',
    '   Si se borra o se mueve, la extension deja de funcionar.',
    '',
    '2. En Opera abrir  opera://extensions',
    '   En Chrome abrir  chrome://extensions',
    '',
    '3. Activar "Modo de desarrollador", arriba a la derecha.',
    '',
    '4. Pulsar "Cargar extension sin empaquetar" y elegir ESTA carpeta',
    '   (la que tiene el archivo manifest.json).',
    '',
    '5. Abrir web.whatsapp.com. El panel verde sale solo, arriba a la derecha.',
    '',
    'El navegador va a avisar que hay una extension en modo desarrollador.',
    'Es normal: es la unica forma de instalar una extension que no esta en la',
    'tienda de Google.',
    '',
    `Version ${version}`,
  ].join('\r\n'),
);

// Compress-Archive de PowerShell, que ya viene en Windows: no vale la pena una
// dependencia mas para hacer un zip una vez cada tanto.
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${armado}\*' -DestinationPath '${zip}' -Force`],
  { stdio: 'inherit' },
);

rmSync(armado, { recursive: true, force: true });

console.log(`\n  listo: herramientas/salida/${nombre}.zip`);
console.log('  se copia a otro computador y se sigue el INSTALAR.txt de adentro\n');
