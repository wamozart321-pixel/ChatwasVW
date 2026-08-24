import { useEffect, useState } from 'react';
import { api, type FilaCola, type Rendimiento, type ResumenCola } from '../api';

function duracion(segundos: number | null): string {
  if (segundos === null) return '—';
  if (segundos < 60) return `${segundos}s`;
  if (segundos < 3600) return `${Math.round(segundos / 60)} min`;
  const h = Math.floor(segundos / 3600);
  if (h < 24) return `${h} h ${Math.round((segundos % 3600) / 60)} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Verde bajo 5 min, ámbar bajo 30, rojo por encima. */
function colorRespuesta(segundos: number | null): string {
  if (segundos === null) return 'text-slate-400';
  if (segundos < 300) return 'text-marca-600';
  if (segundos < 1800) return 'text-amber-600';
  return 'text-red-600';
}

const CATEGORIAS = [
  { id: 'sin_asignar', etiqueta: 'Sin asignar' },
  { id: 'total', etiqueta: 'Total chats' },
  { id: 'sin_leer', etiqueta: 'Sin leer' },
  { id: 'sin_responder', etiqueta: 'Sin responder' },
  { id: 'espera', etiqueta: 'Espera más vieja' },
] as const;

type Categoria = (typeof CATEGORIAS)[number]['id'];

function Tarjeta({
  etiqueta,
  valor,
  alerta,
  activa,
  onClick,
}: {
  etiqueta: string;
  valor: string;
  alerta?: boolean;
  activa: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition ${
        activa
          ? 'border-slate-800 bg-slate-800'
          : alerta
            ? 'border-amber-200 bg-amber-50 hover:border-amber-300'
            : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <p
        className={`text-[10px] uppercase tracking-wide ${
          activa ? 'text-white/60' : 'text-slate-400'
        }`}
      >
        {etiqueta}
      </p>
      <p
        className={`mt-0.5 text-lg font-semibold ${
          activa ? 'text-white' : alerta ? 'text-amber-700' : 'text-slate-900'
        }`}
      >
        {valor}
      </p>
      <p
        className={`mt-0.5 text-[10px] ${
          activa ? 'text-white/50' : 'text-slate-400'
        }`}
      >
        {activa ? 'ocultar' : 'ver cuáles'}
      </p>
    </button>
  );
}

/**
 * Lista de conversaciones detrás de un número del resumen.
 *
 * Ordenada por quién espera hace más: es el orden en que conviene atenderlas.
 * Cada fila abre el chat, que es lo que el supervisor quiere hacer apenas ve
 * el número — no anotarlo y buscarlo después en la bandeja.
 */
function DetalleCola({
  categoria,
  onAbrir,
}: {
  categoria: Categoria;
  onAbrir: (conversationId: string) => void;
}) {
  const [filas, setFilas] = useState<FilaCola[] | null>(null);

  useEffect(() => {
    let vigente = true;
    setFilas(null);
    api
      .detalleCola(categoria)
      .then((f) => vigente && setFilas(f))
      .catch(() => vigente && setFilas([]));
    return () => {
      vigente = false;
    };
  }, [categoria]);

  if (filas === null) {
    return <p className="px-1 py-3 text-xs text-slate-400">Cargando…</p>;
  }

  if (filas.length === 0) {
    return (
      <p className="px-1 py-3 text-xs text-slate-400">
        Nada en esta categoría. Buen trabajo.
      </p>
    );
  }

  return (
    <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200">
      {filas.map((f) => {
        const demorada = (f.esperandoSeg ?? 0) > 1800;

        return (
          <button
            key={f.id}
            onClick={() => onAbrir(f.id)}
            className="flex w-full items-center gap-3 border-b border-slate-50 px-3 py-2 text-left transition last:border-0 hover:bg-slate-50"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-xs font-medium text-slate-800">
                  {f.contacto ?? `+${f.telefono}`}
                </span>
                {!f.ventanaAbierta && (
                  <span
                    title="Ventana de 24 h cerrada"
                    className="shrink-0 text-[10px] text-amber-500"
                  >
                    ⏱
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[10px] text-slate-400">
                {f.asignadoNombre ?? 'sin asignar'} · {f.estado}
              </p>
            </div>

            {f.sinLeer > 0 && (
              <span className="shrink-0 rounded-full bg-marca-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {f.sinLeer}
              </span>
            )}

            <span
              className={`shrink-0 text-[11px] font-medium ${
                demorada ? 'text-red-600' : 'text-slate-500'
              }`}
            >
              {duracion(f.esperandoSeg)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Rendimiento del equipo.
 *
 * La métrica que manda es la mediana de primera respuesta: mide cuánto espera
 * el cliente antes de que alguien le conteste. Mediana y no promedio, porque
 * una sola conversación olvidada un fin de semana arruina cualquier promedio y
 * hace que el número deje de significar nada.
 */
export default function PanelMetricas({
  onCerrar,
  onAbrirConversacion,
}: {
  onCerrar: () => void;
  onAbrirConversacion: (conversationId: string) => void;
}) {
  const [dias, setDias] = useState(7);
  const [datos, setDatos] = useState<Rendimiento[] | null>(null);
  const [cola, setCola] = useState<ResumenCola | null>(null);
  const [abierta, setAbierta] = useState<Categoria | null>(null);

  useEffect(() => {
    let vigente = true;
    api.rendimiento(dias).then((d) => vigente && setDatos(d));
    api.resumenCola().then((c) => vigente && setCola(c));
    return () => {
      vigente = false;
    };
  }, [dias]);

  const conActividad = (datos ?? []).filter((d) => d.atendidas > 0 || d.enviados > 0);

  const valorDe = (id: Categoria): { valor: string; alerta: boolean } => {
    if (!cola) return { valor: '—', alerta: false };
    switch (id) {
      case 'sin_asignar':
        return { valor: String(cola.sinAsignar), alerta: cola.sinAsignar > 0 };
      case 'total':
        return { valor: String(cola.totalChats), alerta: false };
      case 'sin_leer':
        return { valor: String(cola.sinLeer), alerta: false };
      case 'sin_responder':
        // Se marca siempre que haya alguna: son las que nadie contestó, aunque
        // el chat figure leído. Es la que de verdad duele.
        return { valor: String(cola.sinResponder), alerta: cola.sinResponder > 0 };
      case 'espera':
        return {
          valor: duracion(cola.esperaMasVieja),
          alerta: (cola.esperaMasVieja ?? 0) > 1800,
        };
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Rendimiento</h3>
            <p className="text-[11px] text-slate-400">Últimos {dias} días</p>
          </div>

          <div className="ml-auto flex gap-1">
            {[1, 7, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDias(d)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                  dias === d ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {d === 1 ? 'Hoy' : `${d}d`}
              </button>
            ))}
          </div>

          <button onClick={onCerrar} className="text-slate-400 transition hover:text-slate-600">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Cola ahora · tocá un número para ver cuáles
          </h4>

          <div className="grid grid-cols-5 gap-2">
            {CATEGORIAS.map((c) => {
              const { valor, alerta } = valorDe(c.id);
              return (
                <Tarjeta
                  key={c.id}
                  etiqueta={c.etiqueta}
                  valor={valor}
                  alerta={alerta}
                  activa={abierta === c.id}
                  onClick={() => setAbierta((prev) => (prev === c.id ? null : c.id))}
                />
              );
            })}
          </div>

          {abierta && <DetalleCola categoria={abierta} onAbrir={onAbrirConversacion} />}

          {abierta === 'total' && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              Son todas las conversaciones vivas: abiertas y pendientes. Las resueltas
              no cuentan.
            </p>
          )}

          {abierta === 'sin_responder' && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              «Sin responder» no es lo mismo que «sin leer»: acá entran también las que
              alguien abrió —y por eso ya no figuran como no leídas— pero nunca contestó.
            </p>
          )}

          <h4 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Por asesor
          </h4>

          {datos === null && <p className="text-xs text-slate-400">Cargando…</p>}

          {datos !== null && conActividad.length === 0 && (
            <p className="text-xs text-slate-400">
              Sin actividad en el período. Probá con un rango más largo.
            </p>
          )}

          {conActividad.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="pb-2 font-medium">Asesor</th>
                    <th className="pb-2 text-right font-medium">Atendidas</th>
                    <th className="pb-2 text-right font-medium">Resueltas</th>
                    <th className="pb-2 text-right font-medium">Mensajes</th>
                    <th className="pb-2 text-right font-medium">1ª respuesta</th>
                  </tr>
                </thead>
                <tbody>
                  {conActividad.map((d) => (
                    <tr key={d.id} className="border-b border-slate-50">
                      <td className="py-2 font-medium text-slate-800">{d.nombre}</td>
                      <td className="py-2 text-right text-slate-600">{d.atendidas}</td>
                      <td className="py-2 text-right text-slate-600">{d.resueltas}</td>
                      <td className="py-2 text-right text-slate-600">{d.enviados}</td>
                      <td
                        className={`py-2 text-right font-medium ${colorRespuesta(d.medianaRespuestaSeg)}`}
                      >
                        {duracion(d.medianaRespuestaSeg)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
            «1ª respuesta» es la mediana de lo que tarda el asesor en contestar por primera
            vez en una conversación. Se usa mediana y no promedio porque un caso olvidado un
            fin de semana desvirtúa el promedio de toda la semana.
          </p>
        </div>
      </div>
    </div>
  );
}
