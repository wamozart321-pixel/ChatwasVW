import { io, type Socket } from 'socket.io-client';

export interface Asesor {
  id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'supervisor' | 'asesor';
}

export interface Conversacion {
  contactoId: string;
  tieneFoto: boolean;
  id: string;
  estado: 'abierto' | 'pendiente' | 'resuelto';
  contacto: string | null;
  telefono: string;
  noLeidos: number;
  ultimoMensaje: string | null;
  ventanaVence: string | null;
  ventanaAbierta: boolean;
  vistaPrevia: string | null;
  vistaPreviaTipo: string | null;
  vistaPreviaDireccion: 'in' | 'out' | null;
  vistaPreviaEstado: string | null;
  asignadoId: string | null;
  asignadoNombre: string | null;
  /** Está en la lista sólo porque la tenés abierta, no porque calce en la solapa. */
  fueraDelFiltro: boolean;
  etiquetas: Etiqueta[];
}

export interface Etiqueta {
  id?: string;
  nombre: string;
  color: string;
}

/**
 * Las dos clases de nota.
 *
 * `interna` es un comentario del equipo sobre la conversación; `informacion` es
 * un dato del pedido —la referencia de la pieza, el modelo, lo cotizado—. Van
 * en colores distintos para poder separar de un vistazo un dato de una opinión.
 */
export type TipoNota = 'interna' | 'informacion';

export interface Nota {
  id: string;
  tipo: TipoNota;
  cuerpo: string;
  autor: string | null;
  autorId: string | null;
  cuando: string;
}

export interface Plantilla {
  id: string;
  nombre: string;
  idioma: string;
  categoria: string | null;
  textoEncabezado: string | null;
  formatoEncabezado: string | null;
  textoCuerpo: string;
  textoPie: string | null;
  botones: string[];
  variablesEncabezado: number;
  variablesCuerpo: number;
  necesitaArchivo: boolean;
}

export interface Rendimiento {
  id: string;
  nombre: string;
  atendidas: number;
  resueltas: number;
  enviados: number;
  medianaRespuestaSeg: number | null;
}

export interface FilaCola {
  id: string;
  contacto: string | null;
  telefono: string;
  estado: string;
  sinLeer: number;
  asignadoNombre: string | null;
  ultimoDelCliente: string | null;
  esperandoSeg: number | null;
  ventanaAbierta: boolean;
}

export interface ResumenCola {
  sinAsignar: number;
  totalChats: number;
  pendientes: number;
  sinLeer: number;
  sinResponder: number;
  esperaMasVieja: number | null;
}

export interface DetalleConversacion {
  id: string;
  estado: string;
  contacto: string | null;
  telefono: string;
  contactoId: string;
  tieneFoto: boolean;
  noLeidos: number;
  ventanaVence: string | null;
  ventanaAbierta: boolean;
  creada: string;
  ultimoEntrante: string | null;
  totalMensajes: number;
  asignadoId: string | null;
  asignadoNombre: string | null;
  asignadaEn: string | null;
}

/** El mensaje citado, cuando este responde a otro. */
export interface Cita {
  id: string;
  direccion: 'in' | 'out';
  tipo: string;
  cuerpo: string | null;
  /** Nombre del asesor. null si lo mando el cliente. */
  autor: string | null;
}

export interface Mensaje {
  id: string;
  waMessageId: string | null;
  direccion: 'in' | 'out';
  tipo: string;
  cuerpo: string | null;
  caption: string | null;
  mediaMime: string | null;
  mediaNombre: string | null;
  mediaTamano: number | null;
  tieneMedia: boolean;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  ubicacionLat: number | null;
  ubicacionLon: number | null;
  errorMessage: string | null;
  enviadoPorId: string | null;
  esBot: boolean;
  reenviado: boolean;
  cuando: string;
  eliminado: boolean;
  eliminadoPor: string | null;
  citado: Cita | null;
}

export interface Lugar {
  nombre: string;
  latitud: number;
  longitud: number;
}

export interface UbicacionNegocio {
  latitud: number;
  longitud: number;
  nombre: string;
  direccion: string | null;
}

/** Una conversación de las que tiene encima un asesor. */
export interface ChatDeAsesor {
  id: string;
  contacto: string | null;
  telefono: string;
  estado: string;
  sinLeer: number;
  ultimoDelCliente: string | null;
}

export interface MiembroEquipo {
  id: string;
  nombre: string;
  rol: string;
  activas: number;
  sinLeer: number;
  conectado: boolean;
  tope: number;
}

const TOKEN = 'whatswv:token';

/**
 * El ultimo usuario que entro en esta maquina.
 *
 * Solo el correo, nunca la clave: al asesor le ahorra escribirlo cada manana
 * y no guarda nada que sirva para entrar. Sobrevive al 'Salir' a proposito —
 * salir es cerrar la sesion, no olvidar quien sos.
 */
const ULTIMO_EMAIL = 'whatswv.ultimo_email';

/**
 * Por que se cerro la ultima sesion.
 *
 * Se guarda un instante para que la pantalla de entrada pueda explicarlo. Sin
 * esto, a quien lo echa otro dispositivo le aparece el login sin mas y cree que
 * se rompio algo.
 */
const MOTIVO_CIERRE = 'whatswv.motivo_cierre';

export const sesion = {
  token: () => localStorage.getItem(TOKEN),
  guardar: (v: string) => localStorage.setItem(TOKEN, v),
  borrar: () => localStorage.removeItem(TOKEN),

  motivoCierre: () => {
    const v = localStorage.getItem(MOTIVO_CIERRE);
    localStorage.removeItem(MOTIVO_CIERRE);
    return v ?? '';
  },
  anotarCierre: (v: string) => localStorage.setItem(MOTIVO_CIERRE, v),

  ultimoEmail: () => localStorage.getItem(ULTIMO_EMAIL) ?? '',
  recordarEmail: (v: string) => localStorage.setItem(ULTIMO_EMAIL, v),
  olvidarEmail: () => localStorage.removeItem(ULTIMO_EMAIL),
};

export interface Usuario {
  id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'supervisor' | 'asesor';
  activo: boolean;
  conectado: boolean;
  ultimaConexion: string | null;
  creado: string;
}

export class ErrorApi extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly datos?: any,
  ) {
    super(message);
  }
}

async function pedir<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const token = sesion.token();

  const r = await fetch(`/api${ruta}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const texto = await r.text();
  const cuerpo = texto ? JSON.parse(texto) : null;

  if (!r.ok) {
    throw new ErrorApi(cuerpo?.mensaje ?? cuerpo?.message ?? `error ${r.status}`, r.status, cuerpo);
  }
  return cuerpo as T;
}

export const api = {
  login: (email: string, clave: string) =>
    pedir<{ token: string; asesor: Asesor }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, clave }),
    }),

  yo: () => pedir<Asesor>('/auth/yo'),

  /** Cierra la sesion tambien en el servidor, no solo en este aparato. */
  salir: () => pedir<{ ok: boolean }>('/auth/salir', { method: 'POST' }),

  config: () =>
    pedir<{ maxArchivoMB: number; maxVideoMB: number; ubicacionNegocio: UbicacionNegocio | null }>(
      '/config',
    ),

  /**
   * Manda una ubicacion. O se le pasan las coordenadas, o el texto crudo que
   * pego el asesor y lo resuelve el servidor: los enlaces cortos de Maps hay
   * que seguirlos, y Google no manda cabeceras CORS para hacerlo desde aca.
   */
  /** Abre un chat con un numero que todavia no escribio. */
  abrirChat: (telefono: string, nombre?: string) =>
    pedir<{ id: string; telefono: string; ventanaAbierta: boolean }>('/conversaciones', {
      method: 'POST',
      body: JSON.stringify({ telefono, nombre }),
    }),

  borrarEtiqueta: (tagId: string) =>
    pedir<{ ok: boolean; quitadaDe: number }>(`/etiquetas/${tagId}`, { method: 'DELETE' }),

  conteoEstados: (asignado: string, q: string, etiqueta: string) =>
    pedir<Record<string, number>>(
      `/conteo-estados?asignado=${asignado}&q=${encodeURIComponent(q)}&etiqueta=${etiqueta}`,
    ),

  buscarDireccion: (q: string) =>
    pedir<Lugar[]>(`/direcciones?q=${encodeURIComponent(q)}`),

  direccionDe: (lat: number, lon: number) =>
    pedir<{ direccion: string | null }>(`/direccion-de?lat=${lat}&lon=${lon}`),

  /** Resuelve un enlace de Maps a coordenadas, sin enviar nada todavia. */
  resolverUbicacion: (texto: string) =>
    pedir<{ latitud: number; longitud: number }>('/resolver-ubicacion', {
      method: 'POST',
      body: JSON.stringify({ texto }),
    }),

  enviarUbicacion: (
    id: string,
    datos: { latitud?: number; longitud?: number; texto?: string; nombre?: string; direccion?: string },
  ) =>
    pedir<Mensaje>(`/conversaciones/${id}/ubicacion`, {
      method: 'POST',
      body: JSON.stringify(datos),
    }),

  asesores: () => pedir<Asesor[]>('/auth/asesores'),

  equipo: () => pedir<MiembroEquipo[]>('/equipo'),

  /**
   * Que conversaciones tiene un asesor encima. Solo supervisores y admin: el
   * servidor devuelve 403 a un asesor.
   */
  conversacionesDe: (asesorId: string) =>
    pedir<ChatDeAsesor[]>(`/equipo/${asesorId}/conversaciones`),

  /**
   * `incluir` es la conversacion abierta: viene en la lista aunque deje de
   * calzar en la solapa. Si no, en "Sin leer" el chat desaparece apenas se
   * abre —porque abrirlo lo marca como leido— y se cierra solo.
   */
  conversaciones: (estado: string, q: string, asignado: string, etiqueta = '', incluir = '') =>
    pedir<Conversacion[]>(
      `/conversaciones?estado=${encodeURIComponent(estado)}&q=${encodeURIComponent(q)}` +
        `&asignado=${encodeURIComponent(asignado)}&etiqueta=${encodeURIComponent(etiqueta)}` +
        `&incluir=${encodeURIComponent(incluir)}`,
    ),

  detalle: (id: string) => pedir<DetalleConversacion>(`/conversaciones/${id}`),

  hilo: (id: string) => pedir<Mensaje[]>(`/conversaciones/${id}/mensajes`),

  enviar: (id: string, texto: string, respondeA?: string | null) =>
    pedir<Mensaje>(`/conversaciones/${id}/mensajes`, {
      method: 'POST',
      body: JSON.stringify({ texto, respondeA: respondeA ?? undefined }),
    }),

  leida: (id: string) => pedir(`/conversaciones/${id}/leida`, { method: 'POST' }),

  /** Manda el mismo mensaje a otra conversacion. */
  reenviar: (messageId: string, conversationId: string) =>
    pedir<Mensaje>(`/mensajes/${messageId}/reenviar`, {
      method: 'POST',
      body: JSON.stringify({ conversationId }),
    }),

  // --- administracion de usuarios (solo rol admin) ---
  usuarios: () => pedir<Usuario[]>('/admin/usuarios'),

  crearUsuario: (datos: { nombre: string; email: string; clave: string; rol: string }) =>
    pedir<Usuario>('/admin/usuarios', { method: 'POST', body: JSON.stringify(datos) }),

  claveDeUsuario: (id: string, clave: string) =>
    pedir(`/admin/usuarios/${id}/clave`, { method: 'POST', body: JSON.stringify({ clave }) }),

  rolDeUsuario: (id: string, rol: string) =>
    pedir(`/admin/usuarios/${id}/rol`, { method: 'POST', body: JSON.stringify({ rol }) }),

  queSePierde: (id: string) =>
    pedir<{ mensajes: number; notas: number; conversaciones: number }>(
      `/admin/usuarios/${id}/que-se-pierde`,
    ),

  /** Borra de verdad. Pide la clave de quien lo hace: no se deshace. */
  borrarUsuario: (id: string, clave: string) =>
    pedir<{ ok: boolean; devueltasALaCola: number }>(`/admin/usuarios/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ clave }),
    }),

  estadoDeUsuario: (id: string, activo: boolean) =>
    pedir<{ ok: boolean; devueltasALaCola: number }>(`/admin/usuarios/${id}/estado`, {
      method: 'POST',
      body: JSON.stringify({ activo }),
    }),

  cambiarEstado: (id: string, estado: string) =>
    pedir(`/conversaciones/${id}/estado`, {
      method: 'POST',
      body: JSON.stringify({ estado }),
    }),

  tomar: (id: string) =>
    pedir<{ ok: boolean; asesor: { id: string; nombre: string } }>(`/conversaciones/${id}/tomar`, {
      method: 'POST',
    }),

  soltar: (id: string) => pedir(`/conversaciones/${id}/soltar`, { method: 'POST' }),

  asignar: (id: string, asesorId: string) =>
    pedir(`/conversaciones/${id}/asignar`, {
      method: 'POST',
      body: JSON.stringify({ asesorId }),
    }),

  // --- archivos ---

  enviarArchivo: async (id: string, archivo: File, caption?: string, respondeA?: string | null) => {
    const form = new FormData();
    form.append('archivo', archivo);

    const parametros = new URLSearchParams();
    if (caption) parametros.set('caption', caption);
    if (respondeA) parametros.set('respondeA', respondeA);
    const cola = parametros.toString();

    const url = `/api/conversaciones/${id}/media` + (cola ? `?${cola}` : '');

    // Sin Content-Type: el navegador lo arma con el boundary del multipart.
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sesion.token() ?? ''}` },
      body: form,
    });

    const texto = await r.text();
    const cuerpo = texto ? JSON.parse(texto) : null;
    if (!r.ok) {
      throw new ErrorApi(cuerpo?.mensaje ?? cuerpo?.message ?? 'no se pudo enviar', r.status, cuerpo);
    }
    return cuerpo as Mensaje;
  },

  // --- plantillas ---

  plantillas: () => pedir<Plantilla[]>('/plantillas'),

  sincronizarPlantillas: () =>
    pedir<{ sincronizadas: number }>('/plantillas/sincronizar', { method: 'POST' }),

  enviarPlantilla: (
    templateId: string,
    datos: { conversationId: string; encabezado?: string[]; cuerpo?: string[] },
  ) =>
    pedir<Mensaje>(`/plantillas/${templateId}/enviar`, {
      method: 'POST',
      body: JSON.stringify(datos),
    }),

  // --- notas y etiquetas ---

  notas: (id: string) => pedir<Nota[]>(`/conversaciones/${id}/notas`),

  agregarNota: (id: string, cuerpo: string, tipo: TipoNota = 'interna') =>
    pedir<Nota>(`/conversaciones/${id}/notas`, {
      method: 'POST',
      body: JSON.stringify({ cuerpo, tipo }),
    }),

  borrarNota: (notaId: string) => pedir(`/notas/${notaId}`, { method: 'DELETE' }),

  // --- foto del contacto ---
  //
  // NO es la foto de perfil de WhatsApp: esa no se puede leer. La pone el
  // equipo, y para un cliente de siempre resuelve lo mismo.

  subirFoto: async (contactoId: string, archivo: File) => {
    const form = new FormData();
    form.append('archivo', archivo);

    const r = await fetch(`/api/contactos/${contactoId}/foto`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sesion.token() ?? ''}` },
      body: form,
    });

    const texto = await r.text();
    const cuerpo = texto ? JSON.parse(texto) : null;
    if (!r.ok) {
      throw new ErrorApi(cuerpo?.mensaje ?? cuerpo?.message ?? 'no se pudo subir', r.status, cuerpo);
    }
    return cuerpo as { ok: boolean; tieneFoto: boolean };
  },

  /** Usa como foto una imagen que ya está en la conversación. */
  fotoDeMensaje: (contactoId: string, messageId: string) =>
    pedir<{ ok: boolean; tieneFoto: boolean }>(`/contactos/${contactoId}/foto-de-mensaje`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),

  quitarFoto: (contactoId: string) =>
    pedir<{ ok: boolean }>(`/contactos/${contactoId}/foto`, { method: 'DELETE' }),

  eliminarMensaje: (messageId: string) =>
    pedir<{ ok: boolean; llegoAlCliente: boolean }>(`/mensajes/${messageId}`, {
      method: 'DELETE',
    }),

  etiquetas: () => pedir<Etiqueta[]>('/etiquetas'),

  crearEtiqueta: (nombre: string, color: string) =>
    pedir<Etiqueta>('/etiquetas', { method: 'POST', body: JSON.stringify({ nombre, color }) }),

  etiquetasDe: (id: string) => pedir<Etiqueta[]>(`/conversaciones/${id}/etiquetas`),

  etiquetar: (id: string, tagId: string) =>
    pedir<Etiqueta[]>(`/conversaciones/${id}/etiquetas`, {
      method: 'POST',
      body: JSON.stringify({ tagId }),
    }),

  desetiquetar: (id: string, tagId: string) =>
    pedir<Etiqueta[]>(`/conversaciones/${id}/etiquetas/${tagId}`, { method: 'DELETE' }),

  // --- metricas ---

  rendimiento: (dias = 7) => pedir<Rendimiento[]>(`/metricas/rendimiento?dias=${dias}`),

  resumenCola: () => pedir<ResumenCola>('/metricas/resumen'),

  detalleCola: (categoria: string) => pedir<FilaCola[]>(`/metricas/cola/${categoria}`),
};

/**
 * Descarga un archivo del almacen con el token y devuelve un blob URL.
 *
 * No se puede poner /api/media/... directo en un <img>: el navegador no manda
 * la cabecera Authorization en esas peticiones, y meter el token en la URL lo
 * dejaria en el historial y en cualquier log intermedio.
 */
export async function descargarMedia(messageId: string): Promise<string> {
  const r = await fetch(`/api/media/${messageId}`, {
    headers: { Authorization: `Bearer ${sesion.token() ?? ''}` },
  });
  if (!r.ok) throw new ErrorApi('no se pudo cargar el archivo', r.status);
  return URL.createObjectURL(await r.blob());
}

export function conectarSocket(): Socket {
  return io({ auth: { token: sesion.token() }, transports: ['websocket', 'polling'] });
}
