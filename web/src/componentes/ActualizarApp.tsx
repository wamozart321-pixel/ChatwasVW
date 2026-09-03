import { useCallback, useEffect, useState } from 'react';
import { esMasNueva, versionDeLaApp } from './version';

/**
 * Avisa cuando hay una versión nueva de la app de Android.
 *
 * La app no trae la bandeja adentro: abre la del servidor. Eso hace que los
 * cambios de la bandeja lleguen solos, pero NO los del envoltorio —permisos,
 * ícono, la dirección del servidor—, que viven dentro del .apk. Para eso hace
 * falta reinstalar, y sin este aviso nadie se entera de que hay algo nuevo.
 *
 * Android no deja instalar en silencio: cualquier .apk que no venga de Play
 * Store exige que la persona confirme. Así que lo más lejos que se puede llegar
 * es avisar y dejar el botón; el resto lo hace el asesor en dos toques.
 *
 * En la app de Windows esto no aparece: allá el actualizador de Electron baja e
 * instala solo al cerrar, y un cartel además sería ruido.
 */

/** Cada cuánto se vuelve a mirar. Igual que la app de Windows. */
const CADA_MS = 4 * 60 * 60 * 1000;

/**
 * El manifiesto lo escribe `movil/publicar.js` al lado del .apk.
 *
 * Es un archivo estático servido por Caddy y no un endpoint de la API: sigue
 * estando aunque la bandeja esté caída, que es justo cuando uno querría poder
 * reinstalar.
 */
const MANIFIESTO = '/instalar/android.json';

interface Manifiesto {
  version: string;
  url: string;
}

/** Se recuerda cuál se descartó para no repetir el cartel en cada recarga. */
const DESCARTADA = 'whatswv.version_descartada';

export default function ActualizarApp() {
  const [nueva, setNueva] = useState<Manifiesto | null>(null);
  const instalada = versionDeLaApp(navigator.userAgent);

  const revisar = useCallback(async () => {
    if (!instalada) return;

    try {
      // Sin caché: el navegador guardaría el manifiesto y la app seguiría
      // creyendo que no hay nada nuevo durante horas.
      const r = await fetch(MANIFIESTO, { cache: 'no-store' });
      if (!r.ok) return;

      const m = (await r.json()) as Manifiesto;
      if (!m?.version || !esMasNueva(m.version, instalada)) return;
      if (localStorage.getItem(DESCARTADA) === m.version) return;

      setNueva(m);
    } catch {
      // Sin internet o el servidor caído: no es algo que haya que contarle al
      // asesor. Se vuelve a mirar en la próxima vuelta.
    }
  }, [instalada]);

  useEffect(() => {
    void revisar();
    const t = setInterval(() => void revisar(), CADA_MS);
    return () => clearInterval(t);
  }, [revisar]);

  if (!nueva) return null;

  return (
    <div className="flex items-center gap-3 border-b border-marca-100 bg-marca-50 px-4 py-2 text-xs text-marca-700">
      <span className="min-w-0 flex-1">
        Hay una versión nueva de la app ({nueva.version}). Tenés la {instalada}.
      </span>

      <a
        href={nueva.url}
        className="shrink-0 rounded-lg bg-marca-500 px-3 py-1.5 font-medium text-white transition hover:bg-marca-600"
      >
        Actualizar
      </a>

      <button
        onClick={() => {
          try {
            localStorage.setItem(DESCARTADA, nueva.version);
          } catch {
            /* modo privado: se vuelve a avisar y no pasa nada */
          }
          setNueva(null);
        }}
        title="Recordármelo con la próxima versión"
        className="shrink-0 rounded px-1 text-marca-500 transition hover:text-marca-700"
      >
        ✕
      </button>
    </div>
  );
}
