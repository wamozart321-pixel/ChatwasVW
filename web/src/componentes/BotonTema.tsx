import { useState } from 'react';
import { oscuroAhora, type Tema } from '../tema';

const OPCIONES: { id: Tema; etiqueta: string; icono: string }[] = [
  { id: 'claro', etiqueta: 'Claro', icono: '☀️' },
  { id: 'oscuro', etiqueta: 'Oscuro', icono: '🌙' },
  { id: 'automatico', etiqueta: 'Como el sistema', icono: '🖥️' },
];

/**
 * Claro / oscuro / como el sistema.
 *
 * Tres opciones a la vista y no un botón que alterna, porque «automatico» no se
 * puede representar alternando: el que lo quiera de vuelta después de haber
 * tocado el botón una vez no tendría cómo pedirlo.
 */
export default function BotonTema({
  tema,
  onElegir,
}: {
  tema: Tema;
  onElegir: (t: Tema) => void;
}) {
  const [abierto, setAbierto] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setAbierto((v) => !v)}
        title="Claro u oscuro"
        className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
      >
        {oscuroAhora(tema) ? '🌙' : '☀️'}
      </button>

      {abierto && (
        <>
          {/* Tapa la pantalla para poder cerrar tocando al lado. */}
          <div className="fixed inset-0 z-30" onClick={() => setAbierto(false)} />
          <div className="absolute right-0 top-full z-40 mt-1.5 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            {OPCIONES.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  onElegir(o.id);
                  setAbierto(false);
                }}
                className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm transition last:border-b-0 ${
                  tema === o.id
                    ? 'bg-marca-50 font-medium text-marca-700'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span>{o.icono}</span>
                {o.etiqueta}
                {tema === o.id && <span className="ml-auto text-marca-600">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
