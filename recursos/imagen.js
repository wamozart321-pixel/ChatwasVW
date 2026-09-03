/**
 * Lo justo para llevar el logo a los tamaños que piden Windows y Android.
 *
 * Sin librerías de imágenes a propósito: las que sirven traen binarios que hay
 * que compilar en cada máquina, y esto se corre dos veces al año. El PNG que
 * hay que leer es uno solo y lo controlamos nosotros, así que alcanza con
 * soportar lo que ese archivo usa: 8 bits por canal, RGB o RGBA, sin
 * entrelazado. Cualquier otra cosa avisa en vez de dibujar cualquier cosa.
 */
const { deflateSync, inflateSync } = require('node:zlib');

/** Un PNG leído: ancho, alto y los píxeles en RGBA de 8 bits. */
function decodificarPng(datos) {
  const firma = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!datos.subarray(0, 8).equals(firma)) throw new Error('no es un PNG');

  let ancho = 0;
  let alto = 0;
  let bits = 0;
  let tipoColor = 0;
  const trozos = [];

  let i = 8;
  while (i < datos.length) {
    const largo = datos.readUInt32BE(i);
    const tipo = datos.subarray(i + 4, i + 8).toString('ascii');
    const cuerpo = datos.subarray(i + 8, i + 8 + largo);

    if (tipo === 'IHDR') {
      ancho = cuerpo.readUInt32BE(0);
      alto = cuerpo.readUInt32BE(4);
      bits = cuerpo[8];
      tipoColor = cuerpo[9];
      if (bits !== 8) throw new Error(`el PNG usa ${bits} bits por canal; solo se admiten 8`);
      if (tipoColor !== 2 && tipoColor !== 6) {
        throw new Error(`tipo de color ${tipoColor}; solo se admiten 2 (RGB) y 6 (RGBA)`);
      }
      if (cuerpo[12] !== 0) throw new Error('el PNG esta entrelazado');
    } else if (tipo === 'IDAT') {
      trozos.push(cuerpo);
    } else if (tipo === 'IEND') {
      break;
    }

    i += 12 + largo;
  }

  const canales = tipoColor === 6 ? 4 : 3;
  const crudo = inflateSync(Buffer.concat(trozos));
  const porLinea = ancho * canales;
  const pixeles = Buffer.alloc(ancho * alto * 4);

  // Deshacer los filtros. Cada linea empieza con un byte que dice cual se uso;
  // todos se calculan contra el pixel de la izquierda y el de arriba.
  const linea = Buffer.alloc(porLinea);
  const anterior = Buffer.alloc(porLinea);

  for (let y = 0; y < alto; y++) {
    const inicio = y * (porLinea + 1);
    const filtro = crudo[inicio];
    crudo.copy(linea, 0, inicio + 1, inicio + 1 + porLinea);

    for (let x = 0; x < porLinea; x++) {
      const izq = x >= canales ? linea[x - canales] : 0;
      const arr = anterior[x];
      const diag = x >= canales ? anterior[x - canales] : 0;

      switch (filtro) {
        case 0:
          break;
        case 1:
          linea[x] = (linea[x] + izq) & 0xff;
          break;
        case 2:
          linea[x] = (linea[x] + arr) & 0xff;
          break;
        case 3:
          linea[x] = (linea[x] + ((izq + arr) >> 1)) & 0xff;
          break;
        case 4: {
          // Paeth: se queda con el vecino mas parecido a la suma de los tres.
          const p = izq + arr - diag;
          const di = Math.abs(p - izq);
          const da = Math.abs(p - arr);
          const dd = Math.abs(p - diag);
          const elegido = di <= da && di <= dd ? izq : da <= dd ? arr : diag;
          linea[x] = (linea[x] + elegido) & 0xff;
          break;
        }
        default:
          throw new Error(`filtro PNG desconocido: ${filtro}`);
      }
    }

    for (let x = 0; x < ancho; x++) {
      const o = (y * ancho + x) * 4;
      const s = x * canales;
      pixeles[o] = linea[s];
      pixeles[o + 1] = linea[s + 1];
      pixeles[o + 2] = linea[s + 2];
      pixeles[o + 3] = canales === 4 ? linea[s + 3] : 255;
    }

    linea.copy(anterior);
  }

  return { ancho, alto, pixeles };
}

/**
 * Reduce a `lado` px promediando.
 *
 * Promediar y no tomar un pixel de cada tantos: saltando pixeles, una linea
 * fina cae justo entre dos muestras y desaparece, que es exactamente lo que
 * pasa con la defensa y los faros del logo al bajar a 32 px.
 *
 * `recorte` permite quedarse con una parte: los tamaños chicos aprovechan mejor
 * el espacio sin el margen que Android si necesita.
 */
function redimensionar(img, lado, recorte) {
  const r = recorte ?? { x: 0, y: 0, ancho: img.ancho, alto: img.alto };
  const salida = Buffer.alloc(lado * lado * 4);

  for (let y = 0; y < lado; y++) {
    const y0 = r.y + Math.floor((y * r.alto) / lado);
    const y1 = Math.max(y0 + 1, r.y + Math.floor(((y + 1) * r.alto) / lado));

    for (let x = 0; x < lado; x++) {
      const x0 = r.x + Math.floor((x * r.ancho) / lado);
      const x1 = Math.max(x0 + 1, r.x + Math.floor(((x + 1) * r.ancho) / lado));

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let n = 0;

      for (let sy = y0; sy < y1 && sy < img.alto; sy++) {
        for (let sx = x0; sx < x1 && sx < img.ancho; sx++) {
          const o = (sy * img.ancho + sx) * 4;
          sr += img.pixeles[o];
          sg += img.pixeles[o + 1];
          sb += img.pixeles[o + 2];
          sa += img.pixeles[o + 3];
          n++;
        }
      }

      const o = (y * lado + x) * 4;
      salida[o] = Math.round(sr / n);
      salida[o + 1] = Math.round(sg / n);
      salida[o + 2] = Math.round(sb / n);
      salida[o + 3] = Math.round(sa / n);
    }
  }

  return { ancho: lado, alto: lado, pixeles: salida };
}

/**
 * Deja el dibujo blanco sobre transparente.
 *
 * Lo pide el ícono adaptativo de Android: la capa de adelante tiene que ser el
 * dibujo con el fondo transparente, y el color de atrás lo pone el sistema. Si
 * se le pasa el logo opaco, Android lo amplía un 50% dentro de su recorte y le
 * come los bordes.
 *
 * La transparencia sale de cuánto blanco tiene cada píxel, no de comparar con
 * un color exacto: así los bordes suavizados del dibujo quedan suaves en vez de
 * dentados, y el carro —que es del color del fondo— se vuelve transparente solo
 * y deja ver la capa de atrás.
 */
function soloElDibujo(img) {
  const salida = Buffer.alloc(img.pixeles.length);

  for (let i = 0; i < img.pixeles.length; i += 4) {
    const r = img.pixeles[i];
    const g = img.pixeles[i + 1];
    const b = img.pixeles[i + 2];

    // Lo blanco es el maximo de los tres canales alto Y los tres parecidos.
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    const blancura = Math.max(0, Math.min(255, min - (max - min)));

    salida[i] = 255;
    salida[i + 1] = 255;
    salida[i + 2] = 255;
    salida[i + 3] = blancura;
  }

  return { ancho: img.ancho, alto: img.alto, pixeles: salida };
}

/**
 * Pone la capa transparente sobre un color liso.
 *
 * Se usa para unificar el verde: el que trajo el archivo del logo es #209352 y
 * el de la bandeja es #1F9D55. La diferencia no se nota mirando el icono solo,
 * pero al lado de la cabecera de la app si, y no hay razon para tener dos.
 */
function sobreColor(capa, [r, g, b]) {
  const salida = Buffer.alloc(capa.pixeles.length);

  for (let i = 0; i < capa.pixeles.length; i += 4) {
    const a = capa.pixeles[i + 3] / 255;
    salida[i] = Math.round(capa.pixeles[i] * a + r * (1 - a));
    salida[i + 1] = Math.round(capa.pixeles[i + 1] * a + g * (1 - a));
    salida[i + 2] = Math.round(capa.pixeles[i + 2] * a + b * (1 - a));
    salida[i + 3] = 255;
  }

  return { ancho: capa.ancho, alto: capa.alto, pixeles: salida };
}

/** El recuadro que ocupa el dibujo, para poder recortarlo sin adivinar. */
function recuadroDelDibujo(img, margen = 0) {
  let minX = img.ancho;
  let minY = img.alto;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < img.alto; y++) {
    for (let x = 0; x < img.ancho; x++) {
      const o = (y * img.ancho + x) * 4;
      const claro =
        img.pixeles[o] > 200 && img.pixeles[o + 1] > 200 && img.pixeles[o + 2] > 200;
      if (!claro) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Cuadrado y centrado: si no, el dibujo sale estirado al redimensionar.
  const lado = Math.max(maxX - minX, maxY - minY) + margen * 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return {
    x: Math.max(0, Math.round(cx - lado / 2)),
    y: Math.max(0, Math.round(cy - lado / 2)),
    ancho: Math.min(lado, img.ancho),
    alto: Math.min(lado, img.alto),
  };
}

// --- escritura ---------------------------------------------------------------

function trozo(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);

  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo) >>> 0);

  return Buffer.concat([largo, cuerpo, crc]);
}

let tablaCrc = null;
function crc32(datos) {
  if (!tablaCrc) {
    tablaCrc = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tablaCrc[n] = c;
    }
  }

  let c = -1;
  for (const b of datos) c = tablaCrc[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** PNG con transparencia (color tipo 6). */
function codificarPng(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.ancho, 0);
  ihdr.writeUInt32BE(img.alto, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  // Cada linea con filtro 0: el logo son dos colores planos, deflate lo deja
  // igual de chico y el codigo queda sin filtros que elegir.
  const crudo = Buffer.alloc(img.alto * (img.ancho * 4 + 1));
  for (let y = 0; y < img.alto; y++) {
    const destino = y * (img.ancho * 4 + 1);
    crudo[destino] = 0;
    img.pixeles.copy(crudo, destino + 1, y * img.ancho * 4, (y + 1) * img.ancho * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(crudo, { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO con varios tamaños; cada imagen va como PNG adentro. */
function codificarIco(imagenes) {
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
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(datos.length, 8);
    e.writeUInt32LE(desplazamiento, 12);
    entradas.push(e);
    desplazamiento += datos.length;
  }

  return Buffer.concat([cabecera, ...entradas, ...imagenes.map((i) => i.datos)]);
}

module.exports = {
  decodificarPng,
  redimensionar,
  soloElDibujo,
  sobreColor,
  recuadroDelDibujo,
  codificarPng,
  codificarIco,
};
