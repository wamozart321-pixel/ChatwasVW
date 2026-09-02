/**
 * Escribe el icono de la app en las densidades que pide Android.
 *
 *   node generar-iconos.js
 *
 * Reusa el dibujo de la app de escritorio para que las dos se vean iguales: es
 * la misma app, y un icono distinto en cada una confunde mas de lo que ayuda.
 */
const { execFileSync } = require('node:child_process');
const { writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const DIBUJO = join(__dirname, '..', 'escritorio', 'recursos', 'generar-icono.js');

/** Lo que mide el icono en cada densidad de pantalla. */
const DENSIDADES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

/**
 * El generador de escritorio escribe archivos, no exporta funciones. En vez de
 * duplicar el dibujo, se le pide el PNG grande y se recorta de ahi: el codigo
 * del icono vive en un solo lugar.
 */
function fuente() {
  const png = join(__dirname, '..', 'escritorio', 'recursos', 'icono.png');
  if (!existsSync(png)) {
    execFileSync(process.execPath, [DIBUJO], { stdio: 'inherit' });
  }
  return readFileSync(png);
}

const grande = fuente();
const res = join(__dirname, 'android', 'app', 'src', 'main', 'res');

// Android escala solo lo que no coincide exactamente. El de 256 es mas grande
// que todas las densidades, asi que reducir nunca pixela.
for (const carpeta of Object.keys(DENSIDADES)) {
  for (const nombre of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    writeFileSync(join(res, carpeta, nombre), grande);
  }
}

console.log(`icono puesto en ${Object.keys(DENSIDADES).length} densidades`);
