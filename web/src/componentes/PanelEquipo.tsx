import { useEffect, useState } from 'react';
import { api, type MiembroEquipo } from '../api';

/**
 * Quién está conectado y cuánto tiene encima cada uno.
 *
 * Es la vista que responde "¿por qué la cola no baja?" sin abrir la base: si
 * alguien está al tope, el ruteo pegajoso deja de mandarle trabajo y todo cae
 * a la cola común.
 */
export default function PanelEquipo({ onCerrar }: { onCerrar: () => void }) {
  const [equipo, setEquipo] = useState<MiembroEquipo[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let vigente = true;

    const cargar = () =>
      api
        .equipo()
        .then((e) => vigente && setEquipo(e))
        .catch(() => vigente && setError('No se pudo cargar el equipo'));

    void cargar();
    const t = setInterval(cargar, 10_000);

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
              <div key={m.id} className="border-b border-slate-50 px-4 py-2.5 last:border-0">
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
                </div>
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
