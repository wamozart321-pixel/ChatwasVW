import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { env } from '../config/env';
import { comoTexto, parsearDireccionCo } from './direccion-co';

/**
 * Busca direcciones contra Nominatim, el buscador de OpenStreetMap.
 *
 * Va por el servidor y no desde el navegador por dos motivos: Nominatim exige
 * un User-Agent que identifique a la aplicacion —si no, devuelve 403— y limita
 * a una consulta por segundo. Desde siete bandejas abiertas eso se pasa solo;
 * desde aca se puede encolar y cachear.
 *
 * Se usa OpenStreetMap y no Google Maps porque Google cobra por consulta y pide
 * tarjeta. Para buscar la direccion de un cliente en Bogota, OSM alcanza.
 */

export interface Lugar {
  nombre: string;
  latitud: number;
  longitud: number;
}

interface RespuestaNominatim {
  lat: string;
  lon: string;
  display_name: string;
  geojson?: { type: string; coordinates: unknown };
}

/**
 * Que tan cerca tienen que quedar las dos vias para darlo por bueno.
 *
 * En los datos de OpenStreetMap las vias de Bogota casi nunca se tocan exacto:
 * estan cortadas en tramos con nombres distintos, y el punto mas cercano entre
 * "Carrera 27A" y "Calle 66" puede quedar a 300 m del cruce real. Aun asi, 300 m
 * son tres cuadras — muchisimo mejor que el tramo al azar de la otra punta de la
 * ciudad que devuelve la busqueda por texto. Por eso se devuelve igual, pero
 * diciendo que es aproximado.
 */
const METROS_ESQUINA_EXACTA = 60;
const METROS_MAXIMO_UTIL = 900;

/** Metros aproximados entre dos coordenadas. A esta escala, plano alcanza. */
function metros(a: [number, number], b: [number, number]): number {
  const dx = (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180);
  const dy = (a[0] - b[0]) * 110_540;
  return Math.hypot(dx, dy);
}

/** Todos los vertices de una via; si no vino la geometria, su centro. */
function verticesDe(d: RespuestaNominatim): [number, number][] {
  const g = d.geojson;
  const centro: [number, number] = [Number(d.lat), Number(d.lon)];

  if (!g || !Array.isArray(g.coordinates)) return [centro];

  const crudas = g.type === 'LineString' ? g.coordinates : (g.coordinates as unknown[]).flat();
  const puntos = (crudas as unknown[])
    .filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2)
    .map(([lon, lat]) => [lat, lon] as [number, number]);

  return puntos.length ? puntos : [centro];
}

/** Nominatim pide como maximo una consulta por segundo. */
const MINIMO_ENTRE_CONSULTAS_MS = 1100;

/** Media hora: una direccion no se muda. */
const VIDA_CACHE_MS = 30 * 60_000;

@Injectable()
export class GeocodificarService {
  private readonly log = new Logger(GeocodificarService.name);
  private readonly cache = new Map<string, { cuando: number; datos: Lugar[] }>();

  /** Cola de un solo carril: encadena las consultas para respetar el limite. */
  private turno: Promise<unknown> = Promise.resolve();
  private ultima = 0;

  async buscar(consulta: string): Promise<Lugar[]> {
    const q = consulta.trim();
    if (q.length < 3) return [];

    const enCache = this.cache.get(q.toLowerCase());
    if (enCache && Date.now() - enCache.cuando < VIDA_CACHE_MS) return enCache.datos;

    const datos = await this.enFila(() =>
      this.pedir('/search', {
        q,
        format: 'jsonv2',
        limit: '6',
        // Sesgado a Colombia: el asesor busca direcciones de acá, y sin esto
        // "calle 13" devuelve resultados de media docena de paises.
        countrycodes: 'co',
        'accept-language': 'es',
      }),
    );

    const lugares = datos.map((d) => ({
      nombre: d.display_name,
      latitud: Number(d.lat),
      longitud: Number(d.lon),
    }));

    // Si era una direccion colombiana, la esquina va primero: es la respuesta
    // correcta, y lo que devolvio la busqueda por texto son tramos al azar.
    const esquina = await this.porCruceDeVias(q).catch((e) => {
      // Nunca en silencio: si el cruce falla, la busqueda sigue sirviendo pero
      // el asesor recibe un punto peor y nadie se entera de por que.
      this.log.warn(`no se pudo ubicar el cruce de "${q}": ${(e as Error).message}`);
      return null;
    });
    if (esquina) lugares.unshift(esquina);

    this.cache.set(q.toLowerCase(), { cuando: Date.now(), datos: lugares });
    return lugares;
  }

  /**
   * Ubica una direccion colombiana por el cruce de sus dos vias.
   *
   * Buscar "Cra 27A #66-82" entero no sirve: Nominatim encuentra que existe una
   * "Carrera 27A" y devuelve cualquiera de los 16 tramos con ese nombre que hay
   * en Bogota, uno en Galerias y otro en Ciudad Bolivar. Pero la direccion ya
   * dice cual es: la Carrera 27A *a la altura de la Calle 66*. Se buscan las dos
   * vias con su geometria y se toma el punto donde se tocan.
   *
   * Devuelve null si no parece una direccion o si las vias no se cruzan; ahi el
   * que llama sigue con la busqueda normal.
   */
  private async porCruceDeVias(consulta: string): Promise<Lugar | null> {
    const dir = parsearDireccionCo(consulta);
    if (!dir) return null;

    // Lo que el asesor escribio despues de la direccion suele ser el barrio o
    // la ciudad. Si no escribio nada, se asume la del negocio.
    const resto = consulta.replace(/^[^,]*/, '').replace(/^,\s*/, '').trim();
    const donde = resto || env.CIUDAD_PREDETERMINADA;

    const [principal, cruce] = await Promise.all([
      this.enFila(() => this.pedir('/search', this.paramsDeVia(`${dir.principal}, ${donde}`))),
      this.enFila(() => this.pedir('/search', this.paramsDeVia(`${dir.cruce}, ${donde}`))),
    ]);

    if (!principal.length || !cruce.length) {
      this.log.warn(
        `sin tramos para el cruce: "${dir.principal}" dio ${principal.length}, "${dir.cruce}" dio ${cruce.length}`,
      );
      return null;
    }

    let mejor: { d: number; punto: [number, number] } | null = null;

    for (const a of principal) {
      for (const pa of verticesDe(a)) {
        for (const b of cruce) {
          for (const pb of verticesDe(b)) {
            const d = metros(pa, pb);
            if (!mejor || d < mejor.d) mejor = { d, punto: pa };
          }
        }
      }
    }

    if (!mejor || mejor.d > METROS_MAXIMO_UTIL) {
      this.log.warn(
        `"${consulta}": las vias quedan a ${mejor?.d.toFixed(0) ?? '?'} m, demasiado para servir`,
      );
      return null;
    }

    const exacta = mejor.d <= METROS_ESQUINA_EXACTA;

    return {
      // La placa exacta nunca se puede ubicar: OpenStreetMap casi no tiene
      // numeros de casa en Colombia. Lo que se dice es a que esquina se llego y
      // con cuanta confianza, para que el asesor sepa si tiene que mover el pin.
      nombre: exacta
        ? `${comoTexto(dir)} — esquina de ${dir.principal} con ${dir.cruce}, ${donde}`
        : `${comoTexto(dir)} — cerca de ${dir.principal} con ${dir.cruce} (±${Math.round(mejor.d / 100) * 100} m, ajustá el pin), ${donde}`,
      latitud: mejor.punto[0],
      longitud: mejor.punto[1],
    };
  }

  private paramsDeVia(q: string): Record<string, string> {
    return {
      q,
      format: 'jsonv2',
      limit: '25',
      countrycodes: 'co',
      'accept-language': 'es',
      // La geometria es lo que permite encontrar donde se tocan; sin ella solo
      // se tiene el centro de cada tramo, que puede estar a cuadras del cruce.
      polygon_geojson: '1',
    };
  }

  /** De coordenadas a direccion: es lo que confirma que el punto es el correcto. */
  async direccionDe(latitud: number, longitud: number): Promise<string | null> {
    const clave = `rev:${latitud.toFixed(5)},${longitud.toFixed(5)}`;
    const enCache = this.cache.get(clave);
    if (enCache && Date.now() - enCache.cuando < VIDA_CACHE_MS) {
      return enCache.datos[0]?.nombre ?? null;
    }

    const datos = await this.enFila(() =>
      this.pedir('/reverse', {
        lat: String(latitud),
        lon: String(longitud),
        format: 'jsonv2',
        'accept-language': 'es',
      }),
    );

    const nombre = datos[0]?.display_name ?? null;
    if (nombre) {
      this.cache.set(clave, { cuando: Date.now(), datos: [{ nombre, latitud, longitud }] });
    }
    return nombre;
  }

  /** Encadena y espacia: nunca hay dos consultas en vuelo ni dos en el mismo segundo. */
  private enFila<T>(fn: () => Promise<T>): Promise<T> {
    const siguiente = this.turno.then(async () => {
      const espera = MINIMO_ENTRE_CONSULTAS_MS - (Date.now() - this.ultima);
      if (espera > 0) await new Promise((r) => setTimeout(r, espera));
      this.ultima = Date.now();
      return fn();
    });

    // La cola no se corta si una consulta falla.
    this.turno = siguiente.catch(() => undefined);
    return siguiente;
  }

  private async pedir(
    ruta: string,
    params: Record<string, string>,
  ): Promise<RespuestaNominatim[]> {
    const url = `https://nominatim.openstreetmap.org${ruta}?${new URLSearchParams(params)}`;

    try {
      const r = await fetch(url, {
        headers: {
          // Obligatorio: sin esto Nominatim responde 403.
          'User-Agent': 'WhatsWV/1.0 (bandeja de WhatsApp; contacto: bandeja.chatwasvw.com)',
          'Accept-Language': 'es',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!r.ok) {
        this.log.warn(`nominatim respondio ${r.status}`);
        throw new ServiceUnavailableException('el buscador de direcciones no responde');
      }

      const cuerpo = (await r.json()) as RespuestaNominatim | RespuestaNominatim[];
      return Array.isArray(cuerpo) ? cuerpo : [cuerpo];
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.log.warn(`no se pudo consultar nominatim: ${(e as Error).message}`);
      throw new ServiceUnavailableException('el buscador de direcciones no responde');
    }
  }
}
