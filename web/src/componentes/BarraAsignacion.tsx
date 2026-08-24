import { useState } from 'react';
import type { Asesor, DetalleConversacion } from '../api';

/**
 * Franja de dueño. Es la pieza que evita el problema real de 7 asesores sobre un
 * mismo número: siempre está a la vista quién tiene la conversación, y tomarla
 * es un clic que o gana o te dice quién la ganó.
 */
export default function BarraAsignacion({
  detalle,
  yo,
  asesores,
  onTomar,
  onSoltar,
  onAsignar,
}: {
  detalle: DetalleConversacion;
  yo: Asesor;
  asesores: Asesor[];
  onTomar: () => void;
  onSoltar: () => void;
  onAsignar: (asesorId: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const mia = detalle.asignadoId === yo.id;
  const libre = !detalle.asignadoId;
  const puedeReasignar = mia || libre || yo.rol !== 'asesor';

  return (
    <div
      className={`flex items-center gap-2 border-b px-6 py-2 text-xs ${
        libre
          ? 'border-amber-200 bg-amber-50'
          : mia
            ? 'border-marca-100 bg-marca-50'
            : 'border-slate-200 bg-slate-50'
      }`}
    >
      {libre ? (
        <>
          <span className="font-medium text-amber-900">Sin asignar</span>
          <span className="text-amber-700">· nadie la está atendiendo</span>
          <button
            onClick={onTomar}
            className="ml-auto rounded-lg bg-marca-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-marca-600"
          >
            Tomar
          </button>
        </>
      ) : (
        <>
          <span className={mia ? 'font-medium text-marca-700' : 'font-medium text-slate-700'}>
            {mia ? 'Es tuya' : `La atiende ${detalle.asignadoNombre}`}
          </span>
          {detalle.asignadaEn && (
            <span className="text-slate-400">
              · desde {new Date(detalle.asignadaEn).toLocaleTimeString('es', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}

          <div className="relative ml-auto flex gap-1.5">
            {puedeReasignar && (
              <button
                onClick={() => setAbierto((v) => !v)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Pasar a…
              </button>
            )}
            {mia && (
              <button
                onClick={onSoltar}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Soltar
              </button>
            )}

            {abierto && (
              <div className="absolute right-0 top-9 z-10 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                {asesores
                  .filter((a) => a.id !== detalle.asignadoId)
                  .map((a) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        setAbierto(false);
                        onAsignar(a.id);
                      }}
                      className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50"
                    >
                      <span className="font-medium text-slate-800">{a.nombre}</span>
                      <span className="text-[10px] text-slate-400">{a.rol}</span>
                      {a.id === yo.id && (
                        <span className="ml-auto text-[10px] text-marca-600">vos</span>
                      )}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
