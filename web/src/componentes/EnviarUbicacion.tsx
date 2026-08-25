import { useEffect, useRef, useState } from 'react';
import type { UbicacionNegocio } from '../api';

/**
 * Panel para mandar una ubicación.
 *
 * Dos caminos, porque son dos necesidades distintas: "dónde queda el local",
 * que es la de todos los días y tiene que ser un clic, y un punto cualquiera
 * —la casa del cliente, una bodega, el taller donde entregar— que el asesor
 * resuelve pegando el enlace de Google Maps.
 *
 * No hay campos de latitud y longitud a mano a propósito: nadie tiene esos
 * números, tienen el enlace. El servidor es el que los saca del texto.
 */
export default function EnviarUbicacion({
  negocio,
  enviando,
  onEnviar,
  onCerrar,
}: {
  negocio: UbicacionNegocio | null;
  enviando: boolean;
  onEnviar: (datos: {
    latitud?: number;
    longitud?: number;
    texto?: string;
    nombre?: string;
    direccion?: string;
  }) => void;
  onCerrar: () => void;
}) {
  const [texto, setTexto] = useState('');
  const campoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    campoRef.current?.focus();
  }, []);

  useEffect(() => {
    const alTeclado = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', alTeclado);
    return () => window.removeEventListener('keydown', alTeclado);
  }, [onCerrar]);

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onCerrar} />

      <div className="absolute bottom-full left-0 z-20 mb-2 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
        <h4 className="mb-2 text-xs font-semibold text-slate-900">Enviar ubicación</h4>

        {negocio && (
          <button
            disabled={enviando}
            onClick={() =>
              onEnviar({
                latitud: negocio.latitud,
                longitud: negocio.longitud,
                nombre: negocio.nombre,
                direccion: negocio.direccion ?? undefined,
              })
            }
            className="mb-3 flex w-full items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-left transition hover:bg-emerald-100 disabled:opacity-50"
          >
            <span className="text-lg leading-none">🏪</span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-emerald-800">Nuestra ubicación</span>
              <span className="block truncate text-[10px] text-emerald-700">
                {negocio.direccion ?? negocio.nombre}
              </span>
            </span>
          </button>
        )}

        <label className="mb-1 block text-[11px] text-slate-500">
          O pegá el enlace de Google Maps
        </label>
        <input
          ref={campoRef}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && texto.trim() && !enviando) onEnviar({ texto });
          }}
          placeholder="https://maps.app.goo.gl/…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
          Sirve el enlace corto del celular, el largo del navegador, o las coordenadas
          separadas por coma.
        </p>

        <div className="mt-2 flex gap-2">
          <button
            disabled={enviando || !texto.trim()}
            onClick={() => onEnviar({ texto })}
            className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-40"
          >
            Enviar
          </button>
          <button
            onClick={onCerrar}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-500 transition hover:bg-slate-100"
          >
            Cancelar
          </button>
        </div>
      </div>
    </>
  );
}
