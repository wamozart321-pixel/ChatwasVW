import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Asesor } from '../auth/auth.service';
import { DB, type Database } from '../db/db.module';
import { contacts, conversations, events, messages, users } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GraphService } from '../whatsapp/graph.service';

/**
 * Que muestra cada solapa de la bandeja.
 *
 * "Abierto" NO es simplemente `estado = 'abierto'`. Una conversacion recien
 * llegada tambien esta abierta, pero todavia no la miro nadie: mezclarla con
 * las que el asesor ya leyo y esta trabajando hace que la solapa no signifique
 * nada. Lo que separa a una de la otra es el contador de sin leer, que es el
 * globito que el asesor ve en la lista.
 *
 *   Sin leer  algo llego y nadie lo abrio todavia
 *   Abierto   ya se leyo, se esta atendiendo
 *   Pendiente esperando al proveedor, o que el cliente decida
 *   Resuelto  terminado
 *   Activas   todo lo que no esta resuelto: la bandeja de trabajo
 */
function condicionDeVista(vista: string): SQL {
  switch (vista) {
    case 'sin_leer':
      // Tambien las pendientes: si el cliente escribe, hay que volver a mirarla.
      return sql`c.unread_count > 0 AND c.estado <> 'resuelto'`;

    case 'abierto':
      return sql`c.estado = 'abierto' AND c.unread_count = 0`;

    case 'pendiente':
      return sql`c.estado = 'pendiente'`;

    case 'resuelto':
      return sql`c.estado = 'resuelto'`;

    case 'todas':
      return sql`true`;

    // 'activas' y cualquier cosa rara: la bandeja de trabajo.
    default:
      return sql`c.estado <> 'resuelto'`;
  }
}

export interface FilaBandeja {
  id: string;
  estado: string;
  contacto: string | null;
  telefono: string;
  noLeidos: number;
  ultimoMensaje: string | null;
  ventanaVence: string | null;
  ventanaAbierta: boolean;
  vistaPrevia: string | null;
  vistaPreviaDireccion: string | null;
  vistaPreviaEstado: string | null;
  asignadoId: string | null;
  asignadoNombre: string | null;
  etiquetas: { nombre: string; color: string }[];
}

const PAGINA = 40;

@Injectable()
export class BandejaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly graph: GraphService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Lista de chats. El LATERAL trae el ultimo mensaje de cada hilo en una sola
   * consulta: sin eso serian N+1 queries para pintar la columna del medio.
   */
  async listar(opciones: {
    estado?: string;
    busqueda?: string;
    asignado?: string;
    etiqueta?: string;
    asesorId: string;
    /** La que el asesor tiene abierta: viene igual aunque deje de calzar en la solapa. */
    incluir?: string;
  }): Promise<FilaBandeja[]> {
    const vista = opciones.estado ?? 'activas';
    const abierta = opciones.incluir?.trim() || null;
    const busqueda = opciones.busqueda?.trim() || null;
    const etiqueta = opciones.etiqueta?.trim() || null;
    // 'mios' y 'sin_asignar' son las dos vistas que un asesor usa todo el día.
    const soloMios = opciones.asignado === 'mios';
    const soloLibres = opciones.asignado === 'sin_asignar';

    const { rows } = await this.db.execute(sql`
      SELECT
        c.id,
        c.estado,
        ct.nombre                      AS contacto,
        ct.wa_id                       AS telefono,
        c.unread_count                 AS "noLeidos",
        c.last_message_at              AS "ultimoMensaje",
        c.window_expires_at            AS "ventanaVence",
        coalesce(c.window_expires_at > now(), false) AS "ventanaAbierta",
        m.cuerpo                       AS "vistaPrevia",
        m.direccion                    AS "vistaPreviaDireccion",
        m.status                       AS "vistaPreviaEstado",
        c.assigned_to                  AS "asignadoId",
        u.nombre                       AS "asignadoNombre",
        -- Las etiquetas se agregan acá y no con otra consulta: en la lista sirven
        -- para triage, y traerlas aparte serían N+1 peticiones.
        coalesce((
          SELECT json_agg(json_build_object('nombre', t.nombre, 'color', t.color)
                          ORDER BY t.nombre)
            FROM conversation_tags ct
            JOIN tags t ON t.id = ct.tag_id
           WHERE ct.conversation_id = c.id
        ), '[]'::json)                 AS etiquetas
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN users u ON u.id = c.assigned_to
      LEFT JOIN LATERAL (
        -- Un mensaje eliminado no puede seguir siendo la vista previa del chat.
        SELECT cuerpo, direccion, status
          FROM messages
         WHERE conversation_id = c.id
           AND eliminado_en IS NULL
         ORDER BY wa_timestamp DESC, id DESC
         LIMIT 1
      ) m ON true
      WHERE (
              ${condicionDeVista(vista)}
              -- La conversacion abierta se queda aunque deje de calzar. Sin
              -- esto, en "Sin leer" el chat desaparecia debajo del asesor:
              -- abrirlo lo marca como leido, deja de ser "sin leer", y el hilo
              -- se cerraba solo en el momento en que se iba a contestar.
              OR (${abierta}::uuid IS NOT NULL AND c.id = ${abierta}::uuid)
            )
        AND (${busqueda}::text IS NULL
             OR ct.nombre ILIKE '%' || ${busqueda} || '%'
             OR ct.wa_id  ILIKE '%' || ${busqueda} || '%')
        AND (NOT ${soloMios}   OR c.assigned_to = ${opciones.asesorId})
        AND (NOT ${soloLibres} OR c.assigned_to IS NULL)
        -- EXISTS y no un JOIN: con JOIN, una conversación con varias etiquetas
        -- saldría repetida en la lista.
        AND (${etiqueta}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM conversation_tags ct2
           WHERE ct2.conversation_id = c.id
             AND ct2.tag_id = ${etiqueta}::uuid
        ))
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 100
    `);

    // execute() devuelve filas sin tipar; el cast se hace aca, en el unico borde
    // donde la forma la define el SELECT de arriba.
    return rows as unknown as FilaBandeja[];
  }

  async detalle(id: string) {
    const [fila] = await this.db
      .select({
        id: conversations.id,
        estado: conversations.estado,
        contacto: contacts.nombre,
        telefono: contacts.waId,
        noLeidos: conversations.unreadCount,
        ventanaVence: conversations.windowExpiresAt,
        ventanaAbierta: sql<boolean>`coalesce(${conversations.windowExpiresAt} > now(), false)`,
        creada: conversations.createdAt,
        ultimoEntrante: conversations.lastInboundAt,
        // Alias explícito: sin él, Drizzle puede emitir la columna sin calificar y
        // la subconsulta se correlaciona contra la tabla equivocada, en silencio.
        totalMensajes: sql<number>`(
          SELECT count(*)::int FROM messages m WHERE m.conversation_id = conversations.id
        )`,
        asignadoId: conversations.assignedTo,
        asignadoNombre: users.nombre,
        asignadaEn: conversations.assignedAt,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(users, eq(users.id, conversations.assignedTo))
      .where(eq(conversations.id, id))
      .limit(1);

    if (!fila) throw new NotFoundException('conversacion inexistente');
    return fila;
  }

  /**
   * Cuantas conversaciones hay en cada estado.
   *
   * Va aparte de la lista porque la lista viene filtrada por estado: si se
   * contara sobre ella, "Abierto" siempre diria el total de abiertas y nunca
   * se sabria cuantas pendientes o resueltas hay del otro lado.
   *
   * Respeta el resto de los filtros —de quien es, etiqueta, busqueda— para que
   * los numeros sean de lo que el asesor esta mirando.
   */
  async conteoPorEstado(params: {
    asesor: Asesor;
    asignado?: string;
    q?: string;
    etiqueta?: string;
  }) {
    const condiciones = [sql`c.estado IS NOT NULL`];

    if (params.asignado === 'mios') condiciones.push(sql`c.assigned_to = ${params.asesor.id}`);
    if (params.asignado === 'sin_asignar') condiciones.push(sql`c.assigned_to IS NULL`);

    if (params.q?.trim()) {
      const like = `%${params.q.trim()}%`;
      condiciones.push(sql`(ct.nombre ILIKE ${like} OR ct.wa_id ILIKE ${like})`);
    }

    if (params.etiqueta) {
      condiciones.push(sql`EXISTS (
        SELECT 1 FROM conversation_tags ce JOIN tags t ON t.id = ce.tag_id
         WHERE ce.conversation_id = c.id AND t.id = ${params.etiqueta}
      )`);
    }

    // Se cuenta con las MISMAS condiciones que usa la lista: si se escribieran
    // aparte, el numero del filtro y lo que muestra al hacer clic se irian
    // separando sin que nadie lo note.
    const base = sql.join(condiciones, sql` AND `);
    const vistas = ['sin_leer', 'abierto', 'pendiente', 'resuelto', 'activas', 'todas'];

    const columnas = vistas.map(
      (v) => sql`count(*) FILTER (WHERE ${condicionDeVista(v)})::int AS ${sql.raw(`"${v}"`)}`,
    );

    const { rows } = await this.db.execute<Record<string, number>>(sql`
      SELECT ${sql.join(columnas, sql`, `)}
        FROM conversations c
        JOIN contacts ct ON ct.id = c.contact_id
       WHERE ${base}
    `);

    return rows[0] ?? Object.fromEntries(vistas.map((v) => [v, 0]));
  }

  /** Hilo paginado hacia atras: `antesDe` es el wa_timestamp del mas viejo ya cargado. */
  async hilo(conversationId: string, antesDe?: string) {
    const filtro = antesDe
      ? and(
          eq(messages.conversationId, conversationId),
          lt(messages.waTimestamp, new Date(antesDe)),
        )
      : eq(messages.conversationId, conversationId);

    const filas = await this.db
      .select({
        id: messages.id,
        waMessageId: messages.waMessageId,
        direccion: messages.direccion,
        tipo: messages.tipo,
        // El contenido de un eliminado no se manda al cliente aunque siga en la
        // base: queda para auditoría, no para volver a mostrarlo.
        cuerpo: sql<string | null>`CASE WHEN ${messages.eliminadoEn} IS NULL THEN ${messages.cuerpo} END`,
        caption: sql<string | null>`CASE WHEN ${messages.eliminadoEn} IS NULL THEN ${messages.caption} END`,
        mediaMime: sql<string | null>`CASE WHEN ${messages.eliminadoEn} IS NULL THEN ${messages.mediaMime} END`,
        mediaNombre: messages.mediaNombre,
        mediaTamano: messages.mediaTamano,
        /** Sólo si el archivo ya está en disco: el front decide si pinta la imagen. */
        tieneMedia: sql<boolean>`${messages.mediaUrl} IS NOT NULL AND ${messages.eliminadoEn} IS NULL`,
        status: messages.status,
        /** Coordenadas si es un mensaje de ubicación; el hilo arma el enlace al mapa. */
        ubicacionLat: sql<number | null>`CASE WHEN ${messages.eliminadoEn} IS NULL THEN ${messages.ubicacionLat} END`,
        ubicacionLon: sql<number | null>`CASE WHEN ${messages.eliminadoEn} IS NULL THEN ${messages.ubicacionLon} END`,
        /** Quién lo envió: el front lo necesita para saber si puede eliminarlo. */
        enviadoPorId: messages.sentByUserId,
        /**
         * Los mensajes del bot van sin autor y con raw.bot. El asesor tiene que
         * poder distinguirlos: no es lo mismo leer un hilo donde contestó una
         * persona que uno donde contestó el menú automático.
         */
        esBot: sql<boolean>`coalesce((${messages.raw} ->> 'bot')::boolean, false)`,
        errorMessage: sql<string | null>`CASE WHEN ${messages.eliminadoEn} IS NULL THEN ${messages.errorMessage} END`,
        cuando: messages.waTimestamp,
        eliminado: sql<boolean>`${messages.eliminadoEn} IS NOT NULL`,
        eliminadoPor: sql<string | null>`(
          SELECT u.nombre FROM users u WHERE u.id = ${messages.eliminadoPor}
        )`,
      })
      .from(messages)
      .where(filtro)
      .orderBy(desc(messages.waTimestamp))
      .limit(PAGINA);

    // Se consulta en orden inverso para paginar, se devuelve cronologico.
    return filas.reverse();
  }

  /**
   * El asesor abrio el chat: se limpian los no leidos y se manda el check azul
   * a WhatsApp. Deliberadamente NO se hace al recibir el mensaje: el cliente
   * ve "leido" cuando alguien de verdad lo leyo.
   */
  async marcarLeida(conversationId: string) {
    const [ultimo] = await this.db
      .select({ waMessageId: messages.waMessageId })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direccion, 'in')))
      .orderBy(desc(messages.waTimestamp))
      .limit(1);

    const [conv] = await this.db
      .update(conversations)
      .set({ unreadCount: 0, updatedAt: sql`clock_timestamp()` })
      .where(eq(conversations.id, conversationId))
      .returning();

    if (!conv) throw new NotFoundException('conversacion inexistente');

    if (ultimo?.waMessageId) {
      // No se espera: que el check azul tarde no debe frenar la UI.
      void this.graph.marcarLeido(ultimo.waMessageId);
    }

    this.realtime.conversacionActualizada(conversationId);
    return { ok: true };
  }

  /**
   * Saca un mensaje de la bandeja. Borrado lógico: el cuerpo queda en la base.
   *
   * NO lo borra del teléfono del cliente: la Cloud API de WhatsApp no permite
   * revocar un mensaje entregado. Lo único que cambia es lo que ve el equipo,
   * y el front tiene que decirlo con todas las letras.
   */
  async eliminarMensaje(messageId: string, asesor: Asesor) {
    const [mensaje] = await this.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        direccion: messages.direccion,
        status: messages.status,
        sentByUserId: messages.sentByUserId,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), isNull(messages.eliminadoEn)))
      .limit(1);

    if (!mensaje) throw new NotFoundException('el mensaje no existe o ya fue eliminado');

    // Un asesor puede sacar los entrantes y los que mandó él; los de otros, no.
    // Supervisores y admins pueden con cualquiera.
    const propio = mensaje.direccion === 'in' || mensaje.sentByUserId === asesor.id;
    if (asesor.rol === 'asesor' && !propio) {
      throw new ForbiddenException('sólo podés eliminar mensajes entrantes o tuyos');
    }

    await this.db
      .update(messages)
      .set({ eliminadoEn: sql`clock_timestamp()`, eliminadoPor: asesor.id, updatedAt: sql`clock_timestamp()` })
      .where(eq(messages.id, messageId));

    await this.db.insert(events).values({
      conversationId: mensaje.conversationId,
      userId: asesor.id,
      tipo: 'mensaje_eliminado',
      datos: { messageId, direccion: mensaje.direccion, status: mensaje.status },
    });

    this.realtime.mensajeEliminado(mensaje.conversationId, messageId, asesor.nombre);
    this.realtime.conversacionActualizada(mensaje.conversationId);

    return { ok: true, llegoAlCliente: mensaje.status !== 'failed' };
  }

  async cambiarEstado(
    conversationId: string,
    estado: 'abierto' | 'pendiente' | 'resuelto',
    asesorId: string,
  ) {
    const [conv] = await this.db
      .update(conversations)
      .set({ estado, updatedAt: sql`clock_timestamp()` })
      .where(eq(conversations.id, conversationId))
      .returning();

    if (!conv) throw new NotFoundException('conversacion inexistente');

    await this.db.insert(events).values({
      conversationId,
      userId: asesorId,
      tipo: 'estado_cambiado',
      datos: { estado },
    });

    this.realtime.conversacionActualizada(conversationId);
    return { ok: true, estado };
  }
}
