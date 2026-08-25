/**
 * Saca coordenadas de lo que un asesor pega en la caja.
 *
 * En la practica nadie escribe "4.6482, -74.0776": copia el enlace desde la app
 * de Google Maps y lo pega. Los formatos que salen de ahi son varios y ninguno
 * documentado, asi que se cubren los que aparecen en el telefono y en el
 * navegador, mas las coordenadas sueltas para el que las tenga a mano.
 */

export interface Coordenadas {
  latitud: number;
  longitud: number;
}

/** Bogota esta en 4.6, -74.0. Fuera de estos rangos no es una coordenada. */
function validas(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    // 0,0 es el Golfo de Guinea: casi siempre significa que el parseo fallo.
    !(lat === 0 && lon === 0)
  );
}

const PATRONES: RegExp[] = [
  // https://www.google.com/maps/@4.6482,-74.0776,17z
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,
  // https://maps.google.com/?q=4.6482,-74.0776  ·  ?ll=  ·  ?daddr=
  /[?&](?:q|ll|daddr|destination|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
  // .../data=!3d4.6482!4d-74.0776
  /!3d(-?\d+\.\d+).*?!4d(-?\d+\.\d+)/,
  // https://www.google.com/maps/place/4.6482,-74.0776
  /\/(-?\d+\.\d+),(-?\d+\.\d+)(?:[/?]|$)/,
  // "4.6482, -74.0776" pegado a mano
  /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/,
];

/** null si no se reconoce nada. Nunca inventa una coordenada. */
export function coordenadasDe(texto: string): Coordenadas | null {
  const limpio = (texto ?? '').trim();
  if (!limpio) return null;

  for (const patron of PATRONES) {
    const m = limpio.match(patron);
    if (!m) continue;

    const latitud = Number(m[1]);
    const longitud = Number(m[2]);
    if (validas(latitud, longitud)) return { latitud, longitud };
  }

  return null;
}

/** Los enlaces cortos no traen las coordenadas: hay que ver a donde redirigen. */
export function esEnlaceCorto(texto: string): boolean {
  return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test((texto ?? '').trim());
}

/**
 * Resuelve un enlace corto siguiendo la redireccion.
 *
 * Va en el servidor y no en el navegador porque Google no manda cabeceras CORS:
 * el fetch del frontend no puede leer a donde apunta.
 */
export async function resolverEnlaceCorto(url: string): Promise<Coordenadas | null> {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      // Sin User-Agent de navegador, Google a veces devuelve una pagina sin las
      // coordenadas en la URL.
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    // Primero la URL final; si ahi no estan, se busca en el HTML, donde Google
    // deja las coordenadas en el patron !3d...!4d...
    return coordenadasDe(r.url) ?? coordenadasDe(await r.text());
  } catch {
    return null;
  }
}
