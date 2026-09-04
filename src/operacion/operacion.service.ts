import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Asesor } from '../auth/auth.service';
import { DB, type Database } from '../db/db.module';
import { conversationTags, notes, tags, users } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';

const COLORES = ['slate', 'green', 'amber', 'red', 'sky', 'violet'] as const;

export type CategoriaCola =
  | 'sin_asignar'
  | 'total'
  | 'pendientes'
  | 'sin_leer'
  | 'sin_responder'
  | 'espera';

/**
 * El cliente escribió y nadie le contestó después.
 *
 * No es lo mismo que "sin leer": alguien pudo abrir el chat —borrando el
 * contador de no leídos— y aun así no responder nunca. Esas son las que se caen
 * del radar, porque para el equipo ya parecen atendidas.
 *
 * Los envíos fallidos no cuentan como respuesta: nunca llegaron.
 */
const SIN_RESPONDER = sql`
  c.estado <> 'resuelto'
  AND c.last_inbound_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages m
     WHERE m.conversation_id = c.id
       AND m.direccion = 'out'
       AND m.status <> 'failed'
       -- Los mensajes del bot van sin autor. Si contaran como respuesta, este
       -- numero quedaria en cero para siempre y taparia justo lo que sirve ver:
       -- que ninguna persona atendio al cliente.
       AND m.sent_by_user_id IS NOT NULL
       AND m.wa_timestamp > c.last_inbound_at
  )
`;

@Injectable()
export class OperacionService {
  private readonly log = new Logger(OperacionService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeGateway,
  ) {}

  // --- notas internas ------------------------------------------------------

  async notasDe(conversationId: string) {
    return this.db
      .select({
        id: notes.id,
        cuerpo: notes.cuerpo,
        tipo: notes.tipo,
        autor: users.nombre,
        autorId: notes.userId,
        cuando: notes.createdAt,
      })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.userId))
      .where(eq(notes.conversationId, conversationId))
      .orderBy(notes.createdAt);
  }

  async agregarNota(
    conversationId: string,
    cuerpo: string,
    asesor: Asesor,
    tipo: 'interna' | 'informacion' = 'interna',
  ) {
    const limpio = cuerpo?.trim();
    if (!limpio) throw new BadRequestException('la nota está vacía');

    if (tipo !== 'interna' && tipo !== 'informacion') {
      throw new BadRequestException('tipo de nota inválido');
    }

    const [fila] = await this.db
      .insert(notes)
      .values({ conversationId, userId: asesor.id, cuerpo: limpio, tipo })
      .returning();

    // Se avisa por el mismo canal que los mensajes: los demás asesores tienen
    // que ver la nota sin recargar, o dos van a escribir lo mismo.
    this.realtime.notaNueva(conversationId, {
      id: fila.id,
      cuerpo: fila.cuerpo,
      tipo: fila.tipo,
      autor: asesor.nombre,
      autorId: asesor.id,
      cuando: fila.createdAt,
    });

    return fila;
  }

  async borrarNota(id: string, asesor: Asesor) {
    // Un asesor sólo borra las propias; supervisores y admins, cualquiera.
    const condicion =
      asesor.rol === 'asesor'
        ? and(eq(notes.id, id), eq(notes.userId, asesor.id))
        : eq(notes.id, id);

    const filas = await this.db.delete(notes).where(condicion).returning();
    if (!filas.length) throw new BadRequestException('no existe o no es tuya');

    this.realtime.conversacionActualizada(filas[0].conversationId);
    return { ok: true };
  }

  // --- etiquetas -----------------------------------------------------------

  listarEtiquetas() {
    return this.db
      .select({ id: tags.id, nombre: tags.nombre, color: tags.color })
      .from(tags)
      .orderBy(tags.nombre);
  }

  async crearEtiqueta(nombre: string, color: string) {
    const limpio = nombre?.trim();
    if (!limpio) throw new BadRequestException('la etiqueta necesita un nombre');

    const [fila] = await this.db
      .insert(tags)
      .values({ nombre: limpio, color: COLORES.includes(color as any) ? color : 'slate' })
      .onConflictDoUpdate({ target: tags.nombre, set: { nombre: limpio } })
      .returning();

    return fila;
  }

  /**
   * Borra una etiqueta del catalogo y de todas las conversaciones que la tengan.
   *
   * Solo supervisores y admins: un asesor puede quitarle una etiqueta a SU
   * conversacion, pero borrar la etiqueta se la saca a todo el equipo de todas
   * las conversaciones a la vez, y eso no se deshace.
   */
  async borrarEtiqueta(tagId: string, asesor: Asesor) {
    if (asesor.rol === 'asesor') {
      throw new ForbiddenException('solo un supervisor puede borrar una etiqueta');
    }

    const [etiqueta] = await this.db
      .select({ id: tags.id, nombre: tags.nombre })
      .from(tags)
      .where(eq(tags.id, tagId))
      .limit(1);

    if (!etiqueta) throw new NotFoundException('esa etiqueta no existe');

    const quitadas = await this.db
      .delete(conversationTags)
      .where(eq(conversationTags.tagId, tagId))
      .returning({ id: conversationTags.conversationId });

    await this.db.delete(tags).where(eq(tags.id, tagId));

    this.log.log(`${asesor.email} borro la etiqueta "${etiqueta.nombre}" (${quitadas.length} usos)`);
    return { ok: true, quitadaDe: quitadas.length };
  }

  etiquetasDe(conversationId: string) {
    return this.db
      .select({ id: tags.id, nombre: tags.nombre, color: tags.color })
      .from(conversationTags)
      .innerJoin(tags, eq(tags.id, conversationTags.tagId))
      .where(eq(conversationTags.conversationId, conversationId))
      .orderBy(tags.nombre);
  }

  async etiquetar(conversationId: string, tagId: string, asesor: Asesor) {
    await this.db
      .insert(conversationTags)
      .values({ conversationId, tagId, userId: asesor.id })
      .onConflictDoNothing();

    this.realtime.conversacionActualizada(conversationId);
    return this.etiquetasDe(conversationId);
  }

  async desetiquetar(conversationId: string, tagId: string) {
    await this.db
      .delete(conversationTags)
      .where(
        and(
          eq(conversationTags.conversationId, conversationId),
          eq(conversationTags.tagId, tagId),
        ),
      );

    this.realtime.conversacionActualizada(conversationId);
    return this.etiquetasDe(conversationId);
  }

  // --- métricas ------------------------------------------------------------

  /**
   * Rendimiento por asesor en los últimos N días.
   *
   * El tiempo de primera respuesta es la métrica que de verdad importa en una
   * bandeja compartida: mide cuánto espera el cliente antes de que alguien le
   * conteste. Se calcula como la mediana, no el promedio: un solo caso olvidado
   * un fin de semana entero distorsiona cualquier promedio.
   */
  async rendimiento(dias = 7) {
    const { rows } = await this.db.execute<{
      id: string;
      nombre: string;
      atendidas: number;
      resueltas: number;
      enviados: number;
      medianaRespuestaSeg: number | null;
    }>(sql`
      WITH primeras AS (
        -- Para cada conversación: cuánto tardó el primer saliente después del
        -- primer entrante, y quién lo mandó.
        SELECT
          m.sent_by_user_id                                   AS user_id,
          m.conversation_id,
          EXTRACT(EPOCH FROM (m.wa_timestamp - c.created_at)) AS segundos
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direccion = 'out'
          AND m.sent_by_user_id IS NOT NULL
          AND m.status <> 'failed'
          AND m.wa_timestamp >= now() - make_interval(days => ${dias})
          AND m.wa_timestamp = (
            SELECT min(m2.wa_timestamp) FROM messages m2
             WHERE m2.conversation_id = m.conversation_id
               AND m2.direccion = 'out'
               AND m2.status <> 'failed'
          )
      )
      SELECT
        u.id,
        u.nombre,
        (SELECT count(DISTINCT e.conversation_id)::int FROM events e
          WHERE e.user_id = u.id
            AND e.tipo IN ('tomada', 'reasignada', 'ruteo_pegajoso', 'reparto_menor_carga')
            AND e.created_at >= now() - make_interval(days => ${dias}))   AS atendidas,
        (SELECT count(*)::int FROM events e
          WHERE e.user_id = u.id
            AND e.tipo = 'estado_cambiado'
            AND e.datos->>'estado' = 'resuelto'
            AND e.created_at >= now() - make_interval(days => ${dias}))   AS resueltas,
        (SELECT count(*)::int FROM messages m
          WHERE m.sent_by_user_id = u.id
            AND m.status <> 'failed'
            AND m.wa_timestamp >= now() - make_interval(days => ${dias})) AS enviados,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY p.segundos)
           FROM primeras p WHERE p.user_id = u.id)                        AS "medianaRespuestaSeg"
      FROM users u
      WHERE u.activo = true
      ORDER BY u.nombre
    `);

    return rows.map((r) => ({
      ...r,
      medianaRespuestaSeg:
        r.medianaRespuestaSeg === null ? null : Math.round(Number(r.medianaRespuestaSeg)),
    }));
  }

  /**
   * Quiénes están detrás de cada número del resumen.
   *
   * Un contador dice "hay 8 sin asignar" pero no cuáles, y con la cola creciendo
   * lo que el supervisor necesita es abrir la que lleva más esperando, no saber
   * que existen ocho.
   */
  async detalleCola(categoria: CategoriaCola) {
    const filtros: Record<CategoriaCola, ReturnType<typeof sql>> = {
      sin_asignar: sql`c.assigned_to IS NULL AND c.estado <> 'resuelto'`,
      // El total son todas las que siguen vivas: 'abierto' y 'pendiente'. Contar
      // solo las 'abierto' dejaba afuera trabajo que igual hay que hacer, y como
      // denominador de las demas no significaba nada.
      total: sql`c.estado <> 'resuelto'`,
      pendientes: sql`c.estado = 'pendiente'`,
      sin_leer: sql`c.unread_count > 0 AND c.estado <> 'resuelto'`,
      sin_responder: SIN_RESPONDER,
      espera: SIN_RESPONDER,
    };

    // En todas se ordena por quién espera hace más: es el orden en que conviene
    // atenderlas, no el alfabético ni el de llegada.
    const { rows } = await this.db.execute(sql`
      SELECT
        c.id,
        ct.nombre                       AS contacto,
        ct.wa_id                        AS telefono,
        c.estado,
        c.unread_count                  AS "sinLeer",
        u.nombre                        AS "asignadoNombre",
        c.last_inbound_at               AS "ultimoDelCliente",
        EXTRACT(EPOCH FROM (now() - c.last_inbound_at))::int AS "esperandoSeg",
        coalesce(c.window_expires_at > now(), false)         AS "ventanaAbierta"
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN users u ON u.id = c.assigned_to
      WHERE ${filtros[categoria]}
      ORDER BY c.last_inbound_at ASC NULLS LAST
      LIMIT 50
    `);

    return rows;
  }

  /** Estado de la cola, para saber si el equipo está dando abasto. */
  async resumen() {
    const { rows } = await this.db.execute<{
      sinAsignar: number;
      totalChats: number;
      pendientes: number;
      sinLeer: number;
      sinResponder: number;
      esperaMasVieja: number | null;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE c.assigned_to IS NULL AND c.estado <> 'resuelto')::int AS "sinAsignar",
        count(*) FILTER (WHERE c.estado <> 'resuelto')::int                            AS "totalChats",
        count(*) FILTER (WHERE c.estado = 'pendiente')::int                           AS pendientes,
        -- Conversaciones, no mensajes. Las cinco tarjetas tienen que contar la
        -- misma unidad: un "16" de mensajes al lado de un "12" de chats se lee
        -- como "16 de 12", y ademas no cuadraria con su propio desglose.
        count(*) FILTER (WHERE c.unread_count > 0 AND c.estado <> 'resuelto')::int     AS "sinLeer",
        count(*) FILTER (WHERE ${SIN_RESPONDER})::int                                  AS "sinResponder",
        -- La espera más vieja se mide sobre las sin responder, no sobre las sin
        -- leer: lo que le importa al cliente es que nadie le contestó.
        EXTRACT(EPOCH FROM (now() - min(c.last_inbound_at) FILTER (WHERE ${SIN_RESPONDER})))::int
                                                                                       AS "esperaMasVieja"
      FROM conversations c
    `);

    return rows[0];
  }
}
