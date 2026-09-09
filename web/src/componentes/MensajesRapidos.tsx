import { useEffect, useRef } from 'react';
import type { MensajeRapido } from './mensajes-rapidos';

/**
 * La lista que aparece sobre el redactor al teclear «/».
 *
 * Sólo dibuja: quién está resaltado y qué hacen las flechas lo maneja el
 * Redactor, porque las teclas llegan al textarea y no acá. Así el foco nunca se
 * mueve del campo y el asesor puede seguir escribiendo para filtrar.
 */
export default function MensajesRapidos({
  opciones,
  indice,
  onElegir,
  onResaltar,
  onCerrar,
  vistaPrevia,
}: {
  opciones: MensajeRapido[];
  /** El resaltado, que es el que se manda con Enter. */
  indice: number;
  onElegir: (m: MensajeRapido) => void;
  onResaltar: (i: number) => void;
  onCerrar: () => void;
  /** Deja el texto como va a quedar, con el nombre del cliente ya puesto. */
  vistaPrevia: (texto: string) => string;
}) {
  const listaRef = useRef<HTMLDivElement>(null);

  // Con la flecha abajo el resaltado se va del área visible y parece que la
  // lista se hubiera trabado; esto lo trae de vuelta.
  useEffect(() => {
    listaRef.current?.querySelector('[data-activo="si"]')?.scrollIntoView({ block: 'nearest' });
  }, [indice]);

  return (
    <>
      {/* Tapa la pantalla para poder cerrar tocando al lado. */}
      <div className="fixed inset-0 z-10" onClick={onCerrar} />

      <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5">
          <span className="text-[11px] font-semibold text-slate-600">⚡ Mensajes rápidos</span>
          <span className="ml-auto hidden text-[10px] text-slate-400 md:block">
            ↑↓ moverse · Enter usar · Esc salir
          </span>
        </div>

        <div ref={listaRef} className="max-h-64 overflow-y-auto">
          {opciones.map((m, i) => (
            <button
              key={m.atajo}
              data-activo={i === indice ? 'si' : 'no'}
              // onMouseDown y no onClick: click llega después de que el textarea
              // perdió el foco, y ahí el cursor ya se fue del campo.
              onMouseDown={(e) => {
                e.preventDefault();
                onElegir(m);
              }}
              onMouseEnter={() => onResaltar(i)}
              className={`block w-full border-b border-slate-50 px-3 py-2 text-left transition last:border-b-0 ${
                i === indice ? 'bg-marca-50' : 'hover:bg-slate-50'
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-semibold text-marca-700">/{m.atajo}</span>
                {m.paraQue && (
                  <span className="truncate text-[11px] text-slate-400">{m.paraQue}</span>
                )}
              </div>
              {/* Dos renglones alcanzan para reconocerlo sin tapar el hilo. */}
              <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-slate-600">
                {vistaPrevia(m.texto)}
              </p>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
