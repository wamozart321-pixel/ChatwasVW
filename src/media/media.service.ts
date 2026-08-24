import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { env } from '../config/env';
import { DB, type Database } from '../db/db.module';
import { messages } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GraphService } from '../whatsapp/graph.service';
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

    const tipo = tipoDeMime(archivo.mimetype);
    const mediaId = await this.graph.subirMedia(
      archivo.buffer,
      archivo.mimetype,
      archivo.originalname,
    );

    // Se guarda copia local para poder mostrarlo en el hilo: el id de Meta
    // vence a los 30 días y el archivo dejaría de verse.
    const ruta = await this.almacen.guardar(
      archivo.buffer,
      archivo.mimetype,
      archivo.originalname,
    );

    return { tipo, mediaId, ruta, tamano: archivo.buffer.length };
  }
}
