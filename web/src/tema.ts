/**
 * Claro, oscuro o lo que diga el sistema.
 *
 * Aparte de los componentes porque es la parte que puede fallar en silencio:
 * leer una preferencia guardada, decidir si toca oscuro y dejar la clase en el
 * <html>. Dibujar el botón no tiene forma de salir mal.
 *
 * «automatico» es el que viene de fábrica, y es el que corresponde: el asesor
 * que ya puso el teléfono en oscuro a las 7 de la tarde no tiene por qué
 * volver a decírselo a la bandeja.
 */
export type Tema = 'claro' | 'oscuro' | 'automatico';

const CLAVE = 'whatswv:tema';

/** La misma clase que pone el script de index.html antes de que React arranque. */
const CLASE = 'oscuro';

export function esTema(v: unknown): v is Tema {
  return v === 'claro' || v === 'oscuro' || v === 'automatico';
}

/**
 * Lo que el asesor eligió la última vez.
 *
 * En modo privado de Safari leer localStorage tira excepción en vez de devolver
 * null, y eso dejaba la bandeja en blanco: de ahí el try.
 */
export function temaGuardado(): Tema {
  try {
    const v = localStorage.getItem(CLAVE);
    return esTema(v) ? v : 'automatico';
  } catch {
    return 'automatico';
  }
}

export function guardarTema(tema: Tema) {
  try {
    localStorage.setItem(CLAVE, tema);
  } catch {
    /* sin almacenamiento: vale para esta sesión y nada más */
  }
}

/** ¿El sistema operativo está en oscuro? */
export function sistemaEnOscuro(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Qué toca mostrar, resolviendo «automatico» contra el sistema. */
export function oscuroAhora(tema: Tema): boolean {
  return tema === 'oscuro' || (tema === 'automatico' && sistemaEnOscuro());
}

/**
 * Deja el <html> como corresponde.
 *
 * Además mueve `theme-color`, que es lo que pinta la barra de estado del
 * celular: sin esto la app queda con una franja blanca arriba de una pantalla
 * oscura.
 */
export function aplicarTema(tema: Tema) {
  const oscuro = oscuroAhora(tema);
  document.documentElement.classList.toggle(CLASE, oscuro);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', oscuro ? '#111a2b' : '#ffffff');
}

/**
 * Avisa cuando el sistema cambia de claro a oscuro.
 *
 * Sólo importa con «automatico», pero se suscribe igual: el que elige claro a
 * mano y después vuelve a automático tiene que seguir funcionando sin recargar.
 * Devuelve la función para desuscribirse.
 */
export function escucharSistema(alCambiar: () => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};

  mq.addEventListener('change', alCambiar);
  return () => mq.removeEventListener('change', alCambiar);
}
