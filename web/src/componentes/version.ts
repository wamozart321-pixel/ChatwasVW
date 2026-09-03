/**
 * Comparar versiones de la app.
 *
 * Aparte del componente que muestra el aviso porque es la parte que puede estar
 * mal y la única que se puede probar sin un navegador: dibujar un cartel no
 * tiene forma de fallar en silencio, decidir si hay que mostrarlo sí.
 */

/**
 * ¿`candidata` es posterior a `actual`?
 *
 * Comparando como texto, '0.10.0' sale menor que '0.9.0' y la actualización no
 * se ofrecería nunca. Hay que comparar número por número.
 */
export function esMasNueva(candidata: string, actual: string): boolean {
  const a = candidata.split('.').map(Number);
  const b = actual.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Qué versión de la app de Android tiene este teléfono, o null si es un
 * navegador normal.
 *
 * Viaja en el User-Agent, que el empaquetado completa desde package.json. Es la
 * única vía sin plugins: la página está servida por el servidor, no empaquetada
 * dentro del .apk, así que no puede leer nada del propio paquete.
 */
export function versionDeLaApp(userAgent: string): string | null {
  return userAgent.match(/WhatsWV\/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}
