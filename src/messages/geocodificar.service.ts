import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

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

    this.cache.set(q.toLowerCase(), { cuando: Date.now(), datos: lugares });
    return lugares;
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
