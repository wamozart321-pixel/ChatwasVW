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
 * La conversion es barata porque el webm que graba el navegador YA lleva Opus
 * adentro: solo cambia el envase. `-c:a copy` no recodifica, asi que no hay
 * perdida de calidad y tarda milisegundos, no segundos.
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
        // Copiar el flujo: el Opus ya esta ahi dentro, solo cambia el envase.
        '-c:a', 'copy',
        salida,
      ],
      { timeout: 30_000 },
    );

    const convertido = await readFile(salida);
    return convertido.length > 0 ? convertido : null;
  } catch {
    return null;
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  }
}
