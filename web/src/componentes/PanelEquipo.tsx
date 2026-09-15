import { useEffect, useState } from 'react';
import { api, type Asesor, type ChatDeAsesor, type MiembroEquipo } from '../api';

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
  }, [abierto]);

  useEffect(() => {
    let vigente = true;

    const cargar = () =>
      api
        .equipo()
        .then((e) => vigente && setEquipo(e))
        .catch(() => vigente && setError('No se pudo cargar el equipo'));

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
                  onClick={() => {
                    if (!puedeVerChats || m.activas === 0) return;
                    setAbierto((a) => (a === m.id ? null : m.id));
                  }}
                  className={`px-4 py-2.5 ${
                    puedeVerChats && m.activas > 0 ? 'cursor-pointer hover:bg-slate-50' : ''
                  }`}
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
                  {puedeVerChats && m.activas > 0 && (
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
