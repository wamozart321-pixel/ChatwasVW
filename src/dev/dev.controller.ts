import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { contacts, conversations, messages, webhookEvents } from '../db/schema';
import { AsignacionService } from '../asignacion/asignacion.service';
import { OutboundService } from '../messages/outbound.service';
import { GraphService } from '../whatsapp/graph.service';
import { ClaveGuard } from '../common/clave.guard';

/**
 * Endpoints de diagnostico del paso 1. Desaparecen cuando exista la bandeja real.
 * Todos exigen la cabecera  x-dev-key: <DEV_API_KEY>
 */
@Controller('dev')
@UseGuards(ClaveGuard)
export class DevController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly graph: GraphService,
    private readonly saliente: OutboundService,
    private readonly asignacion: AsignacionService,
  ) {}

  /** Confirma que el token y el phone number id son correctos. */
  @Get('salud')
  async salud() {
    const [{ conteo }] = await this.db
      .select({ conteo: sql<number>`count(*)::int` })
      .from(messages);

    return { numero: await this.graph.infoDelNumero(), mensajesGuardados: conteo };
  }

  @Post('enviar')
  enviar(@Body() body: { a: string; texto: string }) {
    return this.saliente.enviarTexto({ a: body.a, texto: body.texto });
  }

  @Post('plantilla')
  plantilla(
    @Body() body: { a: string; nombre: string; idioma?: string; componentes?: unknown[] },
  ) {
    return this.saliente.enviarPlantilla(body);
  }

  /** Bandeja en crudo: lo que en el paso 2 se convierte en la lista de chats. */
  @Get('conversaciones')
  async listar() {
    return this.db
      .select({
        id: conversations.id,
        contacto: contacts.nombre,
        telefono: contacts.waId,
        estado: conversations.estado,
        noLeidos: conversations.unreadCount,
        ultimoMensaje: conversations.lastMessageAt,
        ventanaVence: conversations.windowExpiresAt,
        ventanaAbierta: sql<boolean>`${conversations.windowExpiresAt} > now()`,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(50);
  }

  @Get('mensajes')
  async hilo(@Query('conversationId') conversationId: string) {
    return this.db
      .select({
        direccion: messages.direccion,
        tipo: messages.tipo,
        cuerpo: messages.cuerpo,
        status: messages.status,
        error: messages.errorMessage,
        cuando: messages.waTimestamp,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.waTimestamp)
      .limit(200);
  }

  /**
   * Corre el rescate ahora en vez de esperar al intervalo.
   * Sirve para responder "¿por qué esta conversación sigue asignada?".
   */
  @Post('rescatar')
  async rescatar() {
    return { devueltasALaCola: await this.asignacion.rescatar() };
  }

  /** Webhooks que reventaron 5 veces y ya no se reintentan. */
  @Get('webhooks-fallidos')
  async fallidos() {
    return this.db
      .select({
        id: webhookEvents.id,
        recibido: webhookEvents.receivedAt,
        intentos: webhookEvents.attempts,
        error: webhookEvents.lastError,
      })
      .from(webhookEvents)
      .where(isNotNull(webhookEvents.lastError))
      .orderBy(desc(webhookEvents.id))
      .limit(20);
  }
}
