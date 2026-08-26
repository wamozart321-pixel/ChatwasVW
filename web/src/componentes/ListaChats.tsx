import { useState } from 'react';
import type { Conversacion, Etiqueta } from '../api';

const ESTADOS = [
  { id: 'todas', etiqueta: 'Todas' },
  { id: 'abierto', etiqueta: 'Abierto' },
  { id: 'pendiente', etiqueta: 'Pendiente' },
  { id: 'resuelto', etiqueta: 'Resuelto' },
];

const ASIGNACION = [
  { id: 'todos', etiqueta: 'Todo el equipo' },
  { id: 'mios', etiqueta: 'Míos' },
  { id: 'sin_asignar', etiqueta: 'Sin asignar' },
];

function horaCorta(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) {
    return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }
  if (d.toDateString() === new Date(hoy.getTime() - 86_400_000).toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
}

const COLORES_ETIQUETA: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-600',
  green: 'bg-marca-100 text-marca-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
  sky: 'bg-sky-100 text-sky-700',
  violet: 'bg-violet-100 text-violet-700',
};

function iniciales(nombre: string | null, telefono: string): string {
  if (!nombre) return telefono.slice(-2);
  return nombre
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Un tilde gris, dos grises, dos azules; la cruz roja es envío fallido. */
function Checks({ status }: { status: string | null }) {
  if (!status) return null;
  if (status === 'failed') return <span className="text-red-500">✕</span>;
  if (status === 'queued') return <span className="text-slate-400">🕘</span>;

  return (
    <span className={status === 'read' ? 'text-sky-500' : 'text-slate-400'}>
      {status === 'sent' ? '✓' : '✓✓'}
    </span>
  );
}

export default function ListaChats({
  conversaciones,
  seleccionada,
  filtro,
  asignado,
  busqueda,
  asesorId,
  etiquetas,
  etiquetaFiltro,
  onFiltro,
  onAsignado,
  onBusqueda,
  onEtiquetaFiltro,
  onSeleccionar,
  onNuevoChat,
  conteo,
}: {
  conversaciones: Conversacion[];
  seleccionada: string | null;
  filtro: string;
  asignado: string;
  busqueda: string;
  asesorId: string;
  etiquetas: Etiqueta[];
  etiquetaFiltro: string;
  onFiltro: (v: string) => void;
  onAsignado: (v: string) => void;
  onBusqueda: (v: string) => void;
  onEtiquetaFiltro: (v: string) => void;
  onSeleccionar: (id: string) => void;
  onNuevoChat: () => void;
  conteo: Record<string, number> | null;
}) {
  const sinLeer = conversaciones.reduce((n, c) => n + (c.noLeidos > 0 ? 1 : 0), 0);
  const [verTodasEtiquetas, setVerTodasEtiquetas] = useState(false);

  // Con muchas etiquetas la fila se come la barra lateral, que es donde va lo
  // que de verdad importa: los chats. Se muestran las primeras y el resto se
  // despliega a pedido.
  const VISIBLES = 8;
  const etiquetasVisibles =
    verTodasEtiquetas || etiquetas.length <= VISIBLES
      ? etiquetas
      : etiquetas.slice(0, VISIBLES);

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">Chats</h2>
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-slate-500">
              {conversaciones.length} · {sinLeer} sin leer
            </span>
            <button
              onClick={onNuevoChat}
              title="Escribirle a un número"
              className="rounded-lg bg-marca-600 px-2 py-0.5 text-sm font-medium leading-5 text-white transition hover:bg-marca-700"
            >
              +
            </button>
          </div>
        </div>

        <input
          value={busqueda}
          onChange={(e) => onBusqueda(e.target.value)}
          placeholder="Buscar nombre o número"
          className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm outline-none focus:border-marca-500 focus:bg-white"
        />

        <div className="mt-3 flex gap-1.5">
          {ASIGNACION.map((f) => (
            <button
              key={f.id}
              onClick={() => onAsignado(f.id)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${
                asignado === f.id
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.etiqueta}
            </button>
          ))}
        </div>

        <div className="mt-2 flex gap-1.5">
          {ESTADOS.map((f) => {
            // El numero al lado hace visible si el trabajo se esta acumulando.
            // Sin el, "Abierto" es una palabra y nadie sabe si son 3 o 300.
            const n = conteo?.[f.id];
            return (
              <button
                key={f.id}
                onClick={() => onFiltro(f.id)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  filtro === f.id
                    ? 'bg-marca-500 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {f.etiqueta}
                {n !== undefined && (
                  <span className={filtro === f.id ? 'ml-1 text-white/80' : 'ml-1 text-slate-400'}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Sólo aparece si hay etiquetas creadas: un filtro vacío es ruido. */}
        {etiquetas.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {etiquetasVisibles.map((e) => {
              const activa = etiquetaFiltro === e.id;
              return (
                <button
                  key={e.id}
                  // Volver a tocar la misma la quita: es un filtro, no un modo.
                  onClick={() => onEtiquetaFiltro(activa ? '' : (e.id ?? ''))}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
                    activa
                      ? 'bg-slate-800 text-white'
                      : (COLORES_ETIQUETA[e.color] ?? COLORES_ETIQUETA.slate)
                  }`}
                >
                  {e.nombre}
                </button>
              );
            })}

            {etiquetas.length > VISIBLES && (
              <button
                onClick={() => setVerTodasEtiquetas((v) => !v)}
                className="text-[10px] text-slate-400 underline hover:text-slate-600"
              >
                {verTodasEtiquetas ? 'ver menos' : `+${etiquetas.length - VISIBLES} más`}
              </button>
            )}

            {etiquetaFiltro && (
              <button
                onClick={() => onEtiquetaFiltro('')}
                className="text-[10px] text-slate-400 underline hover:text-slate-600"
              >
                quitar
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversaciones.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-400">
            {etiquetaFiltro
              ? 'Ninguna con esa etiqueta'
              : asignado === 'sin_asignar'
                ? 'Nada en la cola. Buen trabajo.'
                : 'Sin conversaciones'}
          </p>
        )}

        {conversaciones.map((c) => {
          const activa = c.id === seleccionada;
          const mia = c.asignadoId === asesorId;

          return (
            <button
              key={c.id}
              onClick={() => onSeleccionar(c.id)}
              className={`flex w-full gap-3 border-b border-slate-100 px-4 py-3 text-left transition ${
                activa ? 'bg-marca-50' : 'hover:bg-slate-50'
              }`}
            >
              <div className="relative shrink-0">
                <div className="flex size-10 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                  {iniciales(c.contacto, c.telefono)}
                </div>
                {/* Punto ámbar: la ventana de 24 h está cerrada, sólo plantilla. */}
                {!c.ventanaAbierta && (
                  <span
                    title="Ventana de 24 h cerrada"
                    className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-white bg-amber-400"
                  />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {c.contacto ?? `+${c.telefono}`}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {horaCorta(c.ultimoMensaje)}
                  </span>
                </div>

                <div className="mt-0.5 flex items-center gap-1.5">
                  {c.vistaPreviaDireccion === 'out' && <Checks status={c.vistaPreviaEstado} />}
                  <span className="truncate text-xs text-slate-500">
                    {c.vistaPrevia ?? 'Sin mensajes'}
                  </span>
                  {c.noLeidos > 0 && (
                    <span className="ml-auto shrink-0 rounded-full bg-marca-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {c.noLeidos}
                    </span>
                  )}
                </div>

                {c.etiquetas?.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.etiquetas.slice(0, 3).map((e) => (
                      <span
                        key={e.nombre}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          COLORES_ETIQUETA[e.color] ?? COLORES_ETIQUETA.slate
                        }`}
                      >
                        {e.nombre}
                      </span>
                    ))}
                    {c.etiquetas.length > 3 && (
                      <span className="text-[10px] text-slate-400">
                        +{c.etiquetas.length - 3}
                      </span>
                    )}
                  </div>
                )}

                {/* Quién la tiene. Lo que evita que dos asesores contesten lo mismo. */}
                <div className="mt-1">
                  {c.asignadoId ? (
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        mia ? 'bg-marca-100 text-marca-700' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {mia ? 'Vos' : c.asignadoNombre}
                    </span>
                  ) : (
                    <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      Sin asignar
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
