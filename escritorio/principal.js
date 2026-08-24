/**
 * Proceso principal de la app de escritorio.
 *
 * La app NO trae la bandeja adentro: abre la que sirve el servidor. Es a
 * propósito. Empaquetar una copia del frontend significaría que cada asesor
 * queda con la versión que tenía el día que instaló, y siete personas con
 * siete versiones distintas de la misma bandeja es un problema que no se ve
 * hasta que alguien reporta algo que ya está arreglado. Así, actualizar el
 * servidor actualiza a todos.
 *
 * Lo que sí aporta la app sobre abrir el navegador:
 *   - avisos del sistema cuando entra un chat, aunque esté minimizada
 *   - ícono en la bandeja con la cantidad de conversaciones sin leer
 *   - la sesión queda abierta entre reinicios, sin volver a loguearse
 *   - una pantalla decente cuando el servidor no responde, en vez de un error
 *     de navegador que nadie sabe interpretar
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, Notification } = require('electron');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

/** Windows necesita esto para que los avisos salgan a nombre de la app. */
app.setAppUserModelId('com.repuestosjhonpardo.whatswv');

const RUTA_CONFIG = () => join(app.getPath('userData'), 'configuracion.json');

/**
 * Servidor con el que arranca una instalación nueva.
 *
 * Se puede cambiar desde el menú de la bandeja del sistema, pero venir con el
 * del negocio puesto evita que cada asesor tenga que escribir una dirección
 * que va a copiar mal.
 */
const SERVIDOR_POR_DEFECTO = 'https://bandeja.chatwasvw.com';

let ventana = null;
let bandeja = null;
let cerrandoDeVerdad = false;
let sinLeer = 0;

// --- configuración -----------------------------------------------------------

function leerConfig() {
  try {
    const guardada = JSON.parse(readFileSync(RUTA_CONFIG(), 'utf8'));
    return { servidor: SERVIDOR_POR_DEFECTO, ...guardada };
  } catch {
    return { servidor: SERVIDOR_POR_DEFECTO };
  }
}

function guardarConfig(cambios) {
  const config = { ...leerConfig(), ...cambios };
  writeFileSync(RUTA_CONFIG(), JSON.stringify(config, null, 2), 'utf8');
  return config;
}

/**
 * Comprueba que la URL sea de verdad un servidor WhatsWV y no cualquier cosa.
 *
 * Pedir la raíz no sirve: cualquier sitio contesta 200. La bandeja sin token
 * responde 401, que es justamente lo que ningún otro servidor devolvería ahí.
 */
async function esServidorValido(base) {
  try {
    const r = await fetch(`${base}/api/equipo`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    return r.status === 401;
  } catch {
    return false;
  }
}

function normalizarUrl(texto) {
  const limpio = String(texto ?? '').trim().replace(/\/+$/, '');
  if (!limpio) return null;
  if (!/^https?:\/\//i.test(limpio)) return `https://${limpio}`;
  return limpio;
}

// --- ícono de la bandeja del sistema ----------------------------------------

function iconoBase() {
  const ruta = join(__dirname, 'recursos', 'icono.png');
  return existsSync(ruta) ? nativeImage.createFromPath(ruta) : nativeImage.createEmpty();
}

function actualizarBandeja() {
  if (!bandeja) return;

  bandeja.setToolTip(
    sinLeer > 0 ? `WhatsWV — ${sinLeer} conversación${sinLeer === 1 ? '' : 'es'} sin leer` : 'WhatsWV',
  );

  // Windows no tiene contador en el ícono de la bandeja, pero sí un globito
  // sobre el botón de la barra de tareas: es el que ve el asesor de reojo.
  if (ventana) {
    ventana.setOverlayIcon(
      sinLeer > 0 ? nativeImage.createFromDataURL(globito(sinLeer)) : null,
      sinLeer > 0 ? `${sinLeer} sin leer` : '',
    );
  }
}

/** Globito rojo con el número, dibujado en SVG para no depender de archivos. */
function globito(n) {
  const texto = n > 99 ? '99+' : String(n);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <circle cx="16" cy="16" r="15" fill="#dc2626"/>
    <text x="16" y="22" font-family="Segoe UI, sans-serif" font-size="${texto.length > 2 ? 13 : 17}"
          font-weight="600" fill="#ffffff" text-anchor="middle">${texto}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function crearBandeja() {
  bandeja = new Tray(iconoBase());
  bandeja.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir WhatsWV', click: () => mostrarVentana() },
      { type: 'separator' },
      { label: 'Recargar', click: () => ventana?.reload() },
      { label: 'Cambiar servidor…', click: () => pedirServidor() },
      { type: 'separator' },
      {
        label: 'Salir',
        click: () => {
          cerrandoDeVerdad = true;
          app.quit();
        },
      },
    ]),
  );
  bandeja.on('click', () => mostrarVentana());
  actualizarBandeja();
}

function mostrarVentana() {
  if (!ventana) return;
  if (ventana.isMinimized()) ventana.restore();
  ventana.show();
  ventana.focus();
}

// --- ventanas ----------------------------------------------------------------

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    icon: join(__dirname, 'recursos', 'icono.png'),
    title: 'WhatsWV',
    webPreferences: {
      preload: join(__dirname, 'precarga.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // La sesión persiste sola con la partición por defecto: el asesor
      // arranca la app y ya está adentro, sin volver a poner la clave.
      spellcheck: true,
    },
  });

  ventana.setMenuBarVisibility(false);
  ventana.once('ready-to-show', () => ventana.show());

  // Cerrar manda a la bandeja, no mata la app: si el asesor cierra la ventana
  // sin querer deja de recibir avisos de clientes y no se entera.
  ventana.on('close', (e) => {
    if (cerrandoDeVerdad) return;
    e.preventDefault();
    ventana.hide();
  });

  // Los enlaces que manda un cliente se abren en el navegador, no acá adentro:
  // esta ventana no tiene barra de direcciones ni botón de volver.
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  ventana.webContents.on('will-navigate', (e, url) => {
    const base = leerConfig().servidor;
    if (base && !url.startsWith(base)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  return ventana;
}

/** Pantalla propia cuando el servidor no contesta. */
function mostrarCaida(base) {
  void ventana.loadFile(join(__dirname, 'ventanas', 'sin-conexion.html'), {
    query: { servidor: base ?? '' },
  });
}

async function abrirBandeja() {
  const base = leerConfig().servidor;
  if (!base) return pedirServidor();

  if (!(await esServidorValido(base))) return mostrarCaida(base);

  await ventana.loadURL(base);
}

function pedirServidor() {
  if (!ventana) return;
  void ventana.loadFile(join(__dirname, 'ventanas', 'servidor.html'), {
    query: { actual: leerConfig().servidor ?? '' },
  });
  mostrarVentana();
}

// --- puentes con la bandeja --------------------------------------------------

/** La bandeja avisa cuántas conversaciones tiene sin leer el asesor. */
ipcMain.on('whatswv:sin-leer', (_e, cantidad) => {
  const n = Number(cantidad);
  if (!Number.isFinite(n) || n < 0) return;
  sinLeer = Math.floor(n);
  actualizarBandeja();
});

/**
 * Aviso del sistema. Se dispara desde la bandeja cuando entra un chat.
 *
 * No usa la Notification API del navegador porque en Windows los avisos de una
 * página quedan a nombre de Electron y sin ícono; mandarlo por acá los deja a
 * nombre de WhatsWV y hace que el clic traiga la ventana al frente.
 */
ipcMain.on('whatswv:aviso', (_e, datos) => {
  if (!Notification.isSupported()) return;

  const aviso = new Notification({
    title: String(datos?.titulo ?? 'WhatsWV').slice(0, 120),
    body: String(datos?.cuerpo ?? '').slice(0, 400),
    icon: join(__dirname, 'recursos', 'icono.png'),
    silent: false,
  });

  aviso.on('click', () => {
    mostrarVentana();
    if (datos?.conversationId) {
      ventana?.webContents.send('whatswv:abrir-conversacion', datos.conversationId);
    }
  });

  aviso.show();
});

ipcMain.handle('whatswv:guardar-servidor', async (_e, url) => {
  const base = normalizarUrl(url);
  if (!base) return { ok: false, error: 'Escribe la dirección del servidor.' };

  if (!(await esServidorValido(base))) {
    return {
      ok: false,
      error: 'No hay un servidor WhatsWV en esa dirección. Revisa que esté bien escrita y que el servidor esté encendido.',
    };
  }

  guardarConfig({ servidor: base });
  await ventana.loadURL(base);
  return { ok: true };
});

ipcMain.handle('whatswv:reintentar', async () => {
  await abrirBandeja();
});

ipcMain.handle('whatswv:cambiar-servidor', async () => {
  pedirServidor();
});

// --- arranque ----------------------------------------------------------------

// Una sola instancia: dos ventanas contra la misma sesión duplican los avisos.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => mostrarVentana());

  app.whenReady().then(async () => {
    crearVentana();
    crearBandeja();
    await abrirBandeja();

    // Si el servidor se cae mientras el asesor trabaja, la pantalla propia
    // explica qué pasa; el error de Chromium no le dice nada a nadie.
    ventana.webContents.on('did-fail-load', (_e, codigo, _desc, url, esPrincipal) => {
      // -3 es ERR_ABORTED: pasa en navegaciones normales y no es una caída.
      if (esPrincipal && codigo !== -3 && !url.startsWith('file://')) {
        mostrarCaida(leerConfig().servidor);
      }
    });
  });

  app.on('before-quit', () => {
    cerrandoDeVerdad = true;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
