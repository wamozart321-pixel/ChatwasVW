import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * clock_timestamp() y no now().
 *
 * En Postgres now() devuelve la hora de INICIO DE LA TRANSACCION, no la del
 * statement. Como el worker procesa cada webhook dentro de una transaccion, un
 * now() dentro de ese procesamiento fecha todo con el instante en que arranco:
 * una nota escrita al final del flujo del bot quedaba con hora anterior al
 * primer mensaje, y aparecia arriba de todo en el hilo.
 */
const AHORA = sql`clock_timestamp()`;

const creado = timestamp('created_at', { withTimezone: true }).notNull().default(AHORA);
const actualizado = timestamp('updated_at', { withTimezone: true }).notNull().default(AHORA);

/** Asesores del equipo. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: text('nombre').notNull(),
  email: text('email').notNull().unique(),
  /** scrypt: 'salt:hash' en hex. Sin dependencias nativas, que en Windows duelen. */
  passwordHash: text('password_hash'),
  rol: text('rol', { enum: ['admin', 'supervisor', 'asesor'] })
    .notNull()
    .default('asesor'),
  activo: boolean('activo').notNull().default(true),
  /** Ultima vez que abrio la bandeja. Solo informativo: la presencia real
      se calcula por sockets conectados, que es lo que importa para repartir. */
  ultimaConexion: timestamp('ultima_conexion', { withTimezone: true }),
  createdAt: creado,
  updatedAt: actualizado,
});

/** Cliente final del lado de WhatsApp. */
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Identificador de WhatsApp: telefono en formato E.164 sin '+'. */
  waId: text('wa_id').notNull().unique(),
  telefono: text('telefono').notNull(),
  /** Nombre del perfil de WhatsApp. El cliente lo controla, puede cambiar. */
  nombre: text('nombre'),
  atributos: jsonb('atributos').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: creado,
  updatedAt: actualizado,
});

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    estado: text('estado', { enum: ['abierto', 'pendiente', 'resuelto'] })
      .notNull()
      .default('abierto'),
    /** Asesor duenno de la conversacion. NULL = en la cola sin asignar. */
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    /**
     * true si la asigno el sistema (pegajoso o menor carga).
     * Solo esas se rescatan a la cola si nadie contesta: si un asesor la tomo
     * a mano, es problema suyo y el sistema no se la quita.
     */
    asignadaAuto: boolean('asignada_auto').notNull().default(false),
    /**
     * Paso del flujo automatico. NULL = el bot no esta interviniendo, sea
     * porque ya termino o porque un humano tomo la conversacion.
     */
    botPaso: text('bot_paso'),
    /** Lo que el bot fue recolectando en esta conversacion. */
    botDatos: jsonb('bot_datos').$type<Record<string, string>>().notNull().default({}),
    /** Cuantas veces seguidas no entendio. Al tope, pasa a un humano. */
    botIntentos: integer('bot_intentos').notNull().default(0),
    /**
     * Cuando el bot dio por terminado su trabajo en esta conversacion.
     *
     * Sin esta marca, un cliente que ya paso por el menu y quedo esperando en
     * la cola recibia el saludo y el menu OTRA VEZ cada vez que escribia. Es
     * la clase de cosa por la que la gente odia los bots.
     */
    botEntregadaEn: timestamp('bot_entregada_en', { withTimezone: true }),
    /** Ultimo mensaje ENTRANTE. Es lo que abre la ventana de servicio. */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    /** lastInboundAt + 24h. Pasado esto solo se puede enviar plantilla aprobada. */
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    createdAt: creado,
    updatedAt: actualizado,
  },
  (t) => [
    // Un contacto no puede tener dos conversaciones vivas a la vez.
    // Esto es lo que hace seguro el upsert al recibir un mensaje.
    uniqueIndex('conversations_contacto_viva_idx')
      .on(t.contactId)
      .where(sql`${t.estado} <> 'resuelto'`),
    index('conversations_bandeja_idx').on(t.estado, t.lastMessageAt),
    index('conversations_asignadas_idx').on(t.assignedTo, t.lastMessageAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /**
     * ID de Meta (wamid...). UNIQUE => es la clave de idempotencia: Meta reenvia
     * el mismo webhook varias veces y el ON CONFLICT DO NOTHING lo absorbe.
     * NULL mientras un saliente todavia no fue aceptado por Meta.
     */
    waMessageId: text('wa_message_id').unique(),
    direccion: text('direccion', { enum: ['in', 'out'] }).notNull(),
    tipo: text('tipo').notNull(),
    cuerpo: text('cuerpo'),
    caption: text('caption'),
    mediaId: text('media_id'),
    mediaMime: text('media_mime'),
    /** Ruta relativa dentro del almacen local. Se llena al descargar de Meta. */
    mediaUrl: text('media_url'),
    /** Nombre original, para documentos. */
    mediaNombre: text('media_nombre'),
    mediaTamano: integer('media_tamano'),
    status: text('status', {
      enum: ['queued', 'sent', 'delivered', 'read', 'failed'],
    }).notNull(),
    /**
     * queued=0 sent=1 delivered=2 read=3. Los webhooks de estado llegan
     * desordenados, asi que el estado solo avanza: nunca retrocede.
     */
    statusRank: integer('status_rank').notNull().default(0),
    errorCode: integer('error_code'),
    errorMessage: text('error_message'),
    /** Asesor que lo envio. NULL en entrantes y en envios automaticos. */
    sentByUserId: uuid('sent_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Mensaje al que este responde, cuando es una respuesta citada.
     *
     * Apunta a nuestra fila y no al wamid de Meta porque el hilo necesita
     * mostrar la cita —quien lo dijo y que decia— y eso sale de la fila. Para
     * un entrante se resuelve al reves: Meta manda el wamid en `context.id` y
     * se busca cual es.
     *
     * `set null` y no `cascade`: si el mensaje citado se elimina, la respuesta
     * sigue siendo un mensaje valido que el cliente ya leyo. Pierde la cita, no
     * desaparece.
     */
    respondeA: uuid('responde_a').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    /**
     * Eliminado de la bandeja. Es borrado logico: el cuerpo queda en la base
     * para la auditoria, pero deja de mostrarse.
     *
     * IMPORTANTE: no borra nada del telefono del cliente. La Cloud API no
     * tiene forma de revocar un mensaje ya entregado.
     */
    eliminadoEn: timestamp('eliminado_en', { withTimezone: true }),
    eliminadoPor: uuid('eliminado_por').references(() => users.id, { onDelete: 'set null' }),
    /** Timestamp de Meta, NO now(). Ordenar por este campo. */
    /**
     * Ubicacion, cuando el mensaje es de tipo 'location'.
     *
     * En columnas propias y no dentro de `raw`: el hilo necesita las
     * coordenadas para armar el enlace al mapa, y sacarlas de un jsonb en cada
     * fila del hilo es trabajo de mas para algo que se lee siempre.
     */
    ubicacionLat: doublePrecision('ubicacion_lat'),
    ubicacionLon: doublePrecision('ubicacion_lon'),
    waTimestamp: timestamp('wa_timestamp', { withTimezone: true }).notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    createdAt: creado,
    updatedAt: actualizado,
  },
  (t) => [index('messages_hilo_idx').on(t.conversationId, t.waTimestamp)],
);

/**
 * Cola de webhooks. Se guarda el payload crudo y se responde 200 de inmediato;
 * un worker lo procesa despues con FOR UPDATE SKIP LOCKED.
 * Doble beneficio: queda auditoria y se puede reprocesar.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: creado,
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    index('webhook_events_pendientes_idx')
      .on(t.id)
      .where(sql`${t.processedAt} is null`),
  ],
);

/** Auditoria: quien asigno, reasigno, cerro o reabrio que y cuando. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tipo: text('tipo').notNull(),
    datos: jsonb('datos').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: creado,
  },
  (t) => [index('events_conversacion_idx').on(t.conversationId, t.id)],
);

export const RANGO_ESTADO = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 0,
} as const;

export type EstadoMensaje = keyof typeof RANGO_ESTADO;

/**
 * Plantillas aprobadas por Meta, sincronizadas desde la WABA.
 *
 * Se copian aca en vez de consultar Meta en cada envio: la lista casi no cambia,
 * y el asesor no puede esperar una llamada a la API para ver que puede mandar.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metaId: text('meta_id').unique(),
    nombre: text('nombre').notNull(),
    idioma: text('idioma').notNull(),
    /** MARKETING | UTILITY | AUTHENTICATION: define cuanto cobra Meta. */
    categoria: text('categoria'),
    /** APPROVED | PENDING | REJECTED | PAUSED | DISABLED */
    estado: text('estado').notNull(),
    /** Estructura cruda de Meta: header, body, footer, buttons. */
    componentes: jsonb('componentes').$type<unknown[]>().notNull().default([]),
    sincronizadaEn: timestamp('sincronizada_en', { withTimezone: true }).notNull().default(AHORA),
    createdAt: creado,
    updatedAt: actualizado,
  },
  (t) => [uniqueIndex('templates_nombre_idioma_idx').on(t.nombre, t.idioma)],
);

/**
 * Notas internas. No salen a WhatsApp: son para el equipo.
 * Van en tabla aparte y no en messages, para que sea imposible mandarlas
 * al cliente por error.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    cuerpo: text('cuerpo').notNull(),
    createdAt: creado,
  },
  (t) => [index('notes_conversacion_idx').on(t.conversationId, t.createdAt)],
);

/** Etiquetas del negocio: 'cotizado', 'espera repuesto', 'garantia'... */
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: text('nombre').notNull().unique(),
  color: text('color').notNull().default('slate'),
  createdAt: creado,
});

export const conversationTags = pgTable(
  'conversation_tags',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: creado,
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.tagId] }),
    index('conversation_tags_tag_idx').on(t.tagId),
  ],
);
