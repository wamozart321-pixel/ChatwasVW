/**
 * Puente con la app de Windows.
 *
 * En el navegador todas estas funciones no hacen nada: la bandeja es la misma
 * en los dos lados y no tiene que saber dónde está corriendo. `precarga.js` del
 * empaquetado es el que pone `window.whatswv`.
 */
interface PuenteEscritorio {
  escritorio: true;
  sinLeer(cantidad: number): void;
  avisar(datos: { titulo: string; cuerpo: string; conversationId?: string }): void;
  alAbrirConversacion(fn: (id: string) => void): void;
  buscarActualizacion?(): Promise<void>;
}

declare global {
  interface Window {
    whatswv?: PuenteEscritorio;
  }
}

export function enEscritorio(): boolean {
  return typeof window !== 'undefined' && window.whatswv?.escritorio === true;
}

/**
 * Le pide a la app que revise si hay versión nueva.
 *
 * La respuesta la da la app con sus propios cuadros de diálogo —«ya estás al
 * día», o el aviso de que se está bajando—, así que acá no hay nada que
 * mostrar.
 */
export function buscarActualizacion(): void {
  void window.whatswv?.buscarActualizacion?.();
}

/** Cuántas conversaciones propias tienen mensajes sin leer, para el globito. */
export function reportarSinLeer(cantidad: number): void {
  window.whatswv?.sinLeer(cantidad);
}

/**
 * Aviso del sistema.
 *
 * Se manda al proceso principal en vez de usar `new Notification()` porque en
 * Windows un aviso disparado desde la página sale a nombre de Electron y sin
 * ícono; desde el proceso principal sale a nombre de WhatsWV y el clic trae la
 * ventana al frente con la conversación abierta.
 */
export function avisar(datos: {
  titulo: string;
  cuerpo: string;
  conversationId?: string;
}): void {
  window.whatswv?.avisar(datos);
}

/** El asesor hizo clic en un aviso: hay que abrirle esa conversación. */
export function alAbrirConversacion(fn: (id: string) => void): void {
  window.whatswv?.alAbrirConversacion(fn);
}
