import type { Mensaje } from '../api';

/**
 * Confirmación de borrado, con el texto que corresponde a cada caso.
 *
 * La diferencia importa mucho: un mensaje fallido nunca salió, así que borrarlo
 * es limpieza y punto. Uno entregado sigue en el teléfono del cliente para
 * siempre — la Cloud API no permite revocarlo — y el asesor tiene que saberlo
 * antes de creer que "lo borró".
 */
export default function ConfirmarEliminar({
  mensaje,
  eliminando,
  onConfirmar,
  onCancelar,
}: {
  mensaje: Mensaje;
  eliminando: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  const nuncaSalio = mensaje.direccion === 'out' && mensaje.status === 'failed';
  const esEntrante = mensaje.direccion === 'in';

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onCancelar}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Eliminar de la bandeja</h3>

          <div className="mt-3 max-h-24 overflow-hidden rounded-lg bg-slate-50 px-3 py-2">
            <p className="line-clamp-3 text-xs text-slate-600">
              {mensaje.cuerpo || `(${mensaje.tipo})`}
            </p>
          </div>

          {nuncaSalio ? (
            <div className="mt-4 rounded-lg border border-marca-100 bg-marca-50 p-3">
              <p className="text-xs font-medium text-marca-700">Este mensaje nunca llegó</p>
              <p className="mt-1 text-[11px] leading-relaxed text-marca-700/80">
                Falló al enviarse, así que el cliente no lo vio nunca. Sacarlo del hilo es
                sólo limpieza.
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-medium text-amber-900">
                El cliente lo va a seguir viendo
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
                {esEntrante
                  ? 'Sólo desaparece de la bandeja del equipo. En el teléfono del cliente sigue estando.'
                  : 'WhatsApp no permite borrar un mensaje ya entregado: queda en su teléfono para siempre. Esto sólo lo saca de la bandeja del equipo.'}
              </p>
            </div>
          )}

          <p className="mt-3 text-[11px] text-slate-400">
            Queda registrado quién lo eliminó y cuándo.
          </p>
        </div>

        <div className="mt-5 flex gap-2 border-t border-slate-100 px-5 py-3">
          <button
            onClick={onCancelar}
            className="ml-auto rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirmar}
            disabled={eliminando}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-40"
          >
            {eliminando ? 'Eliminando…' : 'Eliminar de la bandeja'}
          </button>
        </div>
      </div>
    </div>
  );
}
