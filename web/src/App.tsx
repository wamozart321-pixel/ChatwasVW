import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alAbrirConversacion, avisar, enEscritorio, reportarSinLeer } from './escritorio';
import type { Socket } from 'socket.io-client';
import {
  api,
  conectarSocket,
  ErrorApi,
  sesion,
  type Asesor,
  type Conversacion,
  type DetalleConversacion,
  type Etiqueta,
  type Mensaje,
  type Nota,
  type UbicacionNegocio,
} from './api';
import BarraAsignacion from './componentes/BarraAsignacion';
import ConfirmarEliminar from './componentes/ConfirmarEliminar';
import Hilo from './componentes/Hilo';
import ListaChats from './componentes/ListaChats';
import Login from './componentes/Login';
import PanelContacto from './componentes/PanelContacto';
import PanelEquipo from './componentes/PanelEquipo';
import NuevoChat from './componentes/NuevoChat';
import PanelUsuarios from './componentes/PanelUsuarios';
import PanelMetricas from './componentes/PanelMetricas';
import PreviaArchivo from './componentes/PreviaArchivo';
import ActualizarApp from './componentes/ActualizarApp';
import Redactor from './componentes/Redactor';
import Reenviar from './componentes/Reenviar';
import SelectorPlantilla from './componentes/SelectorPlantilla';

const ESTADOS = [
  { id: 'abierto', etiqueta: 'Abierto' },
  { id: 'pendiente', etiqueta: 'Pendiente' },
  { id: 'resuelto', etiqueta: 'Resuelto' },
] as const;

export default function App() {
  const [asesor, setAsesor] = useState<Asesor | null>(null);
  const [comprobando, setComprobando] = useState(true);

  const [conversaciones, setConversaciones] = useState<Conversacion[]>([]);
  const [seleccionada, setSeleccionada] = useState<string | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [detalle, setDetalle] = useState<DetalleConversacion | null>(null);
  const [notas, setNotas] = useState<Nota[]>([]);
  const [asesores, setAsesores] = useState<Asesor[]>([]);

  // Arranca en 'activas': todo lo que no esta resuelto. Con 'todas' se mezcla
  // el archivo de meses con lo de hoy, y con 'sin_leer' desaparece de la vista
  // el chat que el asesor esta atendiendo en ese momento, apenas lo lee.
  const [filtro, setFiltro] = useState('activas');
  const [asignado, setAsignado] = useState('todos');
  const [etiquetaFiltro, setEtiquetaFiltro] = useState('');
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState('');
  const [conectado, setConectado] = useState(false);
  const [escribiendo, setEscribiendo] = useState<string[]>([]);
  const [verEquipo, setVerEquipo] = useState(false);
  const [verUsuarios, setVerUsuarios] = useState(false);
  const [verNuevoChat, setVerNuevoChat] = useState(false);
  const [conteo, setConteo] = useState<Record<string, number> | null>(null);
  const [verMetricas, setVerMetricas] = useState(false);
  const [verPlantillas, setVerPlantillas] = useState(false);
  const [archivoPendiente, setArchivoPendiente] = useState<File | null>(null);
  const [maxArchivoMB, setMaxArchivoMB] = useState(16);
  const [maxVideoMB, setMaxVideoMB] = useState(64);
  const [ubicacionNegocio, setUbicacionNegocio] = useState<UbicacionNegocio | null>(null);
  const [porEliminar, setPorEliminar] = useState<Mensaje | null>(null);
  const [respondiendoA, setRespondiendoA] = useState<Mensaje | null>(null);
  const [porReenviar, setPorReenviar] = useState<Mensaje | null>(null);
  const [verContacto, setVerContacto] = useState(false);
  const [eliminando, setEliminando] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const seleccionadaRef = useRef<string | null>(null);
  seleccionadaRef.current = seleccionada;

  // Cuántos sin leer tenía cada conversación la última vez, para saber cuáles
  // subieron. El servidor no manda un evento por conversación ajena a la que
  // está abierta, así que la novedad se deduce comparando dos listas.
  const noLeidosPrevios = useRef<Map<string, number> | null>(null);

  /**
   * Avisa por el sistema de lo que le entró al asesor mientras miraba otra cosa.
   *
   * Sólo de lo propio y sólo de lo que no tiene abierto: un aviso por cada
   * mensaje del equipo entero convierte la app en algo que se silencia el
   * primer día.
   */
  const revisarNovedades = useCallback(
    (lista: Conversacion[]) => {
      if (!asesor) return;

      const mias = lista.filter((c) => c.asignadoId === asesor.id);
      const previos = noLeidosPrevios.current;

      // La primera carga no avisa: al abrir la app, todo lo pendiente sería nuevo.
      if (previos && enEscritorio()) {
        for (const c of mias) {
          const antes = previos.get(c.id) ?? 0;
          if (c.noLeidos > antes && c.id !== seleccionadaRef.current) {
            avisar({
              titulo: c.contacto ?? c.telefono,
              cuerpo: c.vistaPrevia ?? 'Mensaje nuevo',
              conversationId: c.id,
            });
          }
        }
      }

      noLeidosPrevios.current = new Map(lista.map((c) => [c.id, c.noLeidos]));
      reportarSinLeer(mias.filter((c) => c.noLeidos > 0).length);
    },
    [asesor],
  );

  // Clic en un aviso del sistema: abre esa conversación.
  useEffect(() => {
    alAbrirConversacion((id) => setSeleccionada(id));
  }, []);

  // --- sesión --------------------------------------------------------------

  useEffect(() => {
    if (!sesion.token()) {
      setComprobando(false);
      return;
    }
    api
      .yo()
      .then(setAsesor)
      .catch(() => sesion.borrar())
      .finally(() => setComprobando(false));
  }, []);

  useEffect(() => {
    if (!asesor) return;
    api.asesores().then(setAsesores).catch(() => undefined);
    api
      .config()
      .then((c) => {
        setMaxArchivoMB(c.maxArchivoMB);
        setMaxVideoMB(c.maxVideoMB);
        setUbicacionNegocio(c.ubicacionNegocio);
      })
      .catch(() => undefined);
    api.etiquetas().then(setEtiquetas).catch(() => undefined);
  }, [asesor]);

  const salir = useCallback((motivo?: string) => {
    // Si lo echaron —entro desde otro aparato, le cambiaron la clave— se anota
    // el motivo para que la pantalla de entrada lo explique en vez de aparecer
    // sin mas, como si algo se hubiera roto.
    if (motivo) sesion.anotarCierre(motivo);
    else void api.salir().catch(() => undefined);

    sesion.borrar();
    setAsesor(null);
    setSeleccionada(null);
    setConversaciones([]);
  }, []);

  /** Un 401 puede traer el motivo del cierre; se le pasa a la pantalla de entrada. */
  const salirPor401 = useCallback(
    (e: unknown) => {
      const err = e as ErrorApi;
      salir(err?.datos?.mensaje ?? 'La sesión se cerró. Entrá de nuevo.');
    },
    [salir],
  );

  // --- lista ---------------------------------------------------------------

  const cargarLista = useCallback(async () => {
    try {
      const lista = await api.conversaciones(
        filtro,
        busqueda,
        asignado,
        etiquetaFiltro,
        // La abierta se pide aparte para que no se caiga de la lista al leerla.
        seleccionadaRef.current ?? '',
      );
      setConversaciones(lista);
      revisarNovedades(lista);

      // Los contadores van aparte: la lista viene filtrada por estado, asi que
      // contando sobre ella nunca se sabria cuantas hay en los otros estados.
      api
        .conteoEstados(asignado, busqueda, etiquetaFiltro)
        .then(setConteo)
        .catch(() => undefined);
    } catch (e) {
      if (e instanceof ErrorApi && e.status === 401) salirPor401(e);
    }
  }, [filtro, busqueda, asignado, etiquetaFiltro, salirPor401, revisarNovedades]);

  useEffect(() => {
    if (!asesor) return;
    // Debounce: al tipear en el buscador no se dispara una consulta por tecla.
    const t = setTimeout(cargarLista, busqueda ? 250 : 0);
    return () => clearTimeout(t);
  }, [asesor, cargarLista, busqueda]);

  const refrescarDetalle = useCallback((id: string) => {
    api
      .detalle(id)
      .then((d) => {
        if (seleccionadaRef.current === id) setDetalle(d);
      })
      .catch(() => undefined);
  }, []);

  // --- tiempo real ---------------------------------------------------------

  useEffect(() => {
    if (!asesor) return;

    const socket = conectarSocket();
    socketRef.current = socket;

    socket.on('connect', () => setConectado(true));
    socket.on('disconnect', () => setConectado(false));
    socket.on('no-autorizado', () => salir('La sesión se cerró. Entrá de nuevo.'));

    let pendiente: ReturnType<typeof setTimeout> | null = null;
    socket.on('conversacion:actualizada', ({ conversationId }) => {
      if (pendiente) clearTimeout(pendiente);
      pendiente = setTimeout(() => void cargarLista(), 150);
      // Si es la abierta, el dueño puede haber cambiado bajo los pies del asesor.
      if (conversationId === seleccionadaRef.current) refrescarDetalle(conversationId);
    });

    socket.on('mensaje:nuevo', ({ conversationId, mensaje }) => {
      if (conversationId !== seleccionadaRef.current) return;
      setMensajes((prev) =>
        prev.some((m) => m.id === mensaje.id) ? prev : [...prev, mensaje as Mensaje],
      );

      // Llegó mientras el asesor lo tenía abierto: ya está leído. El servidor
      // tampoco lo cuenta, pero esto además limpia el globito de un mensaje
      // anterior, que no se iba con hacer clic porque el chat ya estaba abierto
      // y no se volvía a marcar como leído.
      if ((mensaje as Mensaje).direccion === 'in') {
        api.leida(conversationId).catch(() => undefined);
      }
    });

    socket.on('mensaje:estado', ({ waMessageId, status }) => {
      setMensajes((prev) =>
        prev.map((m) => (m.waMessageId === waMessageId ? { ...m, status } : m)),
      );
    });

    socket.on('escribiendo', ({ conversationId, asesor: quien }) => {
      if (conversationId !== seleccionadaRef.current) return;
      setEscribiendo((prev) => (prev.includes(quien.nombre) ? prev : [...prev, quien.nombre]));
    });

    socket.on('dejo-de-escribir', ({ conversationId }) => {
      if (conversationId !== seleccionadaRef.current) return;
      setEscribiendo([]);
    });

    socket.on('mensaje:eliminado', ({ conversationId, messageId, por }) => {
      if (conversationId !== seleccionadaRef.current) return;
      setMensajes((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, eliminado: true, eliminadoPor: por, cuerpo: null, mediaMime: null }
            : m,
        ),
      );
    });

    socket.on('nota:nueva', ({ conversationId, nota }) => {
      if (conversationId !== seleccionadaRef.current) return;
      setNotas((prev) => (prev.some((n) => n.id === nota.id) ? prev : [...prev, nota as Nota]));
    });

    // La descarga del archivo termina despues de que el mensaje ya se pinto.
    socket.on('mensaje:media', ({ messageId }) => {
      setMensajes((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, tieneMedia: true } : m)),
      );
    });

    socket.on('conversacion:asignada', ({ conversationId, por }) => {
      const texto = por ? `${por} te pasó una conversación` : 'Te asignaron una conversación';
      setAviso(texto);
      // Este sí sale siempre, aunque la app esté minimizada: es trabajo que
      // acaba de quedar a nombre del asesor y nadie más lo va a atender.
      avisar({ titulo: 'WhatsWV', cuerpo: texto, conversationId });
      void cargarLista();
    });

    return () => {
      if (pendiente) clearTimeout(pendiente);
      socket.close();
      socketRef.current = null;
    };
  }, [asesor, cargarLista, salir, refrescarDetalle]);

  // --- hilo ----------------------------------------------------------------

  useEffect(() => {
    setEscribiendo([]);
    // Al cambiar de chat la cita se descarta: si no, se responderia en una
    // conversacion citando un mensaje de otra.
    setRespondiendoA(null);
    setVerContacto(false);

    if (!seleccionada) {
      setMensajes([]);
      setDetalle(null);
      setNotas([]);
      return;
    }
    let vigente = true;

    socketRef.current?.emit('ver', seleccionada);

    api.hilo(seleccionada).then((m) => {
      if (vigente) setMensajes(m);
    });
    api.detalle(seleccionada).then((d) => {
      if (vigente) setDetalle(d);
    });
    api.notas(seleccionada).then((n) => {
      if (vigente) setNotas(n);
    });

    // Abrir el chat es lo que marca leído y dispara el check azul al cliente.
    api.leida(seleccionada).catch(() => undefined);

    return () => {
      vigente = false;
    };
  }, [seleccionada]);

  const actual = useMemo(
    () => conversaciones.find((c) => c.id === seleccionada) ?? null,
    [conversaciones, seleccionada],
  );

  // --- acciones ------------------------------------------------------------

  /** Nota de voz: va directo, sin epígrafe. */
  async function enviarAudio(archivo: File) {
    if (!seleccionada) return;
    setEnviando(true);
    setAviso('');
    try {
      await api.enviarArchivo(seleccionada, archivo, undefined, respondiendoA?.id);
      setRespondiendoA(null);
    } catch (e) {
      setAviso(e instanceof ErrorApi ? e.message : 'No se pudo enviar la nota de voz');
    } finally {
      setEnviando(false);
    }
  }

  /**
   * Manda una ubicación. El servidor resuelve el enlace de Maps: los cortos
   * hay que seguirlos y Google no manda cabeceras CORS para hacerlo desde acá.
   */
  /** Borra una etiqueta del catálogo. Se la saca a todo el equipo. */
  async function borrarEtiqueta(id: string, nombre: string) {
    if (!confirm(`¿Borrar la etiqueta "${nombre}"? Se le quita a todas las conversaciones.`)) {
      return;
    }

    try {
      const r = await api.borrarEtiqueta(id);
      setAviso(
        r.quitadaDe > 0
          ? `Etiqueta "${nombre}" borrada; se quitó de ${r.quitadaDe} conversaciones`
          : `Etiqueta "${nombre}" borrada`,
      );
      if (etiquetaFiltro === id) setEtiquetaFiltro('');
      api.etiquetas().then(setEtiquetas).catch(() => undefined);
    } catch (e) {
      setAviso(e instanceof ErrorApi ? e.message : 'No se pudo borrar la etiqueta');
    }
  }

  async function enviarUbicacion(datos: {
    latitud?: number;
    longitud?: number;
    texto?: string;
    nombre?: string;
    direccion?: string;
  }) {
    if (!seleccionada) return;
    setEnviando(true);
    setAviso('');
    try {
      await api.enviarUbicacion(seleccionada, datos);
    } catch (e) {
      setAviso(e instanceof ErrorApi ? e.message : 'No se pudo enviar la ubicación');
    } finally {
      setEnviando(false);
    }
  }

  async function enviar(texto: string) {
    if (!seleccionada) return;
    setEnviando(true);
    setAviso('');
    try {
      const m = await api.enviar(seleccionada, texto, respondiendoA?.id);
      setMensajes((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      setRespondiendoA(null);
    } catch (e) {
      const err = e as ErrorApi;
      setAviso(err.datos?.mensaje ?? err.message);
    } finally {
      setEnviando(false);
      void cargarLista();
      refrescarDetalle(seleccionada);
    }
  }

  async function enviarArchivo(caption: string) {
    if (!seleccionada || !archivoPendiente) return;
    setEnviando(true);
    setAviso('');
    try {
      const m = await api.enviarArchivo(
        seleccionada,
        archivoPendiente,
        caption || undefined,
        respondiendoA?.id,
      );
      setMensajes((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      setArchivoPendiente(null);
      setRespondiendoA(null);
    } catch (e) {
      const err = e as ErrorApi;
      setAviso(err.datos?.mensaje ?? err.message);
      // Se mantiene la previa abierta: si fallo, el asesor puede reintentar.
    } finally {
      setEnviando(false);
      void cargarLista();
    }
  }

  async function eliminarMensaje() {
    if (!porEliminar) return;
    setEliminando(true);
    try {
      const r = await api.eliminarMensaje(porEliminar.id);
      // El socket ya lo marca, pero se refleja igual por si el evento se pierde.
      setMensajes((prev) =>
        prev.map((m) =>
          m.id === porEliminar.id
            ? { ...m, eliminado: true, eliminadoPor: asesor?.nombre ?? null, cuerpo: null }
            : m,
        ),
      );
      setPorEliminar(null);
      if (r.llegoAlCliente) {
        setAviso('Salió de la bandeja. El cliente lo sigue viendo en su WhatsApp.');
      }
      void cargarLista();
    } catch (e) {
      setAviso((e as ErrorApi).datos?.mensaje ?? (e as ErrorApi).message);
    } finally {
      setEliminando(false);
    }
  }

  const refrescarEtiquetas = useCallback(() => {
    api.etiquetas().then(setEtiquetas).catch(() => undefined);
  }, []);

  async function agregarNota(cuerpo: string) {
    if (!seleccionada) return;
    const nota = await api.agregarNota(seleccionada, cuerpo);
    setNotas((prev) => (prev.some((n) => n.id === nota.id) ? prev : [...prev, nota]));
  }

  async function borrarNota(id: string) {
    await api.borrarNota(id);
    setNotas((prev) => prev.filter((n) => n.id !== id));
  }

  async function accion(fn: () => Promise<unknown>) {
    if (!seleccionada) return;
    setAviso('');
    try {
      await fn();
    } catch (e) {
      const err = e as ErrorApi;
      // 409 = otro asesor la tomó primero. Es información, no un error del asesor.
      setAviso(err.datos?.mensaje ?? err.message);
    } finally {
      void cargarLista();
      refrescarDetalle(seleccionada);
    }
  }

  // --- render --------------------------------------------------------------

  if (comprobando) {
    return <div className="flex h-full items-center justify-center text-slate-400">Cargando…</div>;
  }

  if (!asesor) return <Login onEntrar={setAsesor} />;

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))]">
        {/* El mismo archivo que el icono de las apps: un solo logo en todos lados. */}
        <img src="/icono-192.png" alt="WhatsWV" className="size-8 shrink-0 rounded-lg" />
        <span className="hidden font-semibold text-slate-900 sm:inline">WhatsWV</span>

        <span
          className={`ml-auto flex items-center gap-1.5 text-xs ${
            conectado ? 'text-marca-600' : 'text-slate-400'
          }`}
        >
          <span className={`size-1.5 rounded-full ${conectado ? 'bg-marca-500' : 'bg-slate-300'}`} />
          {/* En un celular el punto ya dice si hay conexion; el texto no cabe. */}
          <span className="hidden sm:inline">{conectado ? 'En vivo' : 'Reconectando…'}</span>
        </span>

        <div className="relative ml-2 flex items-center gap-1.5 border-l border-slate-200 pl-2 sm:ml-4 sm:gap-3 sm:pl-4">
          <button
            onClick={() => setVerMetricas(true)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            Métricas
          </button>

          <button
            onClick={() => setVerEquipo((v) => !v)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            Equipo
          </button>

          {/* Sólo el admin. El backend lo vuelve a comprobar: esconder el botón
              no es seguridad, es no ofrecer lo que no corresponde. */}
          {asesor.rol === 'admin' && (
            <button
              onClick={() => setVerUsuarios(true)}
              className="rounded-lg border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-50"
            >
              Usuarios
            </button>
          )}

          <div className="hidden text-right sm:block">
            <p className="text-xs font-medium text-slate-800">{asesor.nombre}</p>
            <p className="text-[10px] text-slate-400">{asesor.rol}</p>
          </div>
          <button onClick={() => salir()} className="text-xs text-slate-400 hover:text-slate-600">
            Salir
          </button>

          {verEquipo && <PanelEquipo onCerrar={() => setVerEquipo(false)} />}
          {verUsuarios && asesor.rol === 'admin' && (
            <PanelUsuarios yo={asesor} onCerrar={() => setVerUsuarios(false)} />
          )}
          {verNuevoChat && (
            <NuevoChat
              onCerrar={() => setVerNuevoChat(false)}
              onAbrir={(id) => {
                setVerNuevoChat(false);
                // La lista se recarga para que el chat nuevo aparezca; sin esto
                // se selecciona un id que todavía no está en pantalla.
                void cargarLista();
                setSeleccionada(id);
              }}
            />
          )}
        </div>
      </header>

      <ActualizarApp />

      <div className="flex min-h-0 flex-1">
        {/*
          En un celular no caben la lista y el chat a la vez, asi que se turnan:
          se ve la lista hasta que se elige una conversacion, y de ahi se vuelve
          con la flecha. De md para arriba conviven como siempre.
        */}
        <div className={`${actual ? 'hidden md:flex' : 'flex'} h-full w-full shrink-0 md:w-80`}>
          <ListaChats
            conversaciones={conversaciones}
            seleccionada={seleccionada}
            filtro={filtro}
            asignado={asignado}
            busqueda={busqueda}
            asesorId={asesor.id}
            onNuevoChat={() => setVerNuevoChat(true)}
            conteo={conteo}
            puedeBorrarEtiquetas={asesor.rol !== 'asesor'}
            onBorrarEtiqueta={borrarEtiqueta}
            etiquetas={etiquetas}
            etiquetaFiltro={etiquetaFiltro}
            onFiltro={setFiltro}
            onAsignado={setAsignado}
            onBusqueda={setBusqueda}
            onEtiquetaFiltro={setEtiquetaFiltro}
            onSeleccionar={setSeleccionada}
          />
        </div>

        <main className={`${actual ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {!actual ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 bg-slate-50 text-slate-400">
              <p className="text-lg font-medium text-slate-500">Ninguna conversación abierta</p>
              <p className="text-sm">Elegí un chat de la lista</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 md:px-6">
                {/* Solo en celular: en pantalla grande la lista nunca se fue. */}
                <button
                  onClick={() => setSeleccionada(null)}
                  title="Volver a la lista"
                  className="-ml-1 rounded-lg px-1.5 py-1 text-lg text-slate-500 transition hover:bg-slate-100 md:hidden"
                >
                  ←
                </button>

                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-slate-900">
                    {actual.contacto ?? `+${actual.telefono}`}
                  </h3>
                  <p className="truncate text-xs text-slate-400">+{actual.telefono}</p>
                </div>

                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  {/*
                    La columna de la derecha —etiquetas, notas, datos— no cabe
                    por debajo de 1280 px y quedaba escondida: en el celular no
                    habia forma de etiquetar una conversacion. Este boton la
                    abre a pantalla completa.
                  */}
                  <button
                    onClick={() => setVerContacto(true)}
                    title="Etiquetas y datos del contacto"
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-200 xl:hidden"
                  >
                    🏷
                  </button>

                  {/*
                    Abierto y Pendiente son estados; Resolver es una ACCION. Con
                    los tres iguales nadie cerraba nada y "Abierto" se volvia un
                    cajon donde cae todo y no significa nada.
                  */}
                  {ESTADOS.filter((e) => e.id !== 'resuelto').map((e) => (
                    <button
                      key={e.id}
                      onClick={() => accion(() => api.cambiarEstado(seleccionada!, e.id))}
                      title={
                        e.id === 'abierto'
                          ? 'Se está atendiendo ahora'
                          : 'Esperando algo: al proveedor, o que el cliente decida'
                      }
                      className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                        actual.estado === e.id
                          ? 'bg-slate-800 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {e.etiqueta}
                    </button>
                  ))}

                  {actual.estado === 'resuelto' ? (
                    <button
                      onClick={() => accion(() => api.cambiarEstado(seleccionada!, 'abierto'))}
                      className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      ↩ Reabrir
                    </button>
                  ) : (
                    <button
                      onClick={() => accion(() => api.cambiarEstado(seleccionada!, 'resuelto'))}
                      title="El asunto se terminó: sale de la bandeja"
                      className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-emerald-700"
                    >
                      ✓ Resolver
                    </button>
                  )}
                </div>
              </div>

              {detalle && (
                <BarraAsignacion
                  detalle={detalle}
                  yo={asesor}
                  asesores={asesores}
                  onTomar={() => accion(() => api.tomar(seleccionada!))}
                  onSoltar={() => accion(() => api.soltar(seleccionada!))}
                  onAsignar={(id) => accion(() => api.asignar(seleccionada!, id))}
                />
              )}

              <Hilo
                mensajes={mensajes}
                notas={notas}
                onBorrarNota={borrarNota}
                puedeBorrar={(n) => n.autorId === asesor.id || asesor.rol !== 'asesor'}
                onEliminarMensaje={setPorEliminar}
                onResponder={setRespondiendoA}
                onReenviar={setPorReenviar}
                // Misma regla que aplica el servidor: un asesor saca los entrantes
                // y los que mandó él. Si acá fuera más permisiva, el botón
                // aparecería para terminar en un 403.
                puedeEliminar={(m) =>
                  asesor.rol !== 'asesor' ||
                  m.direccion === 'in' ||
                  m.enviadoPorId === asesor.id
                }
              />

              {escribiendo.length > 0 && (
                <div className="bg-slate-50 px-4 pb-1 text-xs italic text-slate-500 md:px-6">
                  {escribiendo.join(' y ')} {escribiendo.length > 1 ? 'están' : 'está'} escribiendo…
                </div>
              )}

              {aviso && (
                <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 md:px-6">
                  <span>{aviso}</span>
                  <button
                    onClick={() => setAviso('')}
                    className="ml-auto text-amber-500 hover:text-amber-700"
                  >
                    ✕
                  </button>
                </div>
              )}

              <Redactor
                ventanaAbierta={actual.ventanaAbierta}
                ventanaVence={actual.ventanaVence}
                enviando={enviando}
                onEnviar={enviar}
                onArchivo={setArchivoPendiente}
                onAudio={enviarAudio}
                onPlantilla={() => setVerPlantillas(true)}
                onUbicacion={enviarUbicacion}
                ubicacionNegocio={ubicacionNegocio}
                respondiendoA={respondiendoA}
                onCancelarRespuesta={() => setRespondiendoA(null)}
                onEscribiendo={() => socketRef.current?.emit('escribiendo', seleccionada)}
                onDejarDeEscribir={() =>
                  socketRef.current?.emit('dejar-de-escribir', seleccionada)
                }
              />
            </>
          )}
        </main>

        <PanelContacto
          detalle={seleccionada ? detalle : null}
          yo={asesor}
          onAgregarNota={agregarNota}
          onEtiquetasCambiaron={refrescarEtiquetas}
        />
      </div>

      {/*
        El mismo panel, a pantalla completa, para cuando no hay lugar para la
        columna. Es el mismo componente: si se le agrega algo —un dato, una
        accion— aparece en los dos lados sin acordarse de nada.
      */}
      {verContacto && detalle && (
        <div className="fixed inset-0 z-40 bg-white xl:hidden">
          <PanelContacto
            detalle={detalle}
            yo={asesor}
            onAgregarNota={agregarNota}
            onEtiquetasCambiaron={refrescarEtiquetas}
            onCerrar={() => setVerContacto(false)}
            className="h-full w-full overflow-y-auto bg-white pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
          />
        </div>
      )}

      {archivoPendiente && (
        <PreviaArchivo
          archivo={archivoPendiente}
          maxMB={maxArchivoMB}
          maxVideoMB={maxVideoMB}
          enviando={enviando}
          onEnviar={enviarArchivo}
          onCancelar={() => setArchivoPendiente(null)}
        />
      )}

      {porReenviar && seleccionada && (
        <Reenviar
          mensaje={porReenviar}
          deConversacion={seleccionada}
          onCerrar={() => setPorReenviar(null)}
          onListo={(aDonde) => {
            setPorReenviar(null);
            setAviso(`Reenviado a ${aDonde}`);
            void cargarLista();
          }}
        />
      )}

      {porEliminar && (
        <ConfirmarEliminar
          mensaje={porEliminar}
          eliminando={eliminando}
          onConfirmar={eliminarMensaje}
          onCancelar={() => setPorEliminar(null)}
        />
      )}

      {verMetricas && (
        <PanelMetricas
          onCerrar={() => setVerMetricas(false)}
          onAbrirConversacion={(id) => {
            // Abrir el chat es lo que el supervisor quiere hacer apenas ve el
            // numero: se cierra el panel para no dejarlo tapando la bandeja.
            setSeleccionada(id);
            setVerMetricas(false);
          }}
        />
      )}

      {verPlantillas && seleccionada && (
        <SelectorPlantilla
          conversationId={seleccionada}
          onCerrar={() => setVerPlantillas(false)}
          onEnviada={() => {
            void cargarLista();
            void api.hilo(seleccionada).then(setMensajes);
          }}
          onError={setAviso}
        />
      )}
    </div>
  );
}
