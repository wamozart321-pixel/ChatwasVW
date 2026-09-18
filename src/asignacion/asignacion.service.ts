import {
  BadRequestException,
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
import { ActividadService } from '../db/actividad.service';
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
    private readonly actividad: ActividadService,
  ) {}

  onModuleInit() {
    if (env.RESCATE_MINUTOS <= 0) {
      this.log.log('rescate de conversaciones desactivado (RESCATE_MINUTOS=0)');
      return;
    }
    this.temporizador = setInterval(() => void this.rescatarSiHaceFalta(), INTERVALO_RESCATE_MS);
    this.temporizador.unref?.();
    this.log.log(`rescate activo: devuelve a la cola tras ${env.RESCATE_MINUTOS} min sin respuesta`);
  }

  onApplicationShutdown() {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  /**
   * La vuelta de cada minuto, sólo si hubo actividad.
   *
   * Sin nadie escribiendo y sin asesores trabajando no puede haber una conversación
   * recién asignada que rescatar, así que no hace falta preguntarle a la base: esa
   * pregunta, cada minuto, era la mitad de lo que no la dejaba dormir.
   *
   * Si el rescate movió algo cuenta como actividad: la conversación vuelve a la
   * cola y puede asignarse de nuevo, y eso hay que seguirlo mirando.
   */
  private async rescatarSiHaceFalta() {
    if (!this.actividad.reciente()) return;
    if ((await this.rescatar()) > 0) this.actividad.marcar();
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
    const destino = await this.destinoActivo(destinoId);

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
   * Reparto a mano: las `cantidad` que más esperan en la cola, a un asesor.
   *
   * Pasar un chat puntual ya se podía (asignar); lo que faltaba era repartir la
   * cola de a varios: "dale cinco a Andrés". El reparto automático no alcanza
   * cuando el supervisor sabe algo que el sistema no —quién está libre de verdad,
   * quién conoce a esos clientes—, y hacerlo de a un chat con la cola llena es
   * medio minuto de clics.
   *
   * Toma la cola igual que la ve el supervisor en Métricas → Sin asignar: sin
   * dueño, no resuelta, y la que más espera primero. Si el número del panel y lo
   * que se reparte salieran de criterios distintos, no cuadrarían.
   *
   * Todo en un UPDATE con SKIP LOCKED: si mientras tanto un asesor toma uno, o el
   * ruteo le asigna otro, ése se saltea y no queda con dos dueños. Por eso puede
   * asignar menos de las pedidas, y lo dice.
   *
   * El evento va a nombre de quien RECIBE, como el reparto automático: las
   * métricas cuentan las atendidas por el usuario del evento, y a nombre del
   * supervisor le sumarían a él las cinco y al asesor ninguna.
   */
  async asignarDeLaCola(destinoId: string, cantidad: number, quien: Asesor) {
    if (quien.rol === 'asesor') {
      throw new ForbiddenException('sólo un supervisor o el administrador reparten la cola');
    }
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {
      throw new BadRequestException('la cantidad va de 1 a 50');
    }

    const destino = await this.destinoActivo(destinoId);

    const { rows } = await this.db.execute<{ id: string }>(sql`
      UPDATE conversations c
         SET assigned_to = ${destinoId},
             assigned_at = clock_timestamp(),
             -- A mano: el rescate no se las quita por no contestar en 5 min.
             asignada_auto = false,
             updated_at = clock_timestamp()
       WHERE c.id IN (
               SELECT id FROM conversations
                WHERE assigned_to IS NULL AND estado <> 'resuelto'
                ORDER BY last_inbound_at ASC NULLS LAST
                LIMIT ${cantidad}
                FOR UPDATE SKIP LOCKED
             )
         AND c.assigned_to IS NULL
      RETURNING c.id
    `);

    for (const { id } of rows) {
      await this.registrar(id, destinoId, 'reparto_manual', {
        porId: quien.id,
        porNombre: quien.nombre,
      });
      this.realtime.conversacionActualizada(id);
    }

    // Un solo aviso con la cantidad: cinco notificaciones seguidas en el
    // escritorio del asesor se leen como un error, no como trabajo nuevo.
    if (rows.length) {
      this.realtime.asignadaA(destinoId, rows[0]!.id, quien.nombre, rows.length);
    }

    const [{ quedan }] = (
      await this.db.execute<{ quedan: number }>(sql`
        SELECT count(*)::int AS quedan FROM conversations
         WHERE assigned_to IS NULL AND estado <> 'resuelto'`)
    ).rows;

    this.log.log(`${quien.nombre} le repartió ${rows.length} de la cola a ${destino.nombre}`);

    return {
      asignadas: rows.length,
      pedidas: cantidad,
      quedanEnCola: quedan,
      asesor: { id: destino.id, nombre: destino.nombre },
    };
  }

  /**
   * Reparto a mano de un cliente puntual: la otra opción del panel de Equipo.
   *
   * Pasar un chat ya se podía desde el chat mismo; desde el panel faltaba, y es
   * donde hace falta: el supervisor está repartiendo, elige al asesor, busca al
   * cliente y se lo da, sin ir y volver entre pantallas.
   *
   * Si la conversación estaba resuelta —los clientes importados del celular lo
   * están todos— se reabre. Asignada pero resuelta no le aparecería al asesor
   * entre sus activas: quedaría a su nombre sin que nadie se enterara.
   *
   * Mismo criterio que el reparto de la cola: el evento va a nombre de quien
   * recibe, queda como asignación a mano (el rescate no se la quita) y le llega un
   * aviso.
   */
  async asignarCliente(conversationId: string, destinoId: string, quien: Asesor) {
    if (quien.rol === 'asesor') {
      throw new ForbiddenException('sólo un supervisor o el administrador reparten clientes');
    }

    const destino = await this.destinoActivo(destinoId);

    let filas: { id: string; estaba: string }[];
    try {
      // `antes` guarda el estado previo: el UPDATE lo cambia, y hay que saber si
      // se reabrió para decirlo y dejarlo en la historia.
      ({ rows: filas } = await this.db.execute<{ id: string; estaba: string }>(sql`
        WITH antes AS (
          SELECT id, estado FROM conversations WHERE id = ${conversationId} FOR UPDATE
        )
        UPDATE conversations c
           SET assigned_to = ${destinoId},
               assigned_at = clock_timestamp(),
               asignada_auto = false,
               estado = CASE WHEN c.estado = 'resuelto' THEN 'abierto' ELSE c.estado END,
               updated_at = clock_timestamp()
          FROM antes
         WHERE c.id = antes.id
        RETURNING c.id, antes.estado AS estaba
      `));
    } catch (e) {
      // El índice que deja una sola conversación viva por cliente: ésta es una
      // resuelta vieja y el cliente ya tiene otra abierta. Hay que asignar esa.
      const err = e as { code?: string; cause?: { code?: string } };
      if ((err.code ?? err.cause?.code) === '23505') {
        throw new ConflictException({
          error: 'ya_tiene_viva',
          mensaje: 'ese cliente ya tiene otra conversación abierta: asigná esa',
        });
      }
      throw e;
    }

    if (!filas.length) throw new NotFoundException('conversacion inexistente');
    const reabierta = filas[0]!.estaba === 'resuelto';

    await this.registrar(conversationId, destinoId, 'reparto_manual', {
      porId: quien.id,
      porNombre: quien.nombre,
      reabierta,
    });
    if (reabierta) {
      await this.registrar(conversationId, quien.id, 'estado_cambiado', { estado: 'abierto' });
    }

    this.realtime.asignadaA(destinoId, conversationId, quien.nombre);
    this.realtime.conversacionActualizada(conversationId);
    this.log.log(`${quien.nombre} le dio a ${destino.nombre} la conversación ${conversationId}`);

    return { ok: true, reabierta, asesor: { id: destino.id, nombre: destino.nombre } };
  }

  /** El asesor al que se le asigna algo: tiene que existir y estar activo. */
  private async destinoActivo(destinoId: string) {
    const [destino] = await this.db
      .select({ id: users.id, nombre: users.nombre, activo: users.activo })
      .from(users)
      .where(eq(users.id, destinoId))
      .limit(1);

    if (!destino?.activo) throw new NotFoundException('asesor destino inexistente o inactivo');
    return destino;
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
  /**
   * Devuelve a la cola todo lo que tenga un asesor encima.
   *
   * Se usa al darlo de baja. Sin esto, sus conversaciones quedan a nombre de
   * alguien que ya no puede entrar: el cliente escribe, nadie lo ve, y no
   * aparece en la cola de nadie porque figura como asignada.
   */
  async liberarTodasDe(asesorId: string): Promise<number> {
    const filas = await this.db
      .update(conversations)
      .set({
        assignedTo: null,
        assignedAt: null,
        asignadaAuto: false,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(conversations.assignedTo, asesorId), ne(conversations.estado, 'resuelto')))
      .returning({ id: conversations.id });

    for (const f of filas) this.realtime.conversacionActualizada(f.id);

    if (filas.length) {
      this.log.log(`${filas.length} conversaciones devueltas a la cola al dar de baja a un asesor`);
    }

    return filas.length;
  }

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

  /**
   * Qué conversaciones tiene un asesor encima, no sólo cuántas.
   *
   * El número solo no alcanza para supervisar: «Yeiner tiene 12» no dice si son
   * doce que avanzan o doce olvidadas desde ayer. Con la lista se ve cuál es
   * cuál y se puede entrar a mirarla.
   *
   * Se ordena por el último mensaje del cliente, más viejo primero: arriba
   * queda lo que lleva más tiempo esperando respuesta, que es lo que un
   * supervisor está buscando.
   */
  async conversacionesDe(asesorId: string) {
    const { rows } = await this.db.execute<{
      id: string;
      contacto: string | null;
      telefono: string;
      estado: string;
      sinLeer: number;
      ultimoDelCliente: string | null;
    }>(sql`
      SELECT
        c.id,
        ct.nombre                AS contacto,
        ct.wa_id                 AS telefono,
        c.estado,
        c.unread_count           AS "sinLeer",
        c.last_inbound_at        AS "ultimoDelCliente"
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.assigned_to = ${asesorId}
        AND c.estado <> 'resuelto'
      ORDER BY c.last_inbound_at ASC NULLS LAST
    `);

    return rows;
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
