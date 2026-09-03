/**
 * Saber qué app tiene el asesor delante y si está al día.
 *
 * Aparte del componente que muestra el aviso porque es la parte que puede estar
 * mal y la única que se puede probar sin un navegador: dibujar un cartel no
 * tiene forma de fallar en silencio, decidir si hay que mostrarlo sí.
 */

export interface AppInstalada {
  /** Corre dentro del .apk y no en el navegador del celular. */
  esApp: boolean;
  /** Qué versión dice ser, o null si no lo dice. */
  version: string | null;
}

/**
 * Qué app está abriendo la bandeja, leyendo el `User-Agent`.
 *
 * La versión la escribe el empaquetado desde package.json. Es la única vía sin
 * plugins: la página la sirve el servidor, no está dentro del .apk, así que no
 * puede leer nada del propio paquete.
 *
 * Se mira aparte si es la app, porque las versiones anteriores a la 0.2.0 se
 * empaquetaron sin esa marca. Sin esta distinción, justamente los teléfonos con
 * la app más vieja —los que más necesitan el aviso— serían los únicos que no lo
 * verían nunca. `wv)` en el User-Agent es lo que Android le pone a cualquier app
 * que muestra una web adentro.
 */
export function appInstalada(userAgent: string): AppInstalada {
  const esApp = /Android/i.test(userAgent) && /;\s*wv\)/i.test(userAgent);
  const version = userAgent.match(/WhatsWV\/(\d+\.\d+\.\d+)/)?.[1] ?? null;

  return { esApp: esApp || version !== null, version };
}

/**
 * ¿`candidata` es posterior a `actual`?
 *
 * Con `actual` en null —una app tan vieja que no dice su versión— cualquiera es
 * más nueva.
 *
 * Comparando como texto, '0.10.0' sale menor que '0.9.0' y la actualización no
 * se ofrecería nunca. Hay que comparar número por número.
 */
export function esMasNueva(candidata: string, actual: string | null): boolean {
  if (actual === null) return true;

  const a = candidata.split('.').map(Number);
  const b = actual.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}
