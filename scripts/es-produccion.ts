/**
 * ¿Esta cadena de conexión es la base de producción?
 *
 * Hace falta porque la base de desarrollo es temporal: cuando se migren los
 * clientes se borra, y el `.env` de este computador pasa a apuntar a producción.
 * Desde ese día, cualquier cosa que escriba datos de prueba —las suites de
 * integración, `npm run simular`— los escribe en la bandeja de verdad. Y
 * `simular -- limpiar` la vacía.
 *
 * Se compara contra `.env.respaldo-produccion`, que es la copia del `.env` del
 * servidor, en vez de fijar el nombre de la base en el código: si algún día se
 * cambia de proyecto en Neon, esto sigue funcionando sin tocarlo.
 *
 * Se ignora el `-pooler` del nombre: la misma base con y sin pooler es la misma
 * base, y un chequeo que se saltea cambiando la cadena de conexión no protege.
 *
 * Si no está el archivo de respaldo no se puede saber, y se deja pasar: bloquear
 * todo en una máquina donde nunca hubo producción sería un estorbo sin motivo.
 */
import { readFileSync } from 'node:fs';

function hostDe(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname.replace('-pooler', '').toLowerCase();
  } catch {
    return '';
  }
}

function urlDelArchivo(archivo: string): string | undefined {
  try {
    const linea = readFileSync(archivo, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('DATABASE_URL='));
    return linea?.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

export function esBaseDeProduccion(url: string | undefined): boolean {
  const propia = hostDe(url);
  if (!propia) return false;

  return ['.env.respaldo-produccion', '.env.produccion'].some((archivo) => {
    const produccion = hostDe(urlDelArchivo(archivo));
    return produccion !== '' && produccion === propia;
  });
}
