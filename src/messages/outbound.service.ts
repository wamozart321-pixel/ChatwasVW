import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ConversationsService,
  normalizarTelefono,
} from '../conversations/conversations.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GraphError, GraphService } from '../whatsapp/graph.service';
import { MessagesService } from './messages.service';

@Injectable()
export class OutboundService {
  private readonly log = new Logger(OutboundService.name);

  constructor(
    private readonly graph: GraphService,
    private readonly conversaciones: ConversationsService,
    private readonly mensajes: MessagesService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Texto libre. Solo valido dentro de la ventana de 24h; fuera de ella Meta
   * rechaza el envio, asi que lo cortamos antes de gastar la llamada.
   */
  async enviarTexto(params: {
    a: string;
    texto: string;
    userId?: string | null;
    previewUrl?: boolean;
  }) {
    const waId = normalizarTelefono(params.a);
    if (waId.length < 8) throw new BadRequestException('numero invalido');
    if (!params.texto.trim()) throw new BadRequestException('texto vacio');
    if (params.texto.length > 4096) {
      throw new BadRequestException('el limite de WhatsApp es 4096 caracteres');
    }

    const contacto = await this.conversaciones.asegurarContacto(waId);
    const conversacion = await this.conversaciones.vivaDelContacto(contacto.id);

    if (!conversacion || !this.conversaciones.ventanaAbierta(conversacion.windowExpiresAt)) {
      throw new UnprocessableEntityException({
        error: 'ventana_cerrada',
        mensaje:
          'Pasaron mas de 24h desde el ultimo mensaje del cliente. Solo se puede enviar una plantilla aprobada.',
        windowExpiresAt: conversacion?.windowExpiresAt ?? null,
      });
    }

    return this.despachar({
      conversationId: conversacion.id,
      tipo: 'text',
      cuerpo: params.texto,
      userId: params.userId ?? null,
      enviar: () => this.graph.enviarTexto(waId, params.texto, params.previewUrl ?? true),
    });
  }

  /**
   * Manda una ubicacion. Al cliente le llega un mapa que puede tocar para
   * abrirlo en su aplicacion y trazar la ruta hasta el local.
   */
  async enviarUbicacion(params: {
    a: string;
    latitud: number;
    longitud: number;
    nombre?: string;
    direccion?: string;
    userId?: string | null;
  }) {
    const waId = normalizarTelefono(params.a);
    if (waId.length < 8) throw new BadRequestException('numero invalido');

    if (
      !Number.isFinite(params.latitud) ||
      !Number.isFinite(params.longitud) ||
      Math.abs(params.latitud) > 90 ||
      Math.abs(params.longitud) > 180
    ) {
      throw new BadRequestException('coordenadas invalidas');
    }

    const contacto = await this.conversaciones.asegurarContacto(waId);
    const conversacion = await this.conversaciones.vivaDelContacto(contacto.id);

    if (!conversacion || !this.conversaciones.ventanaAbierta(conversacion.windowExpiresAt)) {
      throw new UnprocessableEntityException({
        error: 'ventana_cerrada',
        mensaje:
          'Pasaron mas de 24h desde el ultimo mensaje del cliente. Solo se puede enviar una plantilla aprobada.',
        windowExpiresAt: conversacion?.windowExpiresAt ?? null,
      });
    }

    // El cuerpo guarda la etiqueta legible: es lo que se busca desde la bandeja
    // y lo que se ve en la vista previa de la lista, donde un par de numeros
    // no le dice nada a nadie.
    const etiqueta =
      [params.nombre, params.direccion].filter(Boolean).join(' - ') ||
      `${params.latitud}, ${params.longitud}`;

    return this.despachar({
      conversationId: conversacion.id,
      tipo: 'location',
      cuerpo: etiqueta,
      userId: params.userId ?? null,
      ubicacionLat: params.latitud,
      ubicacionLon: params.longitud,
      enviar: () =>
        this.graph.enviarUbicacion(waId, {
          latitud: params.latitud,
          longitud: params.longitud,
          nombre: params.nombre,
          direccion: params.direccion,
        }),
    });
  }

  /**
   * Envía un archivo ya subido a Meta. Como el texto libre, sólo dentro de la
   * ventana de 24 h: fuera de ella WhatsApp únicamente acepta plantillas.
   */
  async enviarMedia(params: {
    a: string;
    tipo: string;
    mediaId: string;
    caption?: string;
    media: { url: string; mime: string; nombre: string; tamano: number };
    userId?: string | null;
  }) {
    const waId = normalizarTelefono(params.a);
    if (waId.length < 8) throw new BadRequestException('numero invalido');

    const contacto = await this.conversaciones.asegurarContacto(waId);
    const conversacion = await this.conversaciones.vivaDelContacto(contacto.id);

    if (!conversacion || !this.conversaciones.ventanaAbierta(conversacion.windowExpiresAt)) {
      throw new UnprocessableEntityException({
        error: 'ventana_cerrada',
        mensaje:
          'Pasaron más de 24 h desde el último mensaje del cliente. Sólo se puede enviar una plantilla aprobada.',
        windowExpiresAt: conversacion?.windowExpiresAt ?? null,
      });
    }

    return this.despachar({
      conversationId: conversacion.id,
      tipo: params.tipo,
      cuerpo: params.caption ?? params.media.nombre,
      userId: params.userId ?? null,
      media: params.media,
      enviar: () =>
        this.graph.enviarMedia(waId, params.tipo, params.mediaId, {
          caption: params.caption,
          filename: params.media.nombre,
        }),
    });
  }

  /** Plantilla aprobada: la unica via valida fuera de la ventana de 24h. */
  async enviarPlantilla(params: {
    a: string;
    nombre: string;
    idioma?: string;
    componentes?: unknown[];
    userId?: string | null;
    /** Texto ya resuelto, para que el hilo muestre lo que el cliente va a leer. */
    textoPrevio?: string;
  }) {
    const waId = normalizarTelefono(params.a);
    if (waId.length < 8) throw new BadRequestException('numero invalido');

    const contacto = await this.conversaciones.asegurarContacto(waId);
    const conversacion = await this.conversaciones.asegurarConversacion(contacto.id);
    const idioma = params.idioma ?? 'es';

    return this.despachar({
      conversationId: conversacion.id,
      tipo: 'template',
      cuerpo: params.textoPrevio ?? `[plantilla: ${params.nombre}]`,
      userId: params.userId ?? null,
      raw: { nombre: params.nombre, idioma, componentes: params.componentes ?? [] },
      enviar: () =>
        this.graph.enviarPlantilla(waId, params.nombre, idioma, params.componentes ?? []),
    });
  }

  /**
   * Fila optimista -> llamada a Meta -> confirmacion.
   * Se persiste ANTES de llamar para que la bandeja pueda pintar el mensaje al
   * instante (paso 2) y para que un envio fallido quede registrado, no perdido.
   */
  private async despachar(params: {
    conversationId: string;
    tipo: string;
    cuerpo: string;
    userId: string | null;
    raw?: Record<string, unknown>;
    media?: { url: string; mime: string; nombre: string; tamano: number };
    ubicacionLat?: number;
    ubicacionLon?: number;
    enviar: () => Promise<string>;
  }) {
    const fila = await this.mensajes.crearSalientePendiente({
      conversationId: params.conversationId,
      tipo: params.tipo,
      cuerpo: params.cuerpo,
      sentByUserId: params.userId,
      raw: params.raw,
      mediaUrl: params.media?.url,
      mediaMime: params.media?.mime,
      mediaNombre: params.media?.nombre,
      mediaTamano: params.media?.tamano,
      ubicacionLat: params.ubicacionLat,
      ubicacionLon: params.ubicacionLon,
    });

    try {
      const waMessageId = await params.enviar();
      const confirmado = await this.mensajes.confirmarEnviado(fila.id, waMessageId);
      await this.conversaciones.marcarSalienteEn(params.conversationId);

      this.realtime.mensajeNuevo(params.conversationId, confirmado);
      this.realtime.conversacionActualizada(params.conversationId);

      this.log.log(`saliente ${params.tipo} -> ${waMessageId}`);
      return confirmado;
    } catch (e) {
      const err = e as GraphError;
      const fallido = await this.mensajes.marcarFallido(fila.id, {
        code: err.code,
        message: err.detalle ? `${err.message} | ${err.detalle}` : err.message,
      });
      // Se empuja la fila YA marcada, no la de antes del error: si no, el
      // mensaje aparece en rojo pero sin decir por que fallo.
      this.realtime.mensajeNuevo(params.conversationId, fallido ?? { ...fila, status: 'failed' });
      this.realtime.conversacionActualizada(params.conversationId);

      this.log.error(`envio fallido (${err.code ?? '?'}): ${err.message}`);
      throw e;
    }
  }
}
