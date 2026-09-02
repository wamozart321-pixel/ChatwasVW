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

  /**
   * Idioma en el que el negocio le escribe a sus clientes.
   *
   * El selector de plantillas solo muestra las de este idioma. La cuenta trae
   * de fabrica las de ejemplo de Meta (hello_world, jaspers_market_*), todas en
   * en_US: no se pueden borrar sin control total sobre la cuenta, y mandarle
   * una a un cliente de Bogota no tendria sentido.
   */
  PLANTILLAS_IDIOMA: z.string().default('es'),

  /** Zona horaria del negocio. El servidor puede estar en cualquier otra. */
  ZONA_HORARIA: z.string().default('America/Bogota'),

  /**
   * Minutos que el bot espera una respuesta antes de pasarle la conversacion a
   * un asesor con lo que haya juntado. Sin esto, un cliente que se distrae a
   * mitad del interrogatorio queda en un limbo: no esta asignado a nadie y
   * tampoco aparece en la cola, porque el bot figura como que la esta atendiendo.
   * 0 desactiva la revision.
   */
  BOT_ESPERA_MINUTOS: z.coerce.number().int().min(0).max(120).default(5),

  /** Formato 'HH:MM-HH:MM', o 'cerrado'. */
  HORARIO_LUNES_VIERNES: z.string().default('08:30-17:30'),
  HORARIO_SABADO: z.string().default('08:30-14:00'),
  HORARIO_DOMINGO: z.string().default('cerrado'),

  /** Nombre con el que el bot se presenta al cliente. */
  NEGOCIO_NOMBRE: z.string().default('Repuestos Volkswagen Jhon Pardo'),

  /**
   * Donde queda el local. Con esto, mandarle la direccion a un cliente es un
   * clic en vez de buscarla en Maps y copiar el enlace cada vez.
   * Vacio = el boton de "nuestra ubicacion" no aparece.
   */
  /**
   * Indicativo del pais, sin '+'. Se usa cuando un asesor escribe un numero
   * local: en Colombia los celulares son 10 digitos y Meta los exige con el 57
   * adelante. Un numero que ya venga con indicativo se deja como esta.
   */
  PREFIJO_PAIS: z.string().regex(/^\d{1,4}$/).default('57'),

  /**
   * Ciudad que se asume cuando el asesor busca una direccion sin decir donde.
   * "Cra 27A #66-82" existe en media docena de ciudades; sin esto el buscador
   * elige cualquiera.
   */
  CIUDAD_PREDETERMINADA: z.string().default('Bogotá'),

  NEGOCIO_LAT: z.coerce.number().min(-90).max(90).optional(),
  NEGOCIO_LON: z.coerce.number().min(-180).max(180).optional(),
  NEGOCIO_DIRECCION: z.string().optional(),

  /** Carpeta donde se guardan las fotos, audios y documentos de los clientes. */
  ALMACEN_DIR: z.string().default('./almacen'),

  /** Tope de descarga y de subida, en MB. WhatsApp no acepta mas de 16 MB. */
  MEDIA_MAX_MB: z.coerce.number().int().positive().max(100).default(16),

  /**
   * Cuanto pesa como maximo el video que se acepta SUBIR.
   *
   * Es mas alto que MEDIA_MAX_MB porque el video se recomprime antes de
   * mandarlo: medio minuto de camara a 1080p pasa de los 16 MB que acepta
   * WhatsApp, pero convertido a 720p entra de sobra. El tope de verdad —el de
   * Meta— se vuelve a comprobar sobre el archivo ya convertido.
   */
  MEDIA_VIDEO_MAX_MB: z.coerce.number().int().positive().max(100).default(64),
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
