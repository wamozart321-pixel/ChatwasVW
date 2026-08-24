import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Asesor } from '../auth/auth.service';
import { env } from '../config/env';
import { DB, type Database } from '../db/db.module';
import { conversations, events, users } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/** Cada cuanto se revisa si hay conversaciones abandonadas. */
const INTERVALO_RESCATE_MS = 60_000;

@Injectable()
export class AsignacionService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(AsignacionService.name);
  private temporizador: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit() {
    if (env.RESCATE_MINUTOS <= 0) {
      this.log.log('rescate de conversaciones desactivado (RESCATE_MINUTOS=0)');
      return;
    }
    this.temporizador = setInterval(() => void this.rescatar(), INTERVALO_RESCATE_MS);
    this.temporizador.unref?.();
    this.log.log(`rescate activo: devuelve a la cola tras ${env.RESCATE_MINUTOS} min sin respuesta`);
  }

  onApplicationShutdown() {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  /**
   * Toma una conversacion libre.
   *
   * Todo el problema de 7 asesores sobre un mismo numero se resuelve en este
   * UPDATE: la condicion `assigned_to IS NULL` va DENTRO de la sentencia, asi
   * que Postgres serializa los intentos simultaneos y solo uno afecta filas.
   * Chequear antes y escribir despues dejaria una ventana de carrera.
   */
  async tomar(conversationId: string, asesor: Asesor) {
    const [fila] = await this.db
      .update(conversations)
      .set({
        assignedTo: asesor.id,
        assignedAt: sql`clock_timestamp()`,
        // Tomada a mano: el rescate no se la quita.
        asignadaAuto: false,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.assignedTo)))
      .returning();

    if (!fila) {
      const actual = await this.duenno(conversationId);
      if (!actual) throw new NotFoundException('conversacion inexistente');

      if (actual.id === asesor.id) return { ok: true, asesor: actual, yaEra: true };

      throw new ConflictException({
        error: 'ya_asignada',
        mensaje: `${actual.nombre} la tomó primero`,
        asesor: actual,
      });
    }

    await this.registrar(conversationId, asesor.id, 'tomada', {});
    this.realtime.conversacionActualizada(conversationId);
    this.log.log(`${asesor.nombre} tomó ${conversationId}`);

    return { ok: true, asesor: { id: asesor.id, nombre: asesor.nombre }, yaEra: false };
  }

  /** Devolverla a la cola. Solo el dueño, o un supervisor. */
  async soltar(conversationId: string, asesor: Asesor) {
    const puedeCualquiera = asesor.rol !== 'asesor';

    const [fila] = await this.db
      .update(conversations)
      .set({ assignedTo: null, assignedAt: null, asignadaAuto: false, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(conversations.id, conversationId),
          puedeCualquiera ? sql`true` : eq(conversations.assignedTo, asesor.id),
        ),
      )
      .returning();

    if (!fila) throw new ForbiddenException('no es tuya, no la podés soltar');

    await this.registrar(conversationId, asesor.id, 'soltada', {});
    this.realtime.conversacionActualizada(conversationId);

    return { ok: true };
  }

  /** Pasarsela a otro asesor. Un asesor solo puede ceder las propias. */
  async asignar(conversationId: string, destinoId: string, quien: Asesor) {
    const [destino] = await this.db
      .select({ id: users.id, nombre: users.nombre, activo: users.activo })
      .from(users)
      .where(eq(users.id, destinoId))
      .limit(1);

    if (!destino?.activo) throw new NotFoundException('asesor destino inexistente o inactivo');

    const puedeCualquiera = quien.rol !== 'asesor';

    const [fila] = await this.db
      .update(conversations)
      .set({
        assignedTo: destinoId,
        assignedAt: sql`clock_timestamp()`,
        asignadaAuto: false,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(conversations.id, conversationId),
          puedeCualquiera
            ? sql`true`
            : sql`(${conversations.assignedTo} = ${quien.id} OR ${conversations.assignedTo} IS NULL)`,
        ),
      )
      .returning();

    if (!fila) throw new ForbiddenException('solo podés ceder conversaciones tuyas');

    await this.registrar(conversationId, quien.id, 'reasignada', {
      destinoId,
      destinoNombre: destino.nombre,
    });

    this.realtime.asignadaA(destinoId, conversationId, quien.nombre);
    this.realtime.conversacionActualizada(conversationId);
    this.log.log(`${quien.nombre} asignó ${conversationId} a ${destino.nombre}`);

    return { ok: true, asesor: { id: destino.id, nombre: destino.nombre } };
  }

  /**
   * Decide quien atiende un mensaje entrante. Dos reglas, en este orden:
   *
   *  1. Pegajoso: si el cliente ya hablo con alguien, vuelve con esa persona.
   *     Para asesoria es lo que corresponde: el cliente no quiere re-explicar
   *     su caso, y quien lo atendio ya tiene el contexto.
   *
   *  2. Menor carga: cliente nuevo -> al asesor conectado con menos encima.
   *     Se auto-balancea sin llevar cuenta de turnos, y quien se desconecta
   *     deja de recibir sin que nadie tenga que tocar nada.
   *
   * Si ninguna aplica, queda en 'Sin asignar' para que la tome quien pueda.
   */
  async rutearEntrante(contactId: string, conversationId: string): Promise<void> {
    const [conv] = await this.db
      .select({ assignedTo: conversations.assignedTo })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv || conv.assignedTo) return; // ya tiene dueno

    // --- 1. pegajoso ---
    const previo = await this.asesorPrevio(contactId, conversationId);

    if (previo) {
      const motivo = await this.porQueNoPuede(previo);
      if (!motivo) {
        if (await this.asignarAuto(conversationId, previo, 'ruteo_pegajoso', {})) return;
      } else {
        this.log.debug(`pegajoso omitido (${motivo}); se reparte por carga`);
      }
    }

    // --- 2. menor carga ---
    if (!env.AUTO_ASIGNAR) return;

    const elegido = await this.deMenorCarga();
    if (!elegido) {
      this.log.debug('sin asesores disponibles: queda en la cola');
      return;
    }

    await this.asignarAuto(conversationId, elegido.id, 'reparto_menor_carga', {
      carga: elegido.activas,
    });
  }

  /**
   * true si el cliente ya tiene asesor y ese asesor puede retomarlo ahora.
   *
   * Lo consulta el bot: a un cliente conocido cuyo asesor esta disponible no
   * tiene sentido hacerlo pasar otra vez por el menu. Que te pregunten de cero
   * lo que ya contaste es la peor parte de cualquier bot.
   */
  async puedeRetomarConSuAsesor(contactId: string, conversationId: string): Promise<boolean> {
    const previo = await this.asesorPrevio(contactId, conversationId);
    if (!previo) return false;
    return (await this.porQueNoPuede(previo)) === null;
  }

  /** Ultimo asesor que atendio a este contacto, en otra conversacion. */
  private async asesorPrevio(contactId: string, exceptoId: string): Promise<string | null> {
    const [previa] = await this.db
      .select({ asesorId: conversations.assignedTo })
      .from(conversations)
      .where(
        and(
          eq(conversations.contactId, contactId),
          ne(conversations.id, exceptoId),
          sql`${conversations.assignedTo} IS NOT NULL`,
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);

    return previa?.asesorId ?? null;
  }

  /** null si puede recibir; si no, el motivo, para poder loguearlo. */
  private async porQueNoPuede(asesorId: string): Promise<string | null> {
    if (!this.realtime.estaConectado(asesorId)) return 'no esta conectado';

    const carga = await this.cargaDe(asesorId);
    if (carga >= env.MAX_CONVERSACIONES_POR_ASESOR) return `esta al tope (${carga})`;

    return null;
  }

  /**
   * Asesor conectado con menos conversaciones activas.
   *
   * Solo rol 'asesor': supervisores y admins no entran al reparto automatico,
   * pero pueden tomar a mano lo que quieran. El desempate es aleatorio para no
   * favorecer siempre al mismo cuando varios estan en cero.
   *
   * OJO CON MULTI-INSTANCIA: la presencia vive en la memoria de este proceso.
   * Si se corren dos instancias contra la misma base, el worker que procese un
   * webhook puede no ser el que tiene los sockets de los asesores, y va a creer
   * que no hay nadie conectado. Para escalar horizontalmente hace falta el
   * adaptador de Redis de socket.io, que comparte las salas entre instancias.
   */
  private async deMenorCarga(): Promise<{ id: string; activas: number } | null> {
    const conectados = this.realtime.conectados();
    if (conectados.length === 0) return null;

    // ARRAY[$1, $2, ...] en vez de pasar el array de JS directo: Drizzle lo
    // expande como ANY(($1, $2)), que es un constructor de fila y no un array,
    // y la consulta falla.
    const lista = sql.join(
      conectados.map((id) => sql`${id}`),
      sql`, `,
    );

    const { rows } = await this.db.execute<{ id: string; activas: number }>(sql`
      SELECT u.id, count(c.id)::int AS activas
        FROM users u
        LEFT JOIN conversations c
          ON c.assigned_to = u.id
         AND c.estado <> 'resuelto'
       WHERE u.activo = true
         AND u.rol = 'asesor'
         AND u.id = ANY(ARRAY[${lista}]::uuid[])
       GROUP BY u.id
      HAVING count(c.id) < ${env.MAX_CONVERSACIONES_POR_ASESOR}
       ORDER BY count(c.id) ASC, random()
       LIMIT 1
    `);

    return rows[0] ?? null;
  }

  /**
   * Asignacion hecha por el sistema. Marca asignada_auto para que el rescate
   * sepa que puede devolverla; lo que alguien tomo a mano no se toca.
   *
   * @returns false si en el intervalo alguien la tomo a mano: se respeta.
   */
  private async asignarAuto(
    conversationId: string,
    asesorId: string,
    tipo: string,
    datos: Record<string, unknown>,
  ): Promise<boolean> {
    const [fila] = await this.db
      .update(conversations)
      .set({
        assignedTo: asesorId,
        assignedAt: sql`clock_timestamp()`,
        asignadaAuto: true,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.assignedTo)))
      .returning();

    if (!fila) return false;

    await this.registrar(conversationId, asesorId, tipo, datos);
    this.realtime.asignadaA(asesorId, conversationId, null);
    this.realtime.conversacionActualizada(conversationId);
    this.log.log(`${tipo}: ${conversationId}`);

    return true;
  }

  /**
   * Devuelve a la cola lo que el sistema asigno y nadie contesto a tiempo.
   *
   * Sin esto, un asesor conectado que se fue a almorzar es peor que nadie: la
   * conversacion figura atendida, no aparece en 'Sin asignar', y el cliente
   * espera sin que nadie la vea.
   *
   * Solo alcanza a las automaticas y a las que siguen con mensajes sin leer.
   */
  async rescatar(): Promise<number> {
    if (env.RESCATE_MINUTOS <= 0) return 0;

    try {
      const { rows } = await this.db.execute<{ id: string; anterior: string }>(sql`
        WITH abandonadas AS (
          SELECT c.id, c.assigned_to
            FROM conversations c
           WHERE c.asignada_auto = true
             AND c.assigned_to IS NOT NULL
             AND c.estado <> 'resuelto'
             AND c.unread_count > 0
             AND c.assigned_at < now() - make_interval(mins => ${env.RESCATE_MINUTOS})
             -- Contesto = una PERSONA mando algo despues de que se la asignaron.
             -- Los mensajes del bot van sin autor: si contaran, una conversacion
             -- que solo recibio el menu automatico nunca volveria a la cola.
             AND NOT EXISTS (
               SELECT 1 FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.direccion = 'out'
                  AND m.sent_by_user_id IS NOT NULL
                  AND m.wa_timestamp > c.assigned_at
             )
           FOR UPDATE SKIP LOCKED
        )
        UPDATE conversations
           SET assigned_to = NULL,
               assigned_at = NULL,
               asignada_auto = false,
               updated_at = now()
          FROM abandonadas a
         WHERE conversations.id = a.id
        RETURNING conversations.id, a.assigned_to AS anterior
      `);

      for (const fila of rows) {
        await this.registrar(fila.id, fila.anterior, 'rescatada', {
          minutos: env.RESCATE_MINUTOS,
        });
        this.realtime.conversacionActualizada(fila.id);
      }

      if (rows.length) {
        this.log.log(`${rows.length} conversacion(es) devueltas a la cola por falta de respuesta`);
      }

      return rows.length;
    } catch (e) {
      // El rescate corre en un intervalo: un fallo no debe tumbar el proceso.
      this.log.error(`fallo el rescate: ${(e as Error).message}`);
      return 0;
    }
  }

  /** Conversaciones sin resolver que tiene encima un asesor. */
  async cargaDe(asesorId: string): Promise<number> {
    const [fila] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(and(eq(conversations.assignedTo, asesorId), ne(conversations.estado, 'resuelto')));

    return fila?.n ?? 0;
  }

  /**
   * Panel del supervisor: quién tiene cuánto encima y quién está conectado.
   *
   * SQL explícito con alias, a propósito. Drizzle decide si califica los nombres
   * de columna según cuántas tablas ve en el FROM, y dentro de una subconsulta
   * correlacionada eso produce `WHERE "assigned_to" = "id"`, que se resuelve
   * contra la tabla equivocada y devuelve cero sin dar error.
   */
  async cargaDelEquipo() {
    const { rows } = await this.db.execute<{
      id: string;
      nombre: string;
      rol: string;
      activas: number;
      sinLeer: number;
    }>(sql`
      SELECT
        u.id,
        u.nombre,
        u.rol,
        count(c.id)::int                            AS activas,
        coalesce(sum(c.unread_count), 0)::int       AS "sinLeer"
      FROM users u
      LEFT JOIN conversations c
        ON c.assigned_to = u.id
       AND c.estado <> 'resuelto'
      WHERE u.activo = true
      GROUP BY u.id, u.nombre, u.rol
      ORDER BY u.nombre
    `);

    const conectados = new Set(this.realtime.conectados());

    return rows.map((f) => ({
      ...f,
      conectado: conectados.has(f.id),
      tope: env.MAX_CONVERSACIONES_POR_ASESOR,
    }));
  }

  private async duenno(conversationId: string) {
    const [fila] = await this.db
      .select({ id: users.id, nombre: users.nombre })
      .from(conversations)
      .leftJoin(users, eq(users.id, conversations.assignedTo))
      .where(eq(conversations.id, conversationId))
      .limit(1);

    return fila?.id ? { id: fila.id, nombre: fila.nombre! } : null;
  }

  /** Toda asignación queda auditada: es lo único que responde "¿quién la tenía?". */
  private registrar(
    conversationId: string,
    userId: string,
    tipo: string,
    datos: Record<string, unknown>,
  ) {
    return this.db.insert(events).values({ conversationId, userId, tipo, datos });
  }
}
