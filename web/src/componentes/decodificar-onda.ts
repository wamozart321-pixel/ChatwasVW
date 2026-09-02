import { barrasDe } from './onda';

/**
 * Decodifica una nota de voz y devuelve su onda.
 *
 * Se hace en el navegador y no en el servidor a propósito: el archivo ya está
 * bajado para poder reproducirlo, así que decodificarlo no cuesta una vuelta
 * más a la red, y guardar la onda en la base obligaría a recalcularla para
 * todas las notas de voz que ya existen.
 */

/**
 * Un único AudioContext para toda la bandeja.
 *
 * Los navegadores limitan cuántos se pueden tener abiertos, y un hilo con
 * treinta notas de voz abriría treinta. Se crea recién cuando hace falta:
 * construirlo al cargar la página lo deja suspendido y algunos navegadores
 * avisan por consola.
 */
let contexto: AudioContext | null = null;

function elContexto(): AudioContext | null {
  if (contexto) return contexto;

  const Constructor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return null;

  contexto = new Constructor();
  return contexto;
}

/**
 * Las alturas de las barras, o null si no se pudo.
 *
 * Que devuelva null no es un error a mostrar: el reproductor dibuja una barra
 * lisa y sigue andando. Decodificar puede fallar por un códec que el navegador
 * no conoce, y quedarse sin poder escuchar la nota de voz por no poder dibujar
 * su onda sería un mal negocio.
 */
export async function calcularOnda(url: string): Promise<number[] | null> {
  const ctx = elContexto();
  if (!ctx) return null;

  try {
    const respuesta = await fetch(url);
    const datos = await respuesta.arrayBuffer();
    const audio = await ctx.decodeAudioData(datos);

    return barrasDe(audio.getChannelData(0));
  } catch {
    return null;
  }
}
