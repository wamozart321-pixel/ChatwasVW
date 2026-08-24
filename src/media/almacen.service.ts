import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { env } from '../config/env';

/** Extensiones por mime. Meta manda el mime, no el nombre, salvo en documentos. */
const EXTENSIONES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * Almacen local de archivos.
 *
 * Local a proposito: para un equipo de 7 sobra, no agrega credenciales que
 * rotar, y el respaldo es copiar una carpeta. El dia que haya mas de una
 * instancia hay que mover esto a S3/R2, porque cada proceso veria su propio disco.
 */
@Injectable()
export class AlmacenService {
  private readonly log = new Logger(AlmacenService.name);
  private readonly raiz = resolve(env.ALMACEN_DIR);

  extension(mime: string | null, nombre?: string | null): string {
    if (mime && EXTENSIONES[mime]) return EXTENSIONES[mime];

    const delNombre = nombre?.split('.').pop();
    if (delNombre && delNombre.length <= 5 && /^[a-z0-9]+$/i.test(delNombre)) {
      return delNombre.toLowerCase();
    }
    return 'bin';
  }

  /** @returns la ruta relativa, que es lo que se guarda en la base. */
  async guardar(datos: Buffer, mime: string | null, nombre?: string | null): Promise<string> {
    const ahora = new Date();
    const carpeta = join(
      String(ahora.getUTCFullYear()),
      String(ahora.getUTCMonth() + 1).padStart(2, '0'),
    );

    const relativa = join(carpeta, `${randomUUID()}.${this.extension(mime, nombre)}`);
    const absoluta = join(this.raiz, relativa);

    await mkdir(dirname(absoluta), { recursive: true });
    await writeFile(absoluta, datos);

    this.log.debug(`guardado ${relativa} (${datos.length} bytes)`);
    return relativa.split(sep).join('/');
  }

  /**
   * Ruta absoluta a partir de la relativa guardada.
   *
   * Comprueba que quede dentro de la raiz: la ruta viene de la base, pero si
   * alguna vez llegara de una peticion, un '../..' se llevaria cualquier archivo
   * del disco.
   */
  rutaDe(relativa: string): string | null {
    const absoluta = resolve(this.raiz, normalize(relativa));
    if (!absoluta.startsWith(this.raiz + sep)) return null;
    return existsSync(absoluta) ? absoluta : null;
  }

  leer(relativa: string) {
    const absoluta = this.rutaDe(relativa);
    return absoluta ? createReadStream(absoluta) : null;
  }

  async tamano(relativa: string): Promise<number | null> {
    const absoluta = this.rutaDe(relativa);
    if (!absoluta) return null;
    return (await stat(absoluta)).size;
  }
}
