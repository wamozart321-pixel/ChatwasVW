/**
 * Puente entre la bandeja (que corre como página web) y la app.
 *
 * Es lo único que la página puede tocar del sistema. Nada de `require` ni de
 * Node suelto en el renderer: la bandeja carga desde el servidor y una página
 * remota con acceso a Node es una puerta abierta.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whatswv', {
  /** Marca de que corre dentro de la app: la bandeja la usa para decidir si manda avisos. */
  escritorio: true,

  /** Cantidad de conversaciones sin leer, para el globito de la barra de tareas. */
  sinLeer(cantidad) {
    ipcRenderer.send('whatswv:sin-leer', cantidad);
  },

  /** Aviso del sistema. `conversationId` hace que el clic abra ese chat. */
  avisar(datos) {
    ipcRenderer.send('whatswv:aviso', datos);
  },

  /** El usuario hizo clic en un aviso: la bandeja abre esa conversación. */
  alAbrirConversacion(fn) {
    ipcRenderer.on('whatswv:abrir-conversacion', (_e, id) => fn(id));
  },

  guardarServidor: (url) => ipcRenderer.invoke('whatswv:guardar-servidor', url),
  reintentar: () => ipcRenderer.invoke('whatswv:reintentar'),
  cambiarServidor: () => ipcRenderer.invoke('whatswv:cambiar-servidor'),
});
