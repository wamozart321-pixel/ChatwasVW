import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { env } from '../config/env';
import { DB, type Database } from '../db/db.module';
import { messages } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GraphService } from '../whatsapp/graph.service';
import { MIME_NOTA_DE_VOZ, aNotaDeVoz, esWebmDeVoz } from './audio';
import { AlmacenService } from './almacen.service';

/** Tipos que WhatsApp acepta enviar, según el mime del archivo. */
function tipoDeMime(mime: string): string {
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

@Injectable()
export class MediaService {
  private readonly log = new Logger(MediaService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly graph: GraphService,
    private readonly almacen: AlmacenService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Baja a disco el archivo de un mensaje entrante.
   *
   * Corre en el worker, justo después de guardar el mensaje: la URL que da Meta
   * vence a los ~5 minutos, así que no se puede dejar para después. Si falla, el
   * mensaje igual queda guardado con su media_id y se puede reintentar.
   */
  async descargarEntrante(params: {
    messageId: string;
    conversationId: string;
    mediaId: string;
    mime: string | null;
    nombre: string | null;
  }): Promise<void> {
    try {
      const info = await this.graph.urlDeMedia(params.mediaId);

      const limite = env.MEDIA_MAX_MB * 1024 * 1024;
      if (info.file_size && info.file_size > limite) {
        this.log.warn(
          `archivo de ${Math.round(info.file_size / 1024 / 1024)} MB supera el tope; no se baja`,
        );
        return;
      }

      const datos = await this.graph.descargarMedia(info.url);
      const mime = info.mime_type ?? params.mime;
      const ruta = await this.almacen.guardar(datos, mime, params.nombre);

      await this.db
        .update(messages)
        .set({
          mediaUrl: ruta,
          mediaMime: mime ?? null,
          mediaTamano: datos.length,
          mediaNombre: params.nombre,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(messages.id, params.messageId));

      // El hilo ya mostró el mensaje sin imagen; este aviso la hace aparecer.
      this.realtime.mediaLista(params.conversationId, params.messageId, ruta);
      this.log.log(`media descargada para ${params.messageId}`);
    } catch (e) {
      // Nunca tumba el procesamiento del webhook: el mensaje vale más que el archivo.
      this.log.error(`no se pudo bajar la media ${params.mediaId}: ${(e as Error).message}`);
    }
  }

  /** Sube un archivo a Meta y devuelve lo necesario para enviarlo. */
  async prepararSalida(archivo: { buffer: Buffer; mimetype: string; originalname: string }) {
    const limite = env.MEDIA_MAX_MB * 1024 * 1024;
    if (archivo.buffer.length > limite) {
      throw new BadRequestException(`el archivo supera los ${env.MEDIA_MAX_MB} MB`);
    }

    let { buffer, mimetype, originalname } = archivo;

    // El navegador graba webm porque Chromium no puede grabar OGG, y WhatsApp
    // solo dibuja la onda de nota de voz si el audio es OGG con Opus. El Opus
    // ya viene adentro del webm, asi que solo cambia el envase.
    if (esWebmDeVoz(mimetype)) {
      const ogg = await aNotaDeVoz(buffer);
      this.log.log(
        `nota de voz: ${mimetype} ${buffer.length} B -> ${ogg ? `ogg ${ogg.length} B` : 'FALLO'}`,
      );
      if (ogg) {
        buffer = ogg;
        mimetype = MIME_NOTA_DE_VOZ;
        originalname = originalname.replace(/\.webm$/i, '') + '.ogg';
      } else {
        // Sin ffmpeg no se puede convertir, y webm no esta entre los formatos
        // que WhatsApp acepta: mandarlo asi seria un rechazo seguro.
        this.log.error('no se pudo convertir la nota de voz: ¿está ffmpeg instalado?');
        throw new BadRequestException(
          'No se pudo preparar la nota de voz. Probá adjuntando el audio como archivo.',
        );
      }
    }

    const tipo = tipoDeMime(mimetype);
    const mediaId = await this.graph.subirMedia(buffer, mimetype, originalname);

    // Se guarda copia local para poder mostrarlo en el hilo: el id de Meta
    // vence a los 30 días y el archivo dejaría de verse.
    const ruta = await this.almacen.guardar(buffer, mimetype, originalname);

    return { tipo, mediaId, ruta, tamano: buffer.length, mime: mimetype, nombre: originalname };
  }
}
