/**
 * La forma en que la bandeja espera un mensaje.
 *
 * Existe porque habia dos: el hilo devolvia esta, armada en SQL, y los avisos
 * en vivo mandaban la fila cruda de la base. Son distintas —`cuando` contra
 * `waTimestamp`, `tieneMedia` contra `mediaUrl`— asi que todo mensaje que
 * llegaba por socket se pintaba con la fecha en "Invalid Date" y sin la foto,
 * hasta que el asesor recargaba y lo volvia a pedir por HTTP.
 *
 * Ahora las dos vias pasan por aca. Si alguna vez se le agrega un campo al
 * hilo, hay que agregarlo tambien en `aVistaDeMensaje` o vuelve a pasar lo
 * mismo, esta vez con el campo nuevo.
 */
/**
 * El mensaje citado, cuando este responde a otro.
 *
 * Se manda resumido y no el mensaje entero: en el hilo la cita es un renglon
 * gris arriba de la burbuja, y con saber quien lo dijo, de que tipo era y como
 * empezaba alcanza para reconocerlo.
 */
export interface CitaDeMensaje {
  id: string;
  direccion: string;
  tipo: string;
  cuerpo: string | null;
  /** Nombre del asesor. null si lo mando el cliente. */
  autor: string | null;
}

export interface MensajeDeBandeja {
  id: string;
  /** El hilo cruza varias conversaciones del cliente: esto dice de cuál es. */
  conversationId: string;
  /** Traído del celular por el importador: historial, no se puede citar. */
  importado: boolean;
  waMessageId: string | null;
  direccion: string;
  tipo: string;
  cuerpo: string | null;
  caption: string | null;
  mediaMime: string | null;
  mediaNombre: string | null;
  mediaTamano: number | null;
  tieneMedia: boolean;
  status: string;
  ubicacionLat: number | null;
  ubicacionLon: number | null;
  enviadoPorId: string | null;
  esBot: boolean;
  reenviado: boolean;
  errorMessage: string | null;
  cuando: Date | string;
  eliminado: boolean;
  eliminadoPor: string | null;
  citado: CitaDeMensaje | null;
}

/** Una fila de `messages` tal como sale de la base. */
interface FilaMensaje {
  id: string;
  conversationId: string;
  waMessageId: string | null;
  direccion: string;
  tipo: string;
  cuerpo: string | null;
  caption: string | null;
  mediaMime: string | null;
  mediaUrl: string | null;
  mediaNombre: string | null;
  mediaTamano: number | null;
  status: string;
  ubicacionLat: number | null;
  ubicacionLon: number | null;
  sentByUserId: string | null;
  raw: unknown;
  errorMessage: string | null;
  waTimestamp: Date | string;
  eliminadoEn: Date | string | null;
  /**
   * Ya resuelto por quien arma la fila: el hilo lo trae en el SELECT y los
   * avisos en vivo lo cuelgan antes de emitir. Aca no se consulta la base.
   */
  citado?: CitaDeMensaje | null;
}

/**
 * Pasa una fila de la base a lo que espera la bandeja.
 *
 * Un mensaje recien creado o recien recibido nunca esta eliminado, asi que
 * `eliminadoPor` va en null sin consultar la tabla de usuarios: el hilo lo
 * resuelve con un subselect, pero aca haria una consulta por cada mensaje que
 * entra para un dato que siempre seria el mismo.
 */
export function aVistaDeMensaje(fila: FilaMensaje | Record<string, unknown>): MensajeDeBandeja {
  const f = fila as FilaMensaje;
  const eliminado = f.eliminadoEn != null;
  const raw = (f.raw ?? {}) as Record<string, unknown>;

  return {
    id: f.id,
    conversationId: f.conversationId,
    importado: raw.importado === true,
    waMessageId: f.waMessageId ?? null,
    direccion: f.direccion,
    tipo: f.tipo,
    // Igual que en el hilo: el contenido de un eliminado no vuelve a salir.
    cuerpo: eliminado ? null : (f.cuerpo ?? null),
    caption: eliminado ? null : (f.caption ?? null),
    mediaMime: eliminado ? null : (f.mediaMime ?? null),
    mediaNombre: f.mediaNombre ?? null,
    mediaTamano: f.mediaTamano ?? null,
    tieneMedia: f.mediaUrl != null && !eliminado,
    status: f.status,
    ubicacionLat: eliminado ? null : (f.ubicacionLat ?? null),
    ubicacionLon: eliminado ? null : (f.ubicacionLon ?? null),
    enviadoPorId: f.sentByUserId ?? null,
    esBot: raw.bot === true,
    reenviado: raw.reenviado === true,
    errorMessage: eliminado ? null : (f.errorMessage ?? null),
    cuando: f.waTimestamp,
    eliminado,
    eliminadoPor: null,
    citado: f.citado ?? null,
  };
}
