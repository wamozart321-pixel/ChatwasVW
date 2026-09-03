import { useEffect, useState } from 'react';
import { api, type Asesor, type DetalleConversacion, type MiembroEquipo } from '../api';

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
  const [carga, setCarga] = useState<Map<string, MiembroEquipo>>(new Map());
  const mia = detalle.asignadoId === yo.id;

  /**
   * Cuántas lleva encima cada asesor, para poder elegir a quién pasársela.
   *
   * Se pide al abrir la lista y no al montar la barra: la barra se dibuja en
   * cada conversación que se abre, y eso serían decenas de consultas al día
   * para un dato que casi nunca se mira.
   */
  useEffect(() => {
    if (!abierto) return;

    let vigente = true;
    api
      .equipo()
      .then((e) => vigente && setCarga(new Map(e.map((m) => [m.id, m]))))
      .catch(() => undefined);

    return () => {
      vigente = false;
    };
  }, [abierto]);
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
                  .map((a) => {
                    const suya = carga.get(a.id);
                    const alTope = suya != null && suya.activas >= suya.tope;

                    return (
                      <button
                        key={a.id}
                        onClick={() => {
                          setAbierto(false);
                          onAsignar(a.id);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50"
                      >
                        {/* Conectado o no: pasarle un chat a quien se fue a
                            almorzar deja al cliente esperando sin que se note. */}
                        <span
                          title={suya?.conectado ? 'Conectado' : 'Desconectado'}
                          className={`size-1.5 shrink-0 rounded-full ${
                            suya?.conectado ? 'bg-marca-500' : 'bg-slate-300'
                          }`}
                        />

                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-slate-800">{a.nombre}</span>
                          {a.id === yo.id && <span className="ml-1 text-[10px] text-marca-600">vos</span>}
                        </span>

                        {/* Cuántas está atendiendo. Es el dato que decide a quién
                            pasársela, y hasta ahora sólo estaba en «Equipo». */}
                        {suya && (
                          <span
                            title={`${suya.activas} conversaciones abiertas`}
                            className={`shrink-0 text-[10px] font-medium ${
                              alTope ? 'text-amber-600' : 'text-slate-400'
                            }`}
                          >
                            {suya.activas}/{suya.tope}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
