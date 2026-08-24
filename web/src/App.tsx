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
} from './api';
import BarraAsignacion from './componentes/BarraAsignacion';
import ConfirmarEliminar from './componentes/ConfirmarEliminar';
import Hilo from './componentes/Hilo';
import ListaChats from './componentes/ListaChats';
import Login from './componentes/Login';
import PanelContacto from './componentes/PanelContacto';
import PanelEquipo from './componentes/PanelEquipo';
import PanelMetricas from './componentes/PanelMetricas';
import PreviaArchivo from './componentes/PreviaArchivo';
import Redactor from './componentes/Redactor';
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

  const [filtro, setFiltro] = useState('todas');
  const [asignado, setAsignado] = useState('todos');
  const [etiquetaFiltro, setEtiquetaFiltro] = useState('');
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState('');
  const [conectado, setConectado] = useState(false);
  const [escribiendo, setEscribiendo] = useState<string[]>([]);
  const [verEquipo, setVerEquipo] = useState(false);
  const [verMetricas, setVerMetricas] = useState(false);
  const [verPlantillas, setVerPlantillas] = useState(false);
  const [archivoPendiente, setArchivoPendiente] = useState<File | null>(null);
  const [maxArchivoMB, setMaxArchivoMB] = useState(16);
  const [porEliminar, setPorEliminar] = useState<Mensaje | null>(null);
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
    api.config().then((c) => setMaxArchivoMB(c.maxArchivoMB)).catch(() => undefined);
    api.etiquetas().then(setEtiquetas).catch(() => undefined);
  }, [asesor]);

  const salir = useCallback(() => {
    sesion.borrar();
    setAsesor(null);
    setSeleccionada(null);
    setConversaciones([]);
  }, []);

  // --- lista ---------------------------------------------------------------

  const cargarLista = useCallback(async () => {
    try {
      const lista = await api.conversaciones(filtro, busqueda, asignado, etiquetaFiltro);
      setConversaciones(lista);
      revisarNovedades(lista);
    } catch (e) {
      if (e instanceof ErrorApi && e.status === 401) salir();
    }
  }, [filtro, busqueda, asignado, etiquetaFiltro, salir, revisarNovedades]);

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
    socket.on('no-autorizado', salir);

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

  async function enviar(texto: string) {
    if (!seleccionada) return;
    setEnviando(true);
    setAviso('');
    try {
      const m = await api.enviar(seleccionada, texto);
      setMensajes((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
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
      const m = await api.enviarArchivo(seleccionada, archivoPendiente, caption || undefined);
      setMensajes((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      setArchivoPendiente(null);
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
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-marca-500 text-sm font-bold text-white">
          W
        </div>
        <span className="font-semibold text-slate-900">WhatsWV</span>

        <span
          className={`ml-auto flex items-center gap-1.5 text-xs ${
            conectado ? 'text-marca-600' : 'text-slate-400'
          }`}
        >
          <span className={`size-1.5 rounded-full ${conectado ? 'bg-marca-500' : 'bg-slate-300'}`} />
          {conectado ? 'En vivo' : 'Reconectando…'}
        </span>

        <div className="relative ml-4 flex items-center gap-3 border-l border-slate-200 pl-4">
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

          <div className="text-right">
            <p className="text-xs font-medium text-slate-800">{asesor.nombre}</p>
            <p className="text-[10px] text-slate-400">{asesor.rol}</p>
          </div>
          <button onClick={salir} className="text-xs text-slate-400 hover:text-slate-600">
            Salir
          </button>

          {verEquipo && <PanelEquipo onCerrar={() => setVerEquipo(false)} />}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <ListaChats
          conversaciones={conversaciones}
          seleccionada={seleccionada}
          filtro={filtro}
          asignado={asignado}
          busqueda={busqueda}
          asesorId={asesor.id}
          etiquetas={etiquetas}
          etiquetaFiltro={etiquetaFiltro}
          onFiltro={setFiltro}
          onAsignado={setAsignado}
          onBusqueda={setBusqueda}
          onEtiquetaFiltro={setEtiquetaFiltro}
          onSeleccionar={setSeleccionada}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {!actual ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 bg-slate-50 text-slate-400">
              <p className="text-lg font-medium text-slate-500">Ninguna conversación abierta</p>
              <p className="text-sm">Elegí un chat de la lista</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-2.5">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    {actual.contacto ?? `+${actual.telefono}`}
                  </h3>
                  <p className="text-xs text-slate-400">+{actual.telefono}</p>
                </div>

                <div className="ml-auto flex gap-1.5">
                  {ESTADOS.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => accion(() => api.cambiarEstado(seleccionada!, e.id))}
                      className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                        actual.estado === e.id
                          ? 'bg-slate-800 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {e.etiqueta}
                    </button>
                  ))}
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
                <div className="bg-slate-50 px-6 pb-1 text-xs italic text-slate-500">
                  {escribiendo.join(' y ')} {escribiendo.length > 1 ? 'están' : 'está'} escribiendo…
                </div>
              )}

              {aviso && (
                <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">
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
                onPlantilla={() => setVerPlantillas(true)}
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

      {archivoPendiente && (
        <PreviaArchivo
          archivo={archivoPendiente}
          maxMB={maxArchivoMB}
          enviando={enviando}
          onEnviar={enviarArchivo}
          onCancelar={() => setArchivoPendiente(null)}
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
