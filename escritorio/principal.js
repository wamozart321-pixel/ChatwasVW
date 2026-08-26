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
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, Notification, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
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
      // La version a la vista: cuando un asesor dice "no me anda", lo primero
      // que hay que saber es que version tiene, y no habia forma de averiguarlo.
      { label: `WhatsWV ${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: 'Abrir WhatsWV', click: () => mostrarVentana() },
      { type: 'separator' },
      { label: 'Recargar', click: () => ventana?.reload() },
      { label: 'Buscar actualizaciones…', click: () => buscarActualizacion(true) },
      { label: 'Cambiar servidor…', click: () => pedirServidor() },
      {
        label: 'Copiar datos para soporte',
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(
            `WhatsWV ${app.getVersion()} · servidor ${leerConfig().servidor} · ${process.platform}`,
          );
        },
      },
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

// --- actualizaciones ---------------------------------------------------------

/**
 * Se actualiza sola contra el mismo servidor que sirve el instalador.
 *
 * No usa las Releases de GitHub a propósito. Con un repositorio privado habría
 * que meterle un token de GitHub a la app, y ese token termina en la máquina de
 * cada asesor; con uno público habría que publicar todo el código para que se
 * pueda bajar un .exe. El servidor del negocio ya sirve el instalador por HTTPS
 * y no necesita ninguna cuenta de por medio.
 */
let revisandoAMano = false;

function prepararActualizador() {
  autoUpdater.autoDownload = true;

  // Se instala al cerrar. Un asesor con una conversación abierta no puede
  // quedarse sin la ventana porque salió una versión nueva.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    if (!ventana) return;

    dialog
      .showMessageBox(ventana, {
        type: 'info',
        title: 'Actualización lista',
        message: `Hay una versión nueva de WhatsWV (${info.version}).`,
        detail:
          'Ya está descargada. Se instala sola la próxima vez que cierres la app, ' +
          'o podés reiniciar ahora si no estás en medio de una conversación.',
        buttons: ['Reiniciar ahora', 'Más tarde'],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          cerrandoDeVerdad = true;
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('update-not-available', () => {
    if (!revisandoAMano) return;
    revisandoAMano = false;
    dialog.showMessageBox(ventana, {
      type: 'info',
      title: 'WhatsWV',
      message: 'Ya tenés la última versión.',
      detail: `Versión ${app.getVersion()}.`,
      buttons: ['Listo'],
    });
  });

  autoUpdater.on('error', (e) => {
    // Sin internet o con el servidor caído esto falla, y no es motivo para
    // molestar a nadie: la app funciona igual. Sólo se avisa si lo pidieron.
    console.error('actualizador:', e?.message ?? e);
    if (!revisandoAMano) return;
    revisandoAMano = false;
    dialog.showMessageBox(ventana, {
      type: 'warning',
      title: 'WhatsWV',
      message: 'No se pudo comprobar si hay actualizaciones.',
      detail: 'Revisá la conexión a internet e intentá de nuevo más tarde.',
      buttons: ['Listo'],
    });
  });
}

function buscarActualizacion(aMano = false) {
  // En desarrollo no hay nada empaquetado contra qué comparar.
  if (!app.isPackaged) {
    if (aMano && ventana) {
      dialog.showMessageBox(ventana, {
        type: 'info',
        title: 'WhatsWV',
        message: 'El actualizador sólo corre en la app instalada.',
        buttons: ['Listo'],
      });
    }
    return;
  }

  revisandoAMano = aMano;
  autoUpdater.checkForUpdates().catch(() => undefined);
}

// --- arranque ----------------------------------------------------------------

// Una sola instancia: dos ventanas contra la misma sesión duplican los avisos.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => mostrarVentana());

  app.whenReady().then(async () => {
    crearVentana();
    crearBandeja();
    prepararActualizador();
    await abrirBandeja();

    // La primera revisión va con retraso para no competir con la carga de la
    // bandeja, y después cada 4 horas: alcanza para que una corrección llegue
    // el mismo día sin estar golpeando el servidor.
    setTimeout(() => buscarActualizacion(), 30_000);
    setInterval(() => buscarActualizacion(), 4 * 60 * 60 * 1000);

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
