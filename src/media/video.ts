import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const ejecutar = promisify(execFile);

/**
 * Deja un video en el único formato que WhatsApp acepta: MP4 con H.264 y AAC.
 *
 * Hace falta porque los celulares modernos graban en HEVC (H.265) para que el
 * archivo pese menos — en Samsung viene así de fábrica. Meta acepta la subida,
 * acepta el envío, y recién después avisa por webhook:
 *
 *   131053 Video file uploaded with mimetype as video/mp4, however on
 *   processing it is of type video/mp4, videoCodec=hevc [...]
 *
 * O sea que el asesor ve el video salir y enterarse de que no llegó depende de
 * que mire la palomita. Convertirlo acá es lo único que lo arregla: el códec de
 * la cámara no se puede elegir desde la web.
 */

export const MIME_VIDEO = 'video/mp4';

export function esVideo(mime: string): boolean {
  return /^video\//i.test(mime ?? '');
}

interface Flujos {
  video: string | null;
  audio: string | null;
  /** Más de una pista de audio: WhatsApp tampoco lo acepta. */
  variasDeAudio: boolean;
}

/** Qué códecs trae adentro. null si ffprobe no está o el archivo no se entiende. */
export async function codecs(datos: Buffer): Promise<Flujos | null> {
  const carpeta = await mkdtemp(join(tmpdir(), 'whatswv-video-'));
  const entrada = join(carpeta, `${randomUUID()}.bin`);

  try {
    await writeFile(entrada, datos);

    const { stdout } = await ejecutar(
      'ffprobe',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-print_format', 'json',
        '-show_streams',
        '-show_entries', 'stream=codec_type,codec_name',
        entrada,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const flujos = (JSON.parse(stdout).streams ?? []) as {
      codec_type?: string;
      codec_name?: string;
    }[];

    const deAudio = flujos.filter((f) => f.codec_type === 'audio');

    return {
      video: flujos.find((f) => f.codec_type === 'video')?.codec_name ?? null,
      audio: deAudio[0]?.codec_name ?? null,
      variasDeAudio: deAudio.length > 1,
    };
  } catch {
    return null;
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * ¿Se puede mandar tal cual?
 *
 * Ante la duda —ffprobe ausente, archivo raro— se dice que no y se convierte.
 * Convertir de más cuesta unos segundos; mandar de más cuesta un mensaje que el
 * cliente nunca recibe y que nadie nota.
 */
export function yaSirve(mime: string, flujos: Flujos | null): boolean {
  if (!flujos) return false;
  if (!/^video\/mp4$/i.test(mime)) return false;
  if (flujos.video !== 'h264') return false;
  if (flujos.variasDeAudio) return false;
  return flujos.audio === null || flujos.audio === 'aac';
}

/**
 * Lo que venga -> MP4 con H.264 y AAC. null si no se pudo.
 *
 * Se baja a 720p y se recomprime a propósito: un video de celular a 1080p pesa
 * más de los 16 MB que acepta WhatsApp en menos de un minuto, y para mostrar un
 * repuesto no hace falta más resolución. `veryfast` porque el asesor está
 * esperando con la pantalla en blanco: la diferencia de tamaño contra un preset
 * lento no compensa el minuto de espera.
 */
export async function aH264(datos: Buffer): Promise<Buffer | null> {
  const carpeta = await mkdtemp(join(tmpdir(), 'whatswv-video-'));
  const entrada = join(carpeta, `${randomUUID()}.bin`);
  const salida = join(carpeta, `${randomUUID()}.mp4`);

  try {
    await writeFile(entrada, datos);

    await ejecutar(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', entrada,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        // 24 y no el 28 de costumbre: lo que se filma es un repuesto, y muchas
        // veces lo que importa es leerle el numero de parte grabado en el
        // metal. Con 28 se emborrona justo eso. La diferencia de peso no
        // molesta: un video de medio minuto sigue entrando en los 16 MB.
        '-crf', '24',
        // El alto en -2 lo calcula ffmpeg y lo redondea a par: H.264 no admite
        // dimensiones impares. Y `min(1280,iw)` para no agrandar un video que
        // ya venga chico.
        '-vf', "scale='min(1280,iw)':-2",
        // Sin esto, un video grabado en un formato con más información de color
        // sale verde o no se abre en algunos telefonos.
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        // Una sola pista de video y una de audio: WhatsApp rechaza el resto.
        '-map', '0:v:0',
        '-map', '0:a:0?',
        // El índice al principio del archivo, para que se pueda empezar a ver
        // sin bajarlo entero.
        '-movflags', '+faststart',
        '-f', 'mp4',
        salida,
      ],
      { timeout: 300_000 },
    );

    const convertido = await readFile(salida);
    if (convertido.length === 0) return null;

    // Que de verdad sea un MP4: los bytes 4 a 8 de todo MP4 son 'ftyp'.
    if (convertido.subarray(4, 8).toString('ascii') !== 'ftyp') return null;

    return convertido;
  } catch {
    return null;
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  }
}
