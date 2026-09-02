import { Injectable, Logger } from '@nestjs/common';
import { AsignacionService } from '../asignacion/asignacion.service';
import { BotService } from '../bot/bot.service';
import { ConversationsService } from '../conversations/conversations.service';
import { extraerContenido, fechaDeMeta } from '../messages/contenido';
import { MediaService } from '../media/media.service';
import { MessagesService } from '../messages/messages.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GraphService } from './graph.service';
import type { WaMensaje, WaValue, WaWebhookPayload } from './webhook.types';

/**
 * Traduce un payload de webhook a filas nuestras.
 * Todo aqui debe ser idempotente: Meta reenvia el mismo evento varias veces.
 */
@Injectable()
export class InboundService {
  private readonly log = new Logger(InboundService.name);

  constructor(
    private readonly conversaciones: ConversationsService,
    private readonly mensajes: MessagesService,
    private readonly realtime: RealtimeGateway,
    private readonly asignacion: AsignacionService,
    private readonly media: MediaService,
    private readonly bot: BotService,
    private readonly graph: GraphService,
  ) {}

  async procesar(payload: WaWebhookPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') {
          // account_update, message_template_status_update, phone_number_quality_update...
          this.log.debug(`campo de webhook ignorado: ${change.field}`);
          continue;
        }
        await this.procesarValue(change.value);
      }
    }
  }

  private async procesarValue(value: WaValue): Promise<void> {
    // El nombre de perfil viene aparte de los mensajes, indexado por wa_id.
    const nombres = new Map<string, string | undefined>();
    for (const c of value.contacts ?? []) nombres.set(c.wa_id, c.profile?.name);

    for (const m of value.messages ?? []) {
      try {
        await this.procesarMensaje(m, nombres.get(m.from));
      } catch (e) {
        this.log.error(`fallo procesando mensaje ${m.id}: ${(e as Error).message}`);
        throw e;
      }
    }

    for (const s of value.statuses ?? []) {
      const aplicado = await this.mensajes.actualizarEstado(s.id, s.status, s.errors?.[0]);
      if (!aplicado) {
        // Normal: estado fuera de orden, o eco de un envio hecho desde otra herramienta.
        this.log.debug(`estado '${s.status}' sin efecto sobre ${s.id}`);
        continue;
      }
      this.realtime.estadoDeMensaje(aplicado.conversationId, s.id, s.status);
      this.realtime.conversacionActualizada(aplicado.conversationId);
    }

    for (const e of value.errors ?? []) {
      this.log.error(`error a nivel de cuenta [${e.code}] ${e.title ?? e.message}`);
    }
  }

  private async procesarMensaje(m: WaMensaje, nombrePerfil?: string): Promise<void> {
    const cuando = fechaDeMeta(m.timestamp);
    const contenido = extraerContenido(m);

    const contacto = await this.conversaciones.asegurarContacto(m.from, nombrePerfil);
    const conversacion = await this.conversaciones.registrarEntrante(contacto.id, cuando);

    // El cliente respondio citando algo nuestro: Meta manda el wamid del
    // mensaje citado y hay que traducirlo a nuestra fila para poder dibujar la
    // cita en el hilo.
    const citado = m.context?.id ? await this.mensajes.porWamid(m.context.id) : null;

    const guardado = await this.mensajes.guardarEntrante({
      conversationId: conversacion.id,
      waMessageId: m.id,
      tipo: contenido.tipo,
      cuerpo: contenido.cuerpo,
      caption: contenido.caption,
      mediaId: contenido.mediaId,
      mediaMime: contenido.mediaMime,
      ubicacionLat: contenido.ubicacionLat,
      ubicacionLon: contenido.ubicacionLon,
      waTimestamp: cuando,
      raw: m as unknown as Record<string, unknown>,
      respondeA: citado?.id ?? null,
    });

    if (!guardado) {
      this.log.debug(`duplicado ignorado: ${m.id}`);
      return;
    }

    // Solo suma al contador si nadie tiene el hilo abierto. Si el asesor lo
    // esta mirando, el mensaje ya esta leido: marcarlo como pendiente le deja
    // un globito que no se va con hacer clic, porque ya estaba parado ahi.
    if (this.realtime.alguienMirando(conversacion.id)) {
      void this.graph.marcarLeido(m.id); // check azul, igual que al abrir el chat
    } else {
      await this.conversaciones.sumarNoLeido(conversacion.id);
    }

    // El mensaje se empuja apenas está guardado, antes del bot: el bot le habla
    // a Meta y esa llamada tarda un par de segundos. Dejarla en el medio hacía
    // que el asesor viera lo que le escribió el cliente recién cuando el bot
    // terminaba de contestarle.
    // Con la cita ya resuelta: si no, una respuesta del cliente llega al hilo
    // sin el renglon que dice a que estaba contestando.
    this.realtime.mensajeNuevo(conversacion.id, {
      ...guardado,
      citado: await this.mensajes.resumenCitado(citado?.id),
    });

    // El bot primero: mientras esté recolectando datos no tiene sentido
    // asignarle la conversación a un asesor, porque el cliente todavía está
    // contestando preguntas y el asesor no tendría nada que hacer.
    const { atendio } = await this.bot.procesar({
      conversationId: conversacion.id,
      contactId: contacto.id,
      telefono: m.from,
      texto: contenido.cuerpo ?? '',
      botonId: m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id,
    });

    // Ruteo pegajoso: si el cliente ya habló con alguien, vuelve con esa persona.
    // Va antes de refrescar la lista para que la bandeja llegue con el dueño puesto.
    if (!atendio) await this.asignacion.rutearEntrante(contacto.id, conversacion.id);

    this.realtime.conversacionActualizada(conversacion.id);

    // La URL que da Meta vence a los ~5 min: hay que bajarlo ahora, no despues.
    if (contenido.mediaId) {
      await this.media.descargarEntrante({
        messageId: guardado.id,
        conversationId: conversacion.id,
        mediaId: contenido.mediaId,
        mime: contenido.mediaMime,
        nombre: (m as any)[m.type]?.filename ?? null,
      });
    }

    this.log.log(
      `entrante ${contenido.tipo} de ${nombrePerfil ?? m.from} -> conv ${conversacion.id}`,
    );

    // NOTA: el check azul se manda cuando un asesor ABRE el chat, no al recibir.
    // Se conecta en el paso 2 (bandeja) con GraphService.marcarLeido().
  }
}
