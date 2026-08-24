import { z } from 'zod';

// Node >=20.12 lee .env sin dependencias externas.
try {
  process.loadEnvFile();
} catch {
  // sin .env: se usan las variables ya presentes en el entorno
}

const esquema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().min(1, 'falta DATABASE_URL'),

  META_GRAPH_VERSION: z.string().default('v23.0'),
  META_PHONE_NUMBER_ID: z.string().min(1, 'falta META_PHONE_NUMBER_ID'),
  META_WABA_ID: z.string().default(''),
  META_ACCESS_TOKEN: z.string().min(1, 'falta META_ACCESS_TOKEN'),
  META_APP_SECRET: z.string().min(1, 'falta META_APP_SECRET'),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1, 'falta META_WEBHOOK_VERIFY_TOKEN'),

  // Opcional a proposito: en produccion no se pone, y sin ella los endpoints
  // /dev/* quedan apagados. Son atajos para probar contra la base sin pasar por
  // la bandeja; en un servidor que atiende clientes no tienen nada que hacer.
  DEV_API_KEY: z
    .string()
    .min(8, 'DEV_API_KEY debe tener al menos 8 caracteres')
    .optional(),

  // Firma los tokens de sesion. Si cambia, todos los asesores deben volver a entrar.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),

  /**
   * Tope de conversaciones sin resolver por asesor. Por encima de esto el ruteo
   * pegajoso deja de mandarle trabajo y la conversacion cae a la cola comun.
   */
  MAX_CONVERSACIONES_POR_ASESOR: z.coerce.number().int().positive().default(15),

  /**
   * Reparto automatico de clientes nuevos al asesor conectado con menos carga.
   * En false, todo lo nuevo cae en 'Sin asignar' y se toma a mano.
   * El ruteo pegajoso (cliente que vuelve) sigue funcionando igual.
   */
  AUTO_ASIGNAR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Minutos sin respuesta antes de devolver a la cola una conversacion que
   * asigno el sistema. 0 lo desactiva.
   *
   * Sin esto, "conectado pero fue a almorzar" es peor que no asignar: el cliente
   * espera y nadie mas lo ve en la cola.
   */
  RESCATE_MINUTOS: z.coerce.number().int().min(0).default(5),

  // --- bot automatico ---

  BOT_ACTIVO: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** Zona horaria del negocio. El servidor puede estar en cualquier otra. */
  ZONA_HORARIA: z.string().default('America/Bogota'),

  /** Formato 'HH:MM-HH:MM', o 'cerrado'. */
  HORARIO_LUNES_VIERNES: z.string().default('08:30-17:30'),
  HORARIO_SABADO: z.string().default('08:30-14:00'),
  HORARIO_DOMINGO: z.string().default('cerrado'),

  /** Nombre con el que el bot se presenta al cliente. */
  NEGOCIO_NOMBRE: z.string().default('Repuestos Volkswagen Jhon Pardo'),

  /** Carpeta donde se guardan las fotos, audios y documentos de los clientes. */
  ALMACEN_DIR: z.string().default('./almacen'),

  /** Tope de descarga y de subida, en MB. WhatsApp no acepta mas de 16 MB. */
  MEDIA_MAX_MB: z.coerce.number().int().positive().max(100).default(16),
});

const parsed = esquema.safeParse(process.env);

if (!parsed.success) {
  const detalle = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\nConfiguracion invalida (revisa tu .env):\n${detalle}\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
