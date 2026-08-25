import { useEffect, useRef } from 'react';
import type { Mensaje, Nota } from '../api';
import Media from './Media';

function hora(iso: string) {
  return new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function diaLegible(iso: string) {
  const d = new Date(iso);
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) return 'Hoy';
  if (d.toDateString() === new Date(hoy.getTime() - 86_400_000).toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { day: 'numeric', month: 'long' });
}

function Checks({ status }: { status: Mensaje['status'] }) {
  if (status === 'failed') return <span className="text-red-200">✕</span>;
  if (status === 'queued') return <span className="opacity-60">🕘</span>;
  if (status === 'read') return <span className="text-sky-300">✓✓</span>;
  return <span className="opacity-70">{status === 'sent' ? '✓' : '✓✓'}</span>;
}

/** Las notas se intercalan en el hilo por hora, pero en amarillo y sin burbuja. */
type Entrada =
  | { clase: 'mensaje'; cuando: string; mensaje: Mensaje }
  | { clase: 'nota'; cuando: string; nota: Nota };

export default function Hilo({
  mensajes,
  notas,
  onBorrarNota,
  puedeBorrar,
  onEliminarMensaje,
  puedeEliminar,
}: {
  mensajes: Mensaje[];
  notas: Nota[];
  onBorrarNota: (id: string) => void;
  puedeBorrar: (nota: Nota) => boolean;
  onEliminarMensaje: (m: Mensaje) => void;
  puedeEliminar: (m: Mensaje) => boolean;
}) {
  const finRef = useRef<HTMLDivElement>(null);

  // Baja al ultimo mensaje al abrir el chat y cuando entra uno nuevo.
  useEffect(() => {
    finRef.current?.scrollIntoView({ block: 'end' });
  }, [mensajes.length, notas.length]);

  let ultimoDia = '';

  const entradas: Entrada[] = [
    ...mensajes.map((m): Entrada => ({ clase: 'mensaje', cuando: m.cuando, mensaje: m })),
    ...notas.map((n): Entrada => ({ clase: 'nota', cuando: n.cuando, nota: n })),
  ].sort((a, b) => new Date(a.cuando).getTime() - new Date(b.cuando).getTime());

  return (
    <div className="flex-1 space-y-1 overflow-y-auto bg-slate-50 px-6 py-4">
      {entradas.map((entrada) => {
        const dia = diaLegible(entrada.cuando);
        const separador = dia !== ultimoDia;
        ultimoDia = dia;

        if (entrada.clase === 'nota') {
          const n = entrada.nota;
          return (
            <div key={`nota-${n.id}`}>
              {separador && (
                <div className="my-4 flex justify-center">
                  <span className="rounded-full bg-white px-3 py-1 text-[11px] font-medium text-slate-500 shadow-sm">
                    {dia}
                  </span>
                </div>
              )}
              <div className="flex justify-center">
                <div className="group max-w-[75%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      Nota interna · {n.autor ?? 'alguien'}
                    </span>
                    <span className="text-[10px] text-amber-500">{hora(n.cuando)}</span>
                    {puedeBorrar(n) && (
                      <button
                        onClick={() => onBorrarNota(n.id)}
                        className="ml-auto text-[10px] text-amber-400 opacity-0 transition group-hover:opacity-100 hover:text-amber-700"
                      >
                        borrar
                      </button>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm text-amber-900">
                    {n.cuerpo}
                  </p>
                </div>
              </div>
            </div>
          );
        }

        const m = entrada.mensaje;
        const mio = m.direccion === 'out';

        if (m.eliminado) {
          return (
            <div key={m.id}>
              {separador && (
                <div className="my-4 flex justify-center">
                  <span className="rounded-full bg-white px-3 py-1 text-[11px] font-medium text-slate-500 shadow-sm">
                    {dia}
                  </span>
                </div>
              )}
              <div className={`flex ${mio ? 'justify-end' : 'justify-start'}`}>
                <div className="rounded-2xl border border-dashed border-slate-300 px-3 py-1.5 text-[11px] italic text-slate-400">
                  Mensaje eliminado{m.eliminadoPor ? ` por ${m.eliminadoPor}` : ''} · {hora(m.cuando)}
                </div>
              </div>
            </div>
          );
        }

        return (
          <div key={m.id}>
            {separador && (
              <div className="my-4 flex justify-center">
                <span className="rounded-full bg-white px-3 py-1 text-[11px] font-medium text-slate-500 shadow-sm">
                  {dia}
                </span>
              </div>
            )}

            <div className={`group flex items-center gap-1.5 ${mio ? 'justify-end' : 'justify-start'}`}>
              {mio && puedeEliminar(m) && (
                <button
                  onClick={() => onEliminarMensaje(m)}
                  title="Eliminar de la bandeja"
                  className="shrink-0 rounded p-1 text-xs text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
                >
                  🗑
                </button>
              )}

              <div
                className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                  mio
                    ? m.status === 'failed'
                      ? 'bg-red-500 text-white'
                      : m.esBot
                        ? // El bot va en gris, no en el verde del equipo: se lee
                          // de un vistazo qué contestó una persona y qué no.
                          'bg-slate-500 text-white'
                        : 'bg-marca-500 text-white'
                    : 'bg-white text-slate-800'
                }`}
              >
                {m.esBot && (
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/60">
                    Respuesta automática
                  </div>
                )}
                {m.mediaMime && (
                  <div className="mb-1.5">
                    <Media mensaje={m} mio={mio} />
                  </div>
                )}

                {/*
                  El tipo crudo sólo se muestra cuando aporta algo. En un
                  'interactive' el texto ya es el botón que el cliente tocó, así
                  que un cartel que dice INTERACTIVE es ruido.
                */}
                {m.tipo !== 'text' &&
                  m.tipo !== 'interactive' &&
                  m.tipo !== 'location' &&
                  !m.mediaMime && (
                    <div
                      className={`mb-1 text-[11px] font-medium uppercase tracking-wide ${
                        mio ? 'text-white/70' : 'text-slate-400'
                      }`}
                    >
                      {m.tipo}
                    </div>
                  )}

                {/*
                  Ubicación: se pinta como una tarjeta con enlace al mapa. Un par
                  de coordenadas sueltas no le sirve a nadie; lo que el asesor
                  necesita es poder abrirlas y ver dónde queda.
                */}
                {m.tipo === 'location' && m.ubicacionLat != null && m.ubicacionLon != null && (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${m.ubicacionLat},${m.ubicacionLon}`}
                    target="_blank"
                    rel="noreferrer"
                    className={`mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 transition ${
                      mio ? 'bg-white/15 hover:bg-white/25' : 'bg-slate-100 hover:bg-slate-200'
                    }`}
                  >
                    <span className="text-lg leading-none">📍</span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium underline underline-offset-2">
                        Ver en el mapa
                      </span>
                      <span
                        className={`block text-[10px] ${mio ? 'text-white/70' : 'text-slate-500'}`}
                      >
                        {m.ubicacionLat.toFixed(5)}, {m.ubicacionLon.toFixed(5)}
                      </span>
                    </span>
                  </a>
                )}

                {/* Con archivo, el cuerpo es el epigrafe: si no hay, no se pinta nada. */}
                {(m.cuerpo || !m.mediaMime) && (
                  <p className="whitespace-pre-wrap break-words">{m.cuerpo ?? '(sin texto)'}</p>
                )}

                <div
                  className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
                    mio ? 'text-white/70' : 'text-slate-400'
                  }`}
                >
                  <span>{hora(m.cuando)}</span>
                  {mio && <Checks status={m.status} />}
                </div>

                {m.status === 'failed' && m.errorMessage && (
                  <p className="mt-1 border-t border-white/25 pt-1 text-[10px] text-white/90">
                    {m.errorMessage.split('|')[0]}
                  </p>
                )}
              </div>

              {!mio && puedeEliminar(m) && (
                <button
                  onClick={() => onEliminarMensaje(m)}
                  title="Eliminar de la bandeja"
                  className="shrink-0 rounded p-1 text-xs text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
                >
                  🗑
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div ref={finRef} />
    </div>
  );
}
