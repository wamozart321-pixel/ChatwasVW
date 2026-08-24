import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { contacts, conversations } from '../db/schema';

/** Ventana de servicio de WhatsApp: 24 horas desde el ultimo mensaje del cliente. */
export const VENTANA_MS = 24 * 60 * 60 * 1000;

/** Deja solo digitos: '+51 999 888 777' -> '51999888777'. Meta usa E.164 sin '+'. */
export function normalizarTelefono(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  return digitos.startsWith('00') ? digitos.slice(2) : digitos;
}

@Injectable()
export class ConversationsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Crea o actualiza el contacto por wa_id. Nunca borra un nombre ya conocido. */
  async asegurarContacto(waId: string, nombre?: string) {
    const [fila] = await this.db
      .insert(contacts)
      .values({ waId, telefono: waId, nombre: nombre ?? null })
      .onConflictDoUpdate({
        target: contacts.waId,
        set: {
          nombre: sql`coalesce(excluded.nombre, ${contacts.nombre})`,
          updatedAt: sql`clock_timestamp()`,
        },
      })
      .returning();

    return fila;
  }

  /**
   * Abre (o reutiliza) la conversacion viva del contacto y corre la ventana de 24h.
   * El indice unico parcial sobre contact_id garantiza que solo haya una viva,
   * asi que dos webhooks simultaneos no pueden duplicarla.
   */
  async registrarEntrante(contactId: string, cuando: Date) {
    const [fila] = await this.db
      .insert(conversations)
      .values({
        contactId,
        estado: 'abierto',
        lastInboundAt: cuando,
        windowExpiresAt: new Date(cuando.getTime() + VENTANA_MS),
        lastMessageAt: cuando,
      })
      .onConflictDoUpdate({
        target: conversations.contactId,
        targetWhere: sql`estado <> 'resuelto'`,
        set: {
          // Un mensaje nuevo del cliente siempre vuelve a poner la conversacion en juego.
          estado: sql`'abierto'`,
          // greatest() porque los webhooks de Meta llegan desordenados.
          lastInboundAt: sql`greatest(${conversations.lastInboundAt}, excluded.last_inbound_at)`,
          windowExpiresAt: sql`greatest(${conversations.windowExpiresAt}, excluded.window_expires_at)`,
          lastMessageAt: sql`greatest(${conversations.lastMessageAt}, excluded.last_message_at)`,
          updatedAt: sql`clock_timestamp()`,
        },
      })
      .returning();

    return fila;
  }

  /** Conversacion viva del contacto, si existe. */
  async vivaDelContacto(contactId: string) {
    const [fila] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.contactId, contactId), ne(conversations.estado, 'resuelto')))
      .limit(1);

    return fila ?? null;
  }

  /** Igual que la anterior pero creandola si no hay ninguna (caso plantilla saliente). */
  async asegurarConversacion(contactId: string) {
    const existente = await this.vivaDelContacto(contactId);
    if (existente) return existente;

    const [fila] = await this.db
      .insert(conversations)
      .values({ contactId, estado: 'abierto', lastMessageAt: sql`clock_timestamp()` })
      .onConflictDoUpdate({
        target: conversations.contactId,
        targetWhere: sql`estado <> 'resuelto'`,
        set: { updatedAt: sql`clock_timestamp()` },
      })
      .returning();

    return fila;
  }

  /** La hora la pone Postgres, por lo mismo que `crearSalientePendiente`. */
  async marcarSalienteEn(conversationId: string) {
    await this.db
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, clock_timestamp())`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(conversations.id, conversationId));
  }

  async sumarNoLeido(conversationId: string) {
    await this.db
      .update(conversations)
      .set({ unreadCount: sql`${conversations.unreadCount} + 1`, updatedAt: sql`clock_timestamp()` })
      .where(eq(conversations.id, conversationId));
  }

  /** true si todavia se puede mandar texto libre. */
  ventanaAbierta(windowExpiresAt: Date | null): boolean {
    return !!windowExpiresAt && windowExpiresAt.getTime() > Date.now();
  }
}
