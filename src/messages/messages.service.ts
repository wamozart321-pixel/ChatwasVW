import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { CitaDeMensaje } from '../api/mensaje.vista';
import { DB, type Database } from '../db/db.module';
import { messages, RANGO_ESTADO, type EstadoMensaje } from '../db/schema';
import type { WaError } from '../whatsapp/webhook.types';

export interface EntranteAGuardar {
  conversationId: string;
  waMessageId: string;
  tipo: string;
  cuerpo: string | null;
  caption: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  ubicacionLat: number | null;
  ubicacionLon: number | null;
  waTimestamp: Date;
  raw: Record<string, unknown>;
  /** Nuestra fila del mensaje citado, ya resuelta desde el wamid de Meta. */
  respondeA?: string | null;
}

@Injectable()
export class MessagesService {
  private readonly log = new Logger(MessagesService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Guarda un entrante. Devuelve null si ya existia.
   * El UNIQUE sobre wa_message_id es lo que hace idempotente el reintento de Meta.
   */
  async guardarEntrante(datos: EntranteAGuardar) {
    const [fila] = await this.db
      .insert(messages)
      .values({
        conversationId: datos.conversationId,
        waMessageId: datos.waMessageId,
        direccion: 'in',
        tipo: datos.tipo,
        cuerpo: datos.cuerpo,
        caption: datos.caption,
        mediaId: datos.mediaId,
        mediaMime: datos.mediaMime,
        ubicacionLat: datos.ubicacionLat,
        ubicacionLon: datos.ubicacionLon,
        status: 'delivered',
        statusRank: RANGO_ESTADO.delivered,
        waTimestamp: datos.waTimestamp,
        raw: datos.raw,
        respondeA: datos.respondeA ?? null,
      })
      .onConflictDoNothing({ target: messages.waMessageId })
      .returning();

    return fila ?? null;
  }

  /**
   * Nuestra fila a partir del wamid de Meta.
   *
   * Se usa cuando el cliente responde citando: el webhook trae el wamid del
   * mensaje citado y hay que saber cual es de los nuestros. Puede no estar —una
   * conversacion mas vieja que la instalacion, o un mensaje que se mando desde
   * el telefono— y entonces la respuesta se guarda sin cita.
   */
  async porWamid(waMessageId: string): Promise<{ id: string } | null> {
    const [fila] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.waMessageId, waMessageId))
      .limit(1);

    return fila ?? null;
  }

  /**
   * El resumen del mensaje citado, con la forma que espera el hilo.
   *
   * Hace falta porque el hilo lo trae en su SELECT pero los avisos en vivo
   * mandan la fila cruda: sin esto, una respuesta recien enviada aparece sin la
   * cita hasta que el asesor recarga.
   */
  async resumenCitado(id: string | null | undefined): Promise<CitaDeMensaje | null> {
    if (!id) return null;

    const [fila] = await this.db
      .select({
        id: messages.id,
        direccion: messages.direccion,
        tipo: messages.tipo,
        cuerpo: sql<
          string | null
        >`CASE WHEN ${messages.eliminadoEn} IS NULL THEN ${messages.cuerpo} END`,
        autor: sql<string | null>`(
          SELECT u.nombre FROM users u WHERE u.id = ${messages.sentByUserId}
        )`,
      })
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1);

    return fila ?? null;
  }

  /** Fila optimista para un saliente, antes de que Meta confirme. */
  async crearSalientePendiente(datos: {
    conversationId: string;
    tipo: string;
    cuerpo: string | null;
    sentByUserId?: string | null;
    raw?: Record<string, unknown>;
    mediaUrl?: string | null;
    mediaMime?: string | null;
    mediaNombre?: string | null;
    mediaTamano?: number | null;
    ubicacionLat?: number | null;
    ubicacionLon?: number | null;
    respondeA?: string | null;
  }) {
    const [fila] = await this.db
      .insert(messages)
      .values({
        conversationId: datos.conversationId,
        direccion: 'out',
        tipo: datos.tipo,
        cuerpo: datos.cuerpo,
        status: 'queued',
        statusRank: RANGO_ESTADO.queued,
        sentByUserId: datos.sentByUserId ?? null,
        // Reloj de Postgres y no el del proceso: el hilo mezcla tres fuentes de
        // hora (Meta para los entrantes, la base para las notas, el servidor
        // para los salientes) y basta con que el reloj del servidor este unos
        // segundos corrido para que los mensajes se ordenen mal entre si. La
        // base es el unico reloj que todas las filas comparten.
        waTimestamp: sql`clock_timestamp()`,
        raw: datos.raw ?? null,
        mediaUrl: datos.mediaUrl ?? null,
        mediaMime: datos.mediaMime ?? null,
        mediaNombre: datos.mediaNombre ?? null,
        mediaTamano: datos.mediaTamano ?? null,
        ubicacionLat: datos.ubicacionLat ?? null,
        ubicacionLon: datos.ubicacionLon ?? null,
        respondeA: datos.respondeA ?? null,
      })
      .returning();

    return fila;
  }

  /**
   * El wamid de un mensaje nuestro, para poder citarlo.
   *
   * Devuelve null si no existe, si es de otra conversacion o si todavia no
   * tiene wamid —un saliente que Meta no confirmo—. En los tres casos la
   * respuesta sale igual, sin cita: perder la cita es molesto, no poder
   * contestarle al cliente lo es mucho mas.
   */
  async wamidParaCitar(id: string, conversationId: string): Promise<string | null> {
    const [fila] = await this.db
      .select({ waMessageId: messages.waMessageId })
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.conversationId, conversationId)))
      .limit(1);

    return fila?.waMessageId ?? null;
  }

  async confirmarEnviado(id: string, waMessageId: string) {
    const [fila] = await this.db
      .update(messages)
      .set({
        waMessageId,
        status: 'sent',
        statusRank: RANGO_ESTADO.sent,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(messages.id, id))
      .returning();

    return fila;
  }

  /** Devuelve la fila ya con el motivo: es lo que se empuja al hilo abierto. */
  async marcarFallido(id: string, error: { code?: number; message: string }) {
    const [fila] = await this.db
      .update(messages)
      .set({
        status: 'failed',
        errorCode: error.code ?? null,
        errorMessage: error.message.slice(0, 1000),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(messages.id, id))
      .returning();

    return fila;
  }

  /**
   * Aplica un webhook de estado. Los estados solo avanzan: si llega 'delivered'
   * despues de 'read' (pasa seguido), se ignora. 'failed' es terminal y siempre entra.
   */
  async actualizarEstado(waMessageId: string, estado: EstadoMensaje, error?: WaError) {
    const rango = RANGO_ESTADO[estado];

    const condicion =
      estado === 'failed'
        ? eq(messages.waMessageId, waMessageId)
        : and(eq(messages.waMessageId, waMessageId), lt(messages.statusRank, rango));

    const filas = await this.db
      .update(messages)
      .set({
        status: estado,
        statusRank: rango,
        ...(error
          ? {
              errorCode: error.code ?? null,
              errorMessage: (error.error_data?.details ?? error.title ?? error.message ?? '')
                .slice(0, 1000),
            }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(condicion)
      .returning({ id: messages.id, conversationId: messages.conversationId });

    return filas[0] ?? null;
  }
}
