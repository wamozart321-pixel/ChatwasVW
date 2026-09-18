import { useEffect, useState } from 'react';
import { api, type Asesor, type ChatDeAsesor, type Conversacion, type MiembroEquipo } from '../api';

/** Hace cuánto que el cliente escribió, para ver qué lleva más esperando. */
function haceCuanto(iso: string | null): string {
  if (!iso) return 'sin mensajes';

  const minutos = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutos < 1) return 'recién';
  if (minutos < 60) return `hace ${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  return `hace ${Math.floor(horas / 24)} d`;
}

/** Cómo está un cliente de la búsqueda, visto desde el asesor al que se le quiere dar. */
function comoEsta(c: Conversacion, asesorId: string): { texto: string; puede: boolean } {
  if (c.estado !== 'resuelto' && c.asignadoId === asesorId) return { texto: 'ya es suyo', puede: false };
  if (c.estado === 'resuelto') return { texto: 'resuelta · se reabre', puede: true };
  return { texto: c.asignadoNombre ? `de ${c.asignadoNombre}` : 'sin asignar', puede: true };
}

/**
 * Quién está conectado y cuánto tiene encima cada uno.
 *
 * Es la vista que responde "¿por qué la cola no baja?" sin abrir la base: si
 * alguien está al tope, el ruteo pegajoso deja de mandarle trabajo y todo cae
 * a la cola común.
 */
export default function PanelEquipo({
  yo,
  onCerrar,
  onAbrirConversacion,
}: {
  yo: Asesor;
  onCerrar: () => void;
  onAbrirConversacion: (id: string) => void;
}) {
  const [equipo, setEquipo] = useState<MiembroEquipo[] | null>(null);
  const [error, setError] = useState('');

  /**
   * Qué asesor está desplegado, y sus conversaciones.
   *
   * El número solo no alcanza para supervisar: «doce» no dice si son doce que
   * avanzan o doce olvidadas desde ayer.
   */
  const [abierto, setAbierto] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatDeAsesor[] | null>(null);

  // Sólo quien supervisa. El servidor lo vuelve a comprobar: esconderlo no es
  // seguridad, es no ofrecer lo que no corresponde.
  const puedeVerChats = yo.rol !== 'asesor';

  /*
   * Repartir la cola de a varios.
   *
   * Pasar un chat puntual se hace desde el chat mismo; esto es para "dale cinco a
   * Andrés", que de a uno es medio minuto de clics con la cola llena. El número
   * de la cola es el mismo de Métricas → Sin asignar, y el servidor reparte
   * empezando por la que más espera.
   */
  const [enCola, setEnCola] = useState<number | null>(null);
  const [cantidad, setCantidad] = useState(3);
  const [repartiendo, setRepartiendo] = useState(false);
  const [resultado, setResultado] = useState('');
  // Sube para volver a pedir los chats del desplegado después de repartir.
  const [recarga, setRecarga] = useState(0);

  /*
   * Las dos formas de darle trabajo a alguien: una cantidad de la cola, o un
   * cliente puntual buscado por nombre o número. Las dos quedan igual: a mano, a
   * nombre de quien recibe, con aviso.
   */
  const [modo, setModo] = useState<'cola' | 'cliente'>('cola');
  const [busqueda, setBusqueda] = useState('');
  const [resultados, setResultados] = useState<Conversacion[] | null>(null);

  // La búsqueda es la misma de la lista de chats, con un respiro para no pedir
  // una vez por letra. Un cliente con varias conversaciones sale una sola vez: la
  // lista viene por último mensaje, así que queda la viva, o la más reciente.
  useEffect(() => {
    const q = busqueda.trim();
    if (modo !== 'cliente' || q.length < 2) {
      setResultados(null);
      return;
    }

    let vigente = true;
    const t = setTimeout(() => {
      api
        .conversaciones('todas', q, 'todos')
        .then((lista) => {
          if (!vigente) return;
          const vistos = new Set<string>();
          setResultados(
            lista
              .filter((c) => (vistos.has(c.contactoId) ? false : (vistos.add(c.contactoId), true)))
              .slice(0, 6),
          );
        })
        .catch(() => vigente && setResultados([]));
    }, 300);

    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [busqueda, modo]);

  async function darCliente(c: Conversacion, m: MiembroEquipo) {
    setRepartiendo(true);
    setResultado('');
    try {
      const r = await api.asignarCliente(c.id, m.id);
      setResultado(
        `${c.contacto ?? '+' + c.telefono} quedó con ${m.nombre}${r.reabierta ? ' (se reabrió)' : ''}.`,
      );
      setBusqueda('');
      setRecarga((n) => n + 1);
      void api.equipo().then(setEquipo).catch(() => undefined);
    } catch (e) {
      const err = e as { datos?: { mensaje?: string }; message?: string };
      setResultado(err.datos?.mensaje ?? err.message ?? 'No se pudo asignar');
    } finally {
      setRepartiendo(false);
    }
  }

  async function repartir(m: MiembroEquipo) {
    setRepartiendo(true);
    setResultado('');
    try {
      const r = await api.asignarDeLaCola(m.id, cantidad);
      setResultado(
        r.asignadas === 0
          ? 'La cola estaba vacía: no se asignó nada.'
          : r.asignadas < r.pedidas
            ? `Sólo había ${r.asignadas} en la cola: se le asignaron todas.`
            : `Se le asignaron ${r.asignadas}.`,
      );
      setEnCola(r.quedanEnCola);
      setRecarga((n) => n + 1);
      void api.equipo().then(setEquipo).catch(() => undefined);
    } catch (e) {
      const err = e as { datos?: { mensaje?: string }; message?: string };
      setResultado(err.datos?.mensaje ?? err.message ?? 'No se pudo asignar');
    } finally {
      setRepartiendo(false);
    }
  }

  useEffect(() => {
    if (!abierto) return;

    let vigente = true;
    setChats(null);
    api
      .conversacionesDe(abierto)
      .then((c) => vigente && setChats(c))
      .catch(() => vigente && setChats([]));

    return () => {
      vigente = false;
    };
  }, [abierto, recarga]);

  useEffect(() => {
    let vigente = true;

    const cargar = () => {
      // Cuántos esperan, para saber qué se puede repartir. Sólo quien supervisa.
      if (puedeVerChats) {
        void api
          .resumenCola()
          .then((r) => vigente && setEnCola(r.sinAsignar))
          .catch(() => undefined);
      }
      return api
        .equipo()
        .then((e) => vigente && setEquipo(e))
        .catch(() => vigente && setError('No se pudo cargar el equipo'));
    };

    void cargar();

    // Sólo con la ventana a la vista. La app de escritorio vive en la bandeja del
    // sistema y este panel puede quedar abierto toda la noche: preguntando cada
    // diez segundos, no dejaba dormir la base aunque nadie lo estuviera mirando.
    const t = setInterval(() => {
      if (!document.hidden) void cargar();
    }, 10_000);

    return () => {
      vigente = false;
      clearInterval(t);
    };
  }, []);

  return (
    <>
      {/* Capa para cerrar al hacer clic afuera */}
      <div className="fixed inset-0 z-10" onClick={onCerrar} />

      <div className="absolute right-0 top-10 z-20 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
        <div className="border-b border-slate-100 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-slate-900">Equipo</h3>
          <p className="text-[11px] text-slate-400">Carga activa y presencia</p>
        </div>

        {error && <p className="px-4 py-4 text-xs text-red-600">{error}</p>}
        {!equipo && !error && (
          <p className="px-4 py-4 text-xs text-slate-400">Cargando…</p>
        )}

        <div className="max-h-96 overflow-y-auto">
          {equipo?.map((m) => {
            const proporcion = Math.min(1, m.activas / m.tope);
            const alTope = m.activas >= m.tope;

            return (
              <div key={m.id} className="border-b border-slate-50 last:border-0">
                <div
                  // Se despliega aunque tenga cero: a quien no tiene nada es justo a
                  // quien se le quiere dar trabajo, y antes no se podía abrir.
                  onClick={() => {
                    if (!puedeVerChats) return;
                    setAbierto((a) => (a === m.id ? null : m.id));
                    setResultado('');
                  }}
                  className={`px-4 py-2.5 ${puedeVerChats ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                >
                <div className="flex items-center gap-2">
                  <span
                    title={m.conectado ? 'Conectado' : 'Desconectado'}
                    className={`size-2 shrink-0 rounded-full ${
                      m.conectado ? 'bg-marca-500' : 'bg-slate-300'
                    }`}
                  />
                  <span className="truncate text-xs font-medium text-slate-800">{m.nombre}</span>
                  <span className="text-[10px] text-slate-400">{m.rol}</span>

                  <span
                    className={`ml-auto shrink-0 text-[11px] font-medium ${
                      alTope ? 'text-amber-600' : 'text-slate-500'
                    }`}
                  >
                    {m.activas}/{m.tope}
                  </span>
                </div>

                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${alTope ? 'bg-amber-400' : 'bg-marca-500'}`}
                      style={{ width: `${proporcion * 100}%` }}
                    />
                  </div>
                  {m.sinLeer > 0 && (
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {m.sinLeer} sin leer
                    </span>
                  )}
                  {puedeVerChats && (
                    <span className="shrink-0 text-[10px] text-slate-300">
                      {abierto === m.id ? '▾' : '▸'}
                    </span>
                  )}
                </div>
                </div>

                {/*
                  Las conversaciones que tiene encima. Ordenadas por el ultimo
                  mensaje del cliente, la mas vieja arriba: lo que lleva mas
                  tiempo esperando es lo que un supervisor esta buscando.
                */}
                {abierto === m.id && (
                  <div className="border-t border-slate-100 bg-slate-50/60">
                    {chats === null ? (
                      <p className="px-4 py-2 text-[11px] text-slate-400">Cargando…</p>
                    ) : chats.length === 0 ? (
                      <p className="px-4 py-2 text-[11px] text-slate-400">No tiene ninguna</p>
                    ) : (
                      chats.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => {
                            onAbrirConversacion(c.id);
                            onCerrar();
                          }}
                          className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition hover:bg-white"
                        >
                          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">
                            {c.contacto ?? `+${c.telefono}`}
                          </span>

                          {c.sinLeer > 0 && (
                            <span className="shrink-0 rounded-full bg-marca-500 px-1.5 text-[9px] font-semibold text-white">
                              {c.sinLeer}
                            </span>
                          )}

                          <span className="shrink-0 text-[10px] text-slate-400">
                            {haceCuanto(c.ultimoDelCliente)}
                          </span>
                        </button>
                      ))
                    )}

                    <div className="flex gap-1 border-t border-slate-100 px-4 pt-2">
                      {(['cola', 'cliente'] as const).map((k) => (
                        <button
                          key={k}
                          onClick={() => {
                            setModo(k);
                            setResultado('');
                          }}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
                            modo === k
                              ? 'bg-slate-800 text-white'
                              : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                          }`}
                        >
                          {k === 'cola' ? 'Cantidad de la cola' : 'Un cliente'}
                        </button>
                      ))}
                    </div>

                    {modo === 'cliente' ? (
                      <div className="px-4 py-2">
                        <input
                          value={busqueda}
                          onChange={(e) => setBusqueda(e.target.value)}
                          placeholder="Nombre o número del cliente"
                          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-marca-500"
                        />
                        {resultados?.map((c) => {
                          const como = comoEsta(c, m.id);
                          return (
                            <div key={c.id} className="flex items-center gap-2 pt-1.5">
                              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">
                                {c.contacto ?? `+${c.telefono}`}
                              </span>
                              <span className="shrink-0 text-[10px] text-slate-400">{como.texto}</span>
                              <button
                                onClick={() => void darCliente(c, m)}
                                disabled={repartiendo || !como.puede}
                                className="shrink-0 rounded-md bg-marca-500 px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-marca-600 disabled:opacity-40"
                              >
                                Dar
                              </button>
                            </div>
                          );
                        })}
                        {resultados && resultados.length === 0 && (
                          <p className="pt-1.5 text-[10px] text-slate-400">Ningún cliente con eso.</p>
                        )}
                      </div>
                    ) : (
                    <div className="flex items-center gap-1.5 px-4 py-2">
                      <span className="text-[11px] text-slate-600">Darle de la cola</span>
                      <button
                        onClick={() => setCantidad((c) => Math.max(1, c - 1))}
                        className="size-5 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-100"
                      >
                        −
                      </button>
                      <span className="w-5 text-center text-xs font-semibold text-slate-800">
                        {cantidad}
                      </span>
                      <button
                        onClick={() => setCantidad((c) => Math.min(20, c + 1))}
                        className="size-5 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-100"
                      >
                        +
                      </button>
                      <button
                        onClick={() => void repartir(m)}
                        disabled={repartiendo || enCola === 0}
                        className="rounded-md bg-marca-500 px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-marca-600 disabled:opacity-40"
                      >
                        {repartiendo ? '…' : 'Asignar'}
                      </button>
                      <span className="ml-auto text-[10px] text-slate-400">
                        {enCola === null ? '' : enCola === 0 ? 'cola vacía' : `${enCola} esperando`}
                      </span>
                    </div>
                    )}

                    {/* Se puede pasar del tope a propósito —el supervisor sabe algo
                        que el ruteo no—, pero que se vea antes de hacerlo. */}
                    {m.activas + (modo === 'cola' ? cantidad : 1) > m.tope && !resultado && (
                      <p className="px-4 pb-2 text-[10px] text-amber-600">
                        Queda por encima de su tope ({m.tope}).
                      </p>
                    )}
                    {resultado && <p className="px-4 pb-2 text-[10px] text-marca-700">{resultado}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="border-t border-slate-100 px-4 py-2 text-[10px] leading-relaxed text-slate-400">
          Al tope, el ruteo automático deja de asignarle y las conversaciones caen a
          «Sin asignar».
        </p>
      </div>
    </>
  );
}
