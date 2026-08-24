/**
 * Dibuja el ícono de la app y lo escribe como PNG y como ICO.
 *
 *   node recursos/generar-icono.js
 *
 * Está hecho a mano en vez de con una librería de imágenes a propósito: es un
 * cuadrado redondeado con un globo de chat, no necesita una dependencia nativa
 * que después hay que compilar en cada máquina. El dibujo se rasteriza al
 * cuádruple y se reduce, que es lo que le da los bordes suaves.
 */
const { deflateSync } = require('node:zlib');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const VERDE = [22, 163, 74];
const VERDE_OSCURO = [15, 118, 61];
const BLANCO = [255, 255, 255];

/** Distancia con signo a un rectángulo redondeado, en coordenadas del lienzo. */
function distanciaRect(px, py, cx, cy, ancho, alto, radio) {
  const dx = Math.abs(px - cx) - (ancho / 2 - radio);
  const dy = Math.abs(py - cy) - (alto / 2 - radio);
  const fuera = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return fuera + Math.min(Math.max(dx, dy), 0) - radio;
}

function mezclar(fondo, frente, alfa) {
  return [
    Math.round(fondo[0] * (1 - alfa) + frente[0] * alfa),
    Math.round(fondo[1] * (1 - alfa) + frente[1] * alfa),
    Math.round(fondo[2] * (1 - alfa) + frente[2] * alfa),
  ];
}

/** Devuelve el color y la opacidad de un punto del dibujo, en un lienzo de 0..1. */
function pintar(x, y) {
  // Cuadrado redondeado de fondo, con un degradado suave hacia abajo.
  const dFondo = distanciaRect(x, y, 0.5, 0.5, 0.94, 0.94, 0.22);
  if (dFondo > 0) return null;

  let color = mezclar(VERDE, VERDE_OSCURO, Math.max(0, Math.min(1, (y - 0.25) * 0.9)));

  // Globo de chat.
  const dGlobo = distanciaRect(x, y, 0.5, 0.46, 0.54, 0.42, 0.13);

  // Colita del globo: un triángulo redondeado abajo a la izquierda.
  const tx = x - 0.36;
  const ty = y - 0.63;
  const dCola =
    ty < 0 || ty > 0.16 || tx < -0.05 || tx > 0.12
      ? 1
      : Math.max(ty - 0.16, -(tx + 0.05), tx - 0.12 + ty * 0.7) - 0.02;

  const dChat = Math.min(dGlobo, dCola);

  if (dChat < 0.004) {
    const alfa = Math.max(0, Math.min(1, (0.004 - dChat) / 0.008));
    color = mezclar(color, BLANCO, alfa);

    // Tres puntitos, como un mensaje escribiéndose.
    for (const cx of [0.37, 0.5, 0.63]) {
      const dPunto = Math.hypot(x - cx, y - 0.46) - 0.045;
      if (dPunto < 0.004) {
        const a = Math.max(0, Math.min(1, (0.004 - dPunto) / 0.008));
        color = mezclar(color, VERDE, a * alfa);
      }
    }
  }

  const alfaBorde = Math.max(0, Math.min(1, -dFondo / 0.008));
  return { color, alfa: alfaBorde };
}

/** Rasteriza a `lado` px con supermuestreo de 4×4. */
function rasterizar(lado) {
  const M = 4;
  const pixeles = Buffer.alloc(lado * lado * 4);

  for (let py = 0; py < lado; py++) {
    for (let px = 0; px < lado; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < M; sy++) {
        for (let sx = 0; sx < M; sx++) {
          const x = (px + (sx + 0.5) / M) / lado;
          const y = (py + (sy + 0.5) / M) / lado;
          const punto = pintar(x, y);
          if (!punto) continue;
          r += punto.color[0] * punto.alfa;
          g += punto.color[1] * punto.alfa;
          b += punto.color[2] * punto.alfa;
          a += punto.alfa;
        }
      }

      const n = M * M;
      const i = (py * lado + px) * 4;
      // Se divide por `a` y no por `n`: si no, los bordes se van a negro.
      pixeles[i] = a > 0 ? Math.round(r / a) : 0;
      pixeles[i + 1] = a > 0 ? Math.round(g / a) : 0;
      pixeles[i + 2] = a > 0 ? Math.round(b / a) : 0;
      pixeles[i + 3] = Math.round((a / n) * 255);
    }
  }

  return pixeles;
}

// --- PNG mínimo --------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function trozo(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

function png(lado, pixeles) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Cada fila lleva adelante su byte de filtro; 0 = sin filtro.
  const crudo = Buffer.alloc(lado * (lado * 4 + 1));
  for (let y = 0; y < lado; y++) {
    crudo[y * (lado * 4 + 1)] = 0;
    pixeles.copy(crudo, y * (lado * 4 + 1) + 1, y * lado * 4, (y + 1) * lado * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(crudo, { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO con varios tamaños; cada imagen va como PNG adentro. */
function ico(imagenes) {
  const cabecera = Buffer.alloc(6);
  cabecera.writeUInt16LE(0, 0);
  cabecera.writeUInt16LE(1, 2);
  cabecera.writeUInt16LE(imagenes.length, 4);

  let desplazamiento = 6 + imagenes.length * 16;
  const entradas = [];

  for (const { lado, datos } of imagenes) {
    const e = Buffer.alloc(16);
    e[0] = lado >= 256 ? 0 : lado; // 0 significa 256
    e[1] = lado >= 256 ? 0 : lado;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(datos.length, 8);
    e.writeUInt32LE(desplazamiento, 12);
    entradas.push(e);
    desplazamiento += datos.length;
  }

  return Buffer.concat([cabecera, ...entradas, ...imagenes.map((i) => i.datos)]);
}

const LADOS = [16, 24, 32, 48, 64, 128, 256];
const imagenes = LADOS.map((lado) => ({ lado, datos: png(lado, rasterizar(lado)) }));

writeFileSync(join(__dirname, 'icono.png'), imagenes.at(-1).datos);
writeFileSync(join(__dirname, 'icono.ico'), ico(imagenes));

console.log(`icono.png (256×256) y icono.ico (${LADOS.join(', ')}) escritos`);
