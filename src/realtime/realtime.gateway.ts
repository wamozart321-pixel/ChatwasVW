import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthService, type Asesor } from '../auth/auth.service';
import { aVistaDeMensaje } from '../api/mensaje.vista';

/** Sala a la que se suscriben todos: cambios que afectan la lista de chats. */
const BANDEJA = 'bandeja';

/** Un "está escribiendo" caduca solo: si el asesor cierra la pestaña, se limpia. */
const ESCRIBIENDO_MS = 6000;

interface SocketAsesor extends Socket {
  data: { asesor?: Asesor };
}

/**
 * Empuja los cambios a los asesores conectados y lleva la presencia.
 *
 * Con 7 personas sobre un mismo numero, sin esto dos asesores ven estados
 * distintos de la misma conversacion. El servidor es la unica fuente de verdad
 * y avisa; el cliente nunca hace polling.
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  pingInterval: 20_000,
  pingTimeout: 20_000,
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Prefijo de la sala personal de cada asesor. */
  private static readonly SALA_ASESOR = 'asesor:';

  /** conversationId -> asesorId -> timeout de expiracion del "escribiendo". */
  private readonly escribiendo = new Map<string, Map<string, NodeJS.Timeout>>();

  constructor(private readonly auth: AuthService) {}

  async handleConnection(cliente: SocketAsesor) {
    const token = cliente.handshake.auth?.token;

    let asesor: Asesor;
    try {
      asesor = await this.auth.desdeToken(String(token ?? ''));
    } catch {
      this.log.warn(`conexion rechazada: token invalido (${cliente.id})`);
      cliente.emit('no-autorizado');
      cliente.disconnect(true);
      return;
    }

    // Validar el token es asincrono: el cliente pudo haberse ido mientras tanto.
    // Si se fue, handleDisconnect ya corrio y unirlo ahora dejaria un fantasma
    // conectado para siempre — y el ruteo le mandaria clientes a quien no esta.
    if (cliente.disconnected) return;

    cliente.data.asesor = asesor;
    void cliente.join(BANDEJA);
    void cliente.join(RealtimeGateway.SALA_ASESOR + asesor.id);

    this.difundirPresencia();
    this.log.debug(`${asesor.nombre} conectado (${cliente.id})`);
  }

  handleDisconnect(cliente: SocketAsesor) {
    const asesor = cliente.data.asesor;
    if (!asesor) return;

    this.limpiarEscribiendoDe(asesor.id);
    // socket.io ya lo sacó de sus salas, así que difundir refleja el estado real.
    this.difundirPresencia();
  }

  /** El cliente avisa que abrio una conversacion, para recibir su hilo. */
  @SubscribeMessage('ver')
  ver(@ConnectedSocket() cliente: SocketAsesor, @MessageBody() conversationId: string) {
    for (const sala of cliente.rooms) {
      if (sala.startsWith('conv:')) void cliente.leave(sala);
    }
    if (conversationId) void cliente.join(`conv:${conversationId}`);
  }

  @SubscribeMessage('escribiendo')
  marcarEscribiendo(
    @ConnectedSocket() cliente: SocketAsesor,
    @MessageBody() conversationId: string,
  ) {
    const asesor = cliente.data.asesor;
    if (!asesor || !conversationId) return;

    const porConversacion = this.escribiendo.get(conversationId) ?? new Map();
    clearTimeout(porConversacion.get(asesor.id));

    porConversacion.set(
      asesor.id,
      setTimeout(() => this.dejarDeEscribir(conversationId, asesor.id), ESCRIBIENDO_MS),
    );
    this.escribiendo.set(conversationId, porConversacion);

    // Solo a los demas: nadie necesita verse escribir a si mismo.
    cliente.to(`conv:${conversationId}`).emit('escribiendo', {
      conversationId,
      asesor: { id: asesor.id, nombre: asesor.nombre },
    });
  }

  @SubscribeMessage('dejar-de-escribir')
  pararEscribiendo(
    @ConnectedSocket() cliente: SocketAsesor,
    @MessageBody() conversationId: string,
  ) {
    const asesor = cliente.data.asesor;
    if (asesor && conversationId) this.dejarDeEscribir(conversationId, asesor.id);
  }

  private dejarDeEscribir(conversationId: string, asesorId: string) {
    const porConversacion = this.escribiendo.get(conversationId);
    if (!porConversacion?.has(asesorId)) return;

    clearTimeout(porConversacion.get(asesorId));
    porConversacion.delete(asesorId);
    if (porConversacion.size === 0) this.escribiendo.delete(conversationId);

    this.server
      .to(`conv:${conversationId}`)
      .emit('dejo-de-escribir', { conversationId, asesorId });
  }

  private limpiarEscribiendoDe(asesorId: string) {
    for (const [conversationId, porConversacion] of this.escribiendo) {
      if (porConversacion.has(asesorId)) this.dejarDeEscribir(conversationId, asesorId);
    }
  }

  // --- consultas usadas por el ruteo ---------------------------------------

  /**
   * La presencia se deriva de las salas de socket.io, no de un mapa propio.
   *
   * Un mapa paralelo se desincroniza: basta una desconexion durante la
   * validacion del token, o un proceso que muere sin avisar, para dejar a
   * alguien "conectado" indefinidamente. Las salas son la fuente de verdad y
   * socket.io las mantiene, incluso cuando la conexion se corta de golpe.
   */
  estaConectado(asesorId: string): boolean {
    const sala = this.server.sockets.adapter.rooms.get(
      RealtimeGateway.SALA_ASESOR + asesorId,
    );
    return (sala?.size ?? 0) > 0;
  }

  /**
   * true si alguien tiene ese hilo abierto en pantalla ahora mismo.
   *
   * Se deriva de la sala `conv:<id>`, por lo mismo que la presencia: es la
   * unica fuente que no se desincroniza cuando un navegador se cierra de golpe.
   */
  alguienMirando(conversationId: string): boolean {
    return (this.server.sockets.adapter.rooms.get(`conv:${conversationId}`)?.size ?? 0) > 0;
  }

  conectados(): string[] {
    const ids: string[] = [];
    for (const [sala, sockets] of this.server.sockets.adapter.rooms) {
      if (sala.startsWith(RealtimeGateway.SALA_ASESOR) && sockets.size > 0) {
        ids.push(sala.slice(RealtimeGateway.SALA_ASESOR.length));
      }
    }
    return ids;
  }

  // --- emisores, usados por los servicios -----------------------------------

  /**
   * Empuja un mensaje al hilo abierto.
   *
   * La fila se traduce ACA y no en cada llamador: antes cada uno mandaba la
   * fila cruda de la base, que tiene otra forma que la del hilo (`waTimestamp`
   * contra `cuando`), y todo mensaje que llegaba en vivo se pintaba con la
   * fecha en "Invalid Date" y sin la foto hasta recargar. Con la traduccion en
   * un solo lugar, ningun llamador nuevo puede volver a olvidarse.
   */
  mensajeNuevo(conversationId: string, mensaje: unknown) {
    this.server.to(`conv:${conversationId}`).emit('mensaje:nuevo', {
      conversationId,
      mensaje: aVistaDeMensaje(mensaje as Record<string, unknown>),
    });
  }

  /**
   * Cualquier cambio que altere la lista: no leidos, estado, asignacion.
   * Viaja solo el id y el front refresca la lista: asi la forma de la fila se
   * define en un unico lugar (BandejaService.listar) y no puede desincronizarse.
   */
  conversacionActualizada(conversationId: string) {
    this.server.to(BANDEJA).emit('conversacion:actualizada', { conversationId });
  }

  estadoDeMensaje(conversationId: string, waMessageId: string, status: string) {
    this.server
      .to(`conv:${conversationId}`)
      .emit('mensaje:estado', { conversationId, waMessageId, status });
  }

  /**
   * La descarga del archivo termino: el hilo ya pinto el mensaje sin imagen y
   * con esto la reemplaza sin recargar.
   */
  mediaLista(conversationId: string, messageId: string, mediaUrl: string) {
    this.server
      .to(`conv:${conversationId}`)
      .emit('mensaje:media', { conversationId, messageId, mediaUrl });
  }

  /** Un mensaje salio de la bandeja: los demas tienen que dejar de verlo ya. */
  mensajeEliminado(conversationId: string, messageId: string, porNombre: string) {
    this.server
      .to(`conv:${conversationId}`)
      .emit('mensaje:eliminado', { conversationId, messageId, por: porNombre });
  }

  /** Nota interna nueva: la ven todos los que tengan el hilo abierto. */
  notaNueva(conversationId: string, nota: unknown) {
    this.server.to(`conv:${conversationId}`).emit('nota:nueva', { conversationId, nota });
  }

  /** Aviso directo: "te asignaron esta conversacion". */
  asignadaA(asesorId: string, conversationId: string, porNombre: string | null) {
    this.server.to(RealtimeGateway.SALA_ASESOR + asesorId).emit('conversacion:asignada', {
      conversationId,
      por: porNombre,
    });
  }

  private difundirPresencia() {
    this.server.to(BANDEJA).emit('presencia', { conectados: this.conectados() });
  }
}
