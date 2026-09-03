/**
 * Escribe el ícono de la app en los tres sitios donde hace falta.
 *
 *   npm run iconos
 *
 * Todo sale de `recursos/logo.png`. Un solo script porque son el mismo ícono:
 * teniendo uno por destino, cambiar el logo obligaba a acordarse de correr
 * tres cosas y alguna quedaba vieja.
 *
 *   escritorio/recursos/   icono.ico e icono.png, para el instalador de Windows
 *   movil/android/.../res/ las cinco densidades de Android, en dos capas
 *   web/public/            el favicon de la pestaña del navegador
 */
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  decodificarPng,
  redimensionar,
  soloElDibujo,
  sobreColor,
  recuadroDelDibujo,
  conMargen,
  codificarPng,
  codificarIco,
} = require('./imagen');

/** El verde de la bandeja, para que el ícono y la app sean el mismo verde. */
const VERDE = [0x1f, 0x9d, 0x55];
const HEX = '#' + VERDE.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');

const RAIZ = join(__dirname, '..');
const logo = decodificarPng(readFileSync(join(__dirname, 'logo.png')));

/**
 * Los tamaños chicos van recortados al dibujo.
 *
 * Sólo Android recorta el ícono, y para eso necesita el margen. En una pestaña
 * del navegador o en el escritorio nadie lo recorta, así que ese margen es
 * espacio malgastado: a 32 px, recortado se distingue el escarabajo y sin
 * recortar es una mancha.
 */
const recorte = recuadroDelDibujo(logo, 24);
const ajustado = (lado) => sobreColor(soloElDibujo(redimensionar(logo, lado, recorte)), VERDE);

// --- Windows -----------------------------------------------------------------

const LADOS_ICO = [16, 24, 32, 48, 64, 128, 256];
const paraIco = LADOS_ICO.map((lado) => ({ lado, datos: codificarPng(ajustado(lado)) }));

const escritorio = join(RAIZ, 'escritorio', 'recursos');
writeFileSync(join(escritorio, 'icono.png'), paraIco.at(-1).datos);
writeFileSync(join(escritorio, 'icono.ico'), codificarIco(paraIco));

// --- Android -----------------------------------------------------------------

/** Lo que mide el ícono en cada densidad de pantalla. */
const DENSIDADES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

const res = join(RAIZ, 'movil', 'android', 'app', 'src', 'main', 'res');

/**
 * Cuánto del lienzo ocupa el dibujo en el ícono de Android.
 *
 * De un lienzo de 108, el sistema sólo muestra el centro de 72 —el 66%— y lo
 * recorta con la forma del teléfono. El dibujo del logo ya ocupa el 65% del
 * archivo, así que dejándolo tal cual queda TOCANDO el borde del recorte. Al
 * 50% respira en cualquier forma: círculo, cuadrado redondeado o gota.
 */
const OCUPACION_ANDROID = 0.5;

for (const [carpeta, lado] of Object.entries(DENSIDADES)) {
  const capa = conMargen(soloElDibujo(redimensionar(logo, lado * 2, recorte)), lado, OCUPACION_ANDROID);

  // Android 7 y anteriores no saben de capas: esperan una imagen opaca.
  const opaco = codificarPng(sobreColor(capa, VERDE));
  writeFileSync(join(res, carpeta, 'ic_launcher.png'), opaco);
  writeFileSync(join(res, carpeta, 'ic_launcher_round.png'), opaco);

  // De Android 8 en adelante son dos capas y el sistema las recorta juntas con
  // la forma que use el teléfono. La de adelante va con fondo transparente; el
  // verde lo pone el sistema como color.
  writeFileSync(join(res, carpeta, 'ic_launcher_foreground.png'), codificarPng(capa));
}

writeFileSync(
  join(res, 'values', 'ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<resources>\n' +
    `    <color name="ic_launcher_background">${HEX}</color>\n` +
    '</resources>\n',
);

// --- navegador ---------------------------------------------------------------

const publico = join(RAIZ, 'web', 'public');
mkdirSync(publico, { recursive: true });

// El .ico lleva los siete tamaños adentro y el navegador elige el que necesita.
// Importa: los de 16 y 32 están hechos a medida, no reducidos al vuelo desde
// uno grande, que es lo que hace un navegador cuando sólo se le da un PNG.
writeFileSync(join(publico, 'favicon.ico'), codificarIco(paraIco));

// Para «añadir a la pantalla de inicio» en un celular, que pide uno grande.
writeFileSync(join(publico, 'icono-192.png'), codificarPng(ajustado(192)));

console.log(`iconos escritos con fondo ${HEX}:`);
console.log(`  windows   ${LADOS_ICO.join(', ')} px`);
console.log(`  android   ${Object.keys(DENSIDADES).length} densidades, en dos capas`);
console.log('  navegador favicon.ico e icono-192.png');
