import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { conversations, contacts, messages } from '../db/schema';
import { AlmacenService } from '../media/almacen.service';
import { GraphService } from '../whatsapp/graph.service';
import { OutboundService } from './outbound.service';

/**
 * Reenvía un mensaje a otra conversación.
 *
 * Sirve para lo de todos los días en el negocio: un cliente manda la foto de
 * una pieza rota y hay que pasársela al proveedor, o llega una cotización que
 * le sirve a otros tres que preguntaron lo mismo. Sin esto el asesor tiene que
 * bajar el archivo y volver a subirlo, chat por chat.
 *
 * No es un «forward» de WhatsApp: la Cloud API no lo tiene. Se manda el mismo
 * contenido como un mensaje nuevo, y queda marcado como reenviado de nuestro
 * lado para que en el hilo se entienda de dónde salió.
 */
@Injectable()
export class ReenvioService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly saliente: OutboundService,
    private readonly almacen: AlmacenService,
    private readonly graph: GraphService,
  ) {}

  async reenviar(messageId: string, aConversationId: string, userId: string) {
    const [original] = await this.db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!original) throw new NotFoundException('el mensaje no existe');
    if (original.eliminadoEn) {
      throw new BadRequestException('ese mensaje está eliminado de la bandeja');
    }
    if (original.conversationId === aConversationId) {
      throw new BadRequestException('ese mensaje ya está en esa conversación');
    }

    const [destino] = await this.db
      .select({ telefono: contacts.waId })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(conversations.id, aConversationId))
      .limit(1);

    if (!destino) throw new NotFoundException('la conversación de destino no existe');

    // `reenviado` viaja en raw y no en una columna: el hilo solo necesita saber
    // si mostrar la etiqueta, igual que ya hace con los mensajes del bot.
    const marca = { reenviado: true, reenviadoDe: original.id };

    if (original.tipo === 'location') {
      if (original.ubicacionLat == null || original.ubicacionLon == null) {
        throw new BadRequestException('esa ubicación no tiene coordenadas');
      }
      return this.saliente.enviarUbicacion({
        a: destino.telefono,
        latitud: original.ubicacionLat,
        longitud: original.ubicacionLon,
        userId,
        marca,
      });
    }

    if (original.mediaUrl) {
      const datos = await this.almacen.leerEntero(original.mediaUrl);
      if (!datos) {
        throw new BadRequestException(
          'el archivo ya no está guardado en el servidor y no se puede reenviar',
        );
      }

      const mime = original.mediaMime ?? 'application/octet-stream';
      const nombre = original.mediaNombre ?? 'archivo';

      // Se sube de nuevo y no se reusa el id anterior: el que devuelve Meta
      // vale 30 dias, y no lo guardamos. El archivo ya esta en el formato que
      // WhatsApp acepta —se convirtio al enviarlo o al recibirlo—, asi que
      // vuelve tal cual, sin recodificar.
      const mediaId = await this.graph.subirMedia(datos, mime, nombre);

      return this.saliente.enviarMedia({
        a: destino.telefono,
        tipo: original.tipo,
        mediaId,
        caption: original.caption ?? undefined,
        media: { url: original.mediaUrl, mime, nombre, tamano: datos.length },
        userId,
        marca,
      });
    }

    const texto = original.cuerpo?.trim();
    if (!texto) throw new BadRequestException('ese mensaje no tiene nada que reenviar');

    return this.saliente.enviarTexto({ a: destino.telefono, texto, userId, marca });
  }
}
