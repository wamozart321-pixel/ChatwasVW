import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AsignacionService } from '../asignacion/asignacion.service';
import { env } from '../config/env';
import { DB, type Database } from '../db/db.module';
import { contacts, conversations, notes } from '../db/schema';
import { MessagesService } from '../messages/messages.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { GraphService } from '../whatsapp/graph.service';
import {
  MAX_INTENTOS,
  despedida,
  noEntendi,
  opcionElegida,
  pideHumano,
  preguntaDe,
  resumenParaAsesor,
  saludo,
  type Paso,
  type Pregunta,
} from './flujo';
import { estaAbierto, parsearFranja, proximaApertura, type Horario } from './horario';

/** Cada cuanto se revisa si hay alguien esperando a mitad del flujo. */
const INTERVALO_REVISION_MS = 60_000;

/** Lo que el motor le devuelve al worker. */
export interface ResultadoBot {
  /** true si el bot contestó: la conversación no debe rutearse todavía. */
  atendio: boolean;
}

@Injectable()
export class BotService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(BotService.name);
  private readonly horario: Horario;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly graph: GraphService,
    private readonly mensajes: MessagesService,
    private readonly realtime: RealtimeGateway,
    private readonly asignacion: AsignacionService,
  ) {
    const semana = parsearFranja(env.HORARIO_LUNES_VIERNES);
    this.horario = {
      zona: env.ZONA_HORARIA,
      porDia: [
        parsearFranja(env.HORARIO_DOMINGO),
        semana,
        semana,
        semana,
        semana,
        semana,
        parsearFranja(env.HORARIO_SABADO),
      ],
    };
  }

  private temporizador: NodeJS.Timeout | null = null;

  onModuleInit() {
    if (!env.BOT_ACTIVO || env.BOT_ESPERA_MINUTOS === 0) return;

    this.temporizador = setInterval(() => void this.revisarAbandonadas(), INTERVALO_REVISION_MS);
    this.log.log(
      `revision del bot activa: pasa a un asesor lo que quede sin respuesta ${env.BOT_ESPERA_MINUTOS} min`,
    );
  }

  onApplicationShutdown() {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  /**
   * Saca del limbo las conversaciones que quedaron a mitad del flujo.
   *
   * Mientras el bot pregunta, la conversacion no esta asignada a nadie NI en la
   * cola: para el sistema la esta atendiendo el bot. Si el cliente se distrae,
   * o el webhook de su respuesta llega tarde —Meta a veces demora minutos—,
   * nadie se entera de que hay alguien esperando.
   *
   * Cubre los dos casos:
   *   - un asesor la tomo a mano: se cierra el flujo y se deja la nota, para
   *     que no arranque de cero leyendo todo el hilo
   *   - nadie la tomo y no hay respuesta: se cierra y se reparte
   */
  async revisarAbandonadas(): Promise<number> {
    try {
      const { rows } = await this.db.execute<{
        id: string;
        contact_id: string;
        assigned_to: string | null;
      }>(sql`
        SELECT c.id, c.contact_id, c.assigned_to
        FROM conversations c
        WHERE c.bot_paso IS NOT NULL
          AND c.estado <> 'resuelto'
          AND (
            c.assigned_to IS NOT NULL
            OR c.updated_at < clock_timestamp() - make_interval(mins => ${env.BOT_ESPERA_MINUTOS})
          )
        LIMIT 50
      `);

      for (const fila of rows) {
        const tomada = fila.assigned_to !== null;

        await this.cerrarFlujo(
          fila.id,
          tomada ? 'un asesor tomó la conversación' : 'el cliente no siguió respondiendo',
        );

        // Solo hay que repartir la que no tiene dueño; la otra ya lo tiene.
        if (!tomada) await this.asignacion.rutearEntrante(fila.contact_id, fila.id);
      }

      return rows.length;
    } catch (e) {
      // Nunca tumba el intervalo: en el peor caso se reintenta en un minuto.
      this.log.error(`no se pudo revisar el bot: ${(e as Error).message}`);
      return 0;
    }
  }

  abierto(ahora = new Date()): boolean {
    return estaAbierto(ahora, this.horario);
  }

  /**
   * Procesa un mensaje entrante.
   *
   * Devuelve `atendio: true` cuando el bot respondió y todavía está a cargo. En
   * ese caso el worker NO rutea: no tiene sentido asignarle a un asesor una
   * conversación donde el cliente todavía está contestando preguntas.
   *
   * El bot se calla —y no vuelve— apenas un humano toma la conversación.
   */
  async procesar(params: {
    conversationId: string;
    contactId: string;
    telefono: string;
    texto: string;
    botonId?: string;
  }): Promise<ResultadoBot> {
    if (!env.BOT_ACTIVO) return { atendio: false };

    const [conv] = await this.db
      .select({
        assignedTo: conversations.assignedTo,
        botPaso: conversations.botPaso,
        botDatos: conversations.botDatos,
        botIntentos: conversations.botIntentos,
      })
      .from(conversations)
      .where(eq(conversations.id, params.conversationId))
      .limit(1);

    if (!conv) return { atendio: false };

    // Si ya la tiene una persona, el bot no se mete: no hay nada peor que un
    // bot interrumpiendo una conversación que un asesor está atendiendo.
    if (conv.assignedTo) return { atendio: false };

    const paso = conv.botPaso as Paso | null;
    const datos = { ...(conv.botDatos ?? {}) };
    const ahora = new Date();
    const abierto = this.abierto(ahora);
    const vuelve = proximaApertura(ahora, this.horario);

    // --- el cliente pide una persona: se corta el flujo donde esté ---
    if (paso && pideHumano(params.texto)) {
      await this.entregarAHumano(params, datos, abierto, vuelve);
      return { atendio: false };
    }

    // --- cliente conocido cuyo asesor está disponible: el bot se aparta ---
    // Hacerlo pasar de nuevo por el menú cuando ya hay alguien que conoce su
    // caso es exactamente lo que hace odiar a los bots.
    if (!paso && (await this.asignacion.puedeRetomarConSuAsesor(params.contactId, params.conversationId))) {
      this.log.debug('cliente conocido con asesor disponible: el bot no interviene');
      return { atendio: false };
    }

    // --- primer contacto: saluda y ofrece el menú ---
    if (!paso) {
      await this.responder(params, saludo(env.NEGOCIO_NOMBRE, abierto, vuelve));
      await this.guardar(params.conversationId, 'menu', datos, 0);
      return { atendio: true };
    }

    switch (paso) {
      case 'menu': {
        const opcion = opcionElegida(params.texto, params.botonId);

        if (!opcion) {
          const intentos = conv.botIntentos + 1;
          if (intentos > MAX_INTENTOS) {
            // Insistir con el menú a alguien que no lo entiende sólo lo enoja.
            await this.entregarAHumano(params, datos, abierto, vuelve);
            return { atendio: false };
          }
          await this.responder(params, noEntendi());
          await this.guardar(params.conversationId, 'menu', datos, intentos);
          return { atendio: true };
        }

        if (opcion !== 'cotizar') {
          datos.motivo = opcion === 'pedido' ? 'Estado de un pedido' : 'Pidió hablar con asesor';
          await this.entregarAHumano(params, datos, abierto, vuelve);
          return { atendio: false };
        }

        datos.motivo = 'Cotizar un repuesto';

        // Si ya se le preguntó el vehículo alguna vez, se ofrece confirmarlo.
        const [contacto] = await this.db
          .select({ atributos: contacts.atributos })
          .from(contacts)
          .where(eq(contacts.id, params.contactId))
          .limit(1);

        const previos = (contacto?.atributos ?? {}) as Record<string, string>;
        await this.responder(params, preguntaDe('vehiculo', previos));
        await this.guardar(params.conversationId, 'vehiculo', datos, 0);
        return { atendio: true };
      }

      case 'vehiculo': {
        if (params.botonId === 'mismo') {
          const [contacto] = await this.db
            .select({ atributos: contacts.atributos })
            .from(contacts)
            .where(eq(contacts.id, params.contactId))
            .limit(1);

          datos.vehiculo = ((contacto?.atributos ?? {}) as Record<string, string>).vehiculo ?? '';
        } else if (params.botonId === 'otro') {
          await this.responder(params, { texto: preguntaDe('vehiculo').texto });
          await this.guardar(params.conversationId, 'vehiculo', datos, 0);
          return { atendio: true };
        } else {
          datos.vehiculo = params.texto.trim();

          // Se guarda en el contacto, no sólo en la conversación: la próxima vez
          // que escriba ya no hay que volver a preguntárselo.
          await this.db
            .update(contacts)
            .set({
              atributos: sql`${contacts.atributos} || ${JSON.stringify({ vehiculo: datos.vehiculo })}::jsonb`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(contacts.id, params.contactId));
        }

        await this.responder(params, preguntaDe('repuesto'));
        await this.guardar(params.conversationId, 'repuesto', datos, 0);
        return { atendio: true };
      }

      case 'repuesto': {
        datos.repuesto = params.texto.trim();
        await this.entregarAHumano(params, datos, abierto, vuelve);
        return { atendio: false };
      }

      default:
        return { atendio: false };
    }
  }

  /**
   * Cierra el flujo del bot dejando la nota, sin mandarle nada al cliente.
   *
   * Se usa cuando la conversacion sale del bot por otra via: un asesor la tomo
   * a mitad del interrogatorio, o se acabo la paciencia de esperar respuesta.
   * Sin esto, lo que el bot ya habia averiguado —motivo, vehiculo— se quedaba
   * en una columna que nadie mira, y el asesor arrancaba de cero.
   */
  async cerrarFlujo(conversationId: string, motivoDelCierre: string): Promise<boolean> {
    const [conv] = await this.db
      .select({ botPaso: conversations.botPaso, botDatos: conversations.botDatos })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv?.botPaso) return false;

    const datos = { ...(conv.botDatos ?? {}) } as Record<string, string>;
    const juntoAlgo = ['motivo', 'vehiculo', 'repuesto'].some((k) => datos[k]);

    // No se usa el texto por defecto de resumenParaAsesor: ese dice "el cliente
    // pidio hablar con un asesor", que aca seria mentira. El cliente no pidio
    // nada, se quedo callado o lo tomaron antes de que contestara.
    const cuerpo = juntoAlgo
      ? `${resumenParaAsesor(datos)}
(${motivoDelCierre})`
      : `El bot no alcanzó a averiguar qué necesita: ${motivoDelCierre}.
Hay que leer el hilo.`;

    await this.db.insert(notes).values({ conversationId, userId: null, cuerpo });

    await this.guardar(conversationId, null, datos, 0);
    this.realtime.conversacionActualizada(conversationId);
    this.log.log(`flujo del bot cerrado en ${conversationId}: ${motivoDelCierre}`);
    return true;
  }

  /** Cierra el flujo, deja la nota con lo recolectado y libera para el ruteo. */
  private async entregarAHumano(
    params: { conversationId: string; telefono: string },
    datos: Record<string, string>,
    abierto: boolean,
    vuelve: string,
  ) {
    await this.responder(params, { texto: despedida(abierto, vuelve) });

    await this.db.insert(notes).values({
      conversationId: params.conversationId,
      // Sin userId: la escribió el bot, no una persona.
      userId: null,
      cuerpo: resumenParaAsesor(datos),
    });

    await this.guardar(params.conversationId, null, datos, 0);
    this.realtime.conversacionActualizada(params.conversationId);
    this.log.log(`bot entregó ${params.conversationId} a un humano`);
  }

  /**
   * Manda la respuesta y la guarda en el hilo.
   *
   * Va sin `sentByUserId` a propósito: así las métricas pueden distinguir la
   * respuesta de un bot de la de una persona. Si contara como respuesta humana,
   * «sin responder» quedaría en cero para siempre y dejaría de servir.
   */
  private async responder(
    params: { conversationId: string; telefono: string },
    pregunta: Pregunta,
  ) {
    const fila = await this.mensajes.crearSalientePendiente({
      conversationId: params.conversationId,
      tipo: pregunta.botones ? 'interactive' : 'text',
      cuerpo: pregunta.texto,
      sentByUserId: null,
      raw: { bot: true, botones: pregunta.botones ?? [] },
    });

    try {
      const waMessageId = pregunta.botones
        ? await this.graph.enviarBotones(params.telefono, pregunta.texto, pregunta.botones)
        : await this.graph.enviarTexto(params.telefono, pregunta.texto, false);

      const confirmado = await this.mensajes.confirmarEnviado(fila.id, waMessageId);
      this.realtime.mensajeNuevo(params.conversationId, confirmado);
    } catch (e) {
      const fallido = await this.mensajes.marcarFallido(fila.id, {
        message: (e as Error).message,
      });

      // El fallido tambien se empuja, igual que el de un asesor: si no, el hilo
      // abierto se queda sin la respuesta del bot y hay que salir y volver a
      // entrar a la conversacion para verla.
      this.realtime.mensajeNuevo(params.conversationId, fallido ?? { ...fila, status: 'failed' });
      this.log.error(`el bot no pudo responder: ${(e as Error).message}`);
    }

    this.realtime.conversacionActualizada(params.conversationId);
  }

  private guardar(
    conversationId: string,
    paso: Paso | null,
    datos: Record<string, string>,
    intentos: number,
  ) {
    return this.db
      .update(conversations)
      .set({ botPaso: paso, botDatos: datos, botIntentos: intentos, updatedAt: sql`clock_timestamp()` })
      .where(eq(conversations.id, conversationId));
  }
}
