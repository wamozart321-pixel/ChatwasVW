import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const ejecutar = promisify(execFile);

/**
 * Pasa una nota de voz al formato que WhatsApp muestra como nota de voz.
 *
 * El navegador no puede grabar OGG: Chromium solo ofrece `audio/webm` o
 * `audio/mp4` (comprobado en Chromium 150). Y WhatsApp solo dibuja la onda de
 * nota de voz cuando el audio es OGG con codec Opus — con cualquier otro
 * formato le llega al cliente como un archivo de audio suelto.
 *
 * Se RECODIFICA en vez de solo cambiar el envase. La copia de flujo es mas
 * rapida y no pierde calidad, pero depende de que el webm de entrada este bien
 * formado, y el que produce MediaRecorder no lo esta: sale como un flujo en
 * vivo, sin duracion en la cabecera. Meta rechazaba el resultado con
 * «uploaded with mimetype as audio/ogg, however on processing it is of type
 * application/octet-stream». Recodificar cuesta decimas de segundo en una nota
 * de voz y produce un OGG canonico que Meta acepta siempre.
 *
 * Si ffmpeg no esta instalado devuelve null y el que llama manda el archivo
 * como venga: llega como audio igual, sin la onda. Es peor, pero es mucho mejor
 * que no poder mandar nada.
 */

/** El unico formato que WhatsApp trata como nota de voz. */
export const MIME_NOTA_DE_VOZ = 'audio/ogg';

export function esWebmDeVoz(mime: string): boolean {
  return /^audio\/webm/i.test(mime ?? '');
}

export async function hayFfmpeg(): Promise<boolean> {
  try {
    await ejecutar('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * webm/opus -> ogg/opus. null si no se pudo.
 *
 * Va por archivos temporales y no por tuberias: ffmpeg necesita poder buscar
 * dentro del archivo para leer el contenedor webm, y sobre stdin no puede.
 */
export async function aNotaDeVoz(datos: Buffer): Promise<Buffer | null> {
  const carpeta = await mkdtemp(join(tmpdir(), 'whatswv-audio-'));
  const entrada = join(carpeta, `${randomUUID()}.webm`);
  const salida = join(carpeta, `${randomUUID()}.ogg`);

  try {
    await writeFile(entrada, datos);

    await ejecutar(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', entrada,
        '-vn',
        // Sin los metadatos del webm y arrancando el audio en cero.
        //
        // Lo segundo es lo que costo encontrar: MediaRecorder empieza a contar
        // en un instante distinto de cero, y ffmpeg arrastraba ese desfase al
        // OGG (start_pts=576 en vez de 0). Meta acepta la subida, acepta el
        // envio, y recien despues avisa por webhook que fallo con
        // «on processing it is of type application/octet-stream» — un mensaje
        // que no tiene nada que ver con la causa. El mismo archivo con el
        // tiempo normalizado se entrega sin problema.
        '-map_metadata', '-1',
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'libopus',
        // Parametros de voz, no de musica: mono, 32 kbps y el modo 'voip' de
        // Opus. Una nota de voz de un minuto pesa ~240 KB en vez de un mega.
        '-ac', '1',
        '-ar', '48000',
        '-b:a', '32k',
        '-application', 'voip',
        '-f', 'ogg',
        salida,
      ],
      { timeout: 60_000 },
    );

    const convertido = await readFile(salida);
    if (convertido.length === 0) return null;

    // Que de verdad sea un OGG: si ffmpeg escribiera cualquier otra cosa,
    // Meta lo rechaza con un error que no dice nada util. Los cuatro primeros
    // bytes de todo archivo OGG son 'OggS'.
    if (convertido.subarray(0, 4).toString('ascii') !== 'OggS') return null;

    return convertido;
  } catch {
    return null;
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  }
}
