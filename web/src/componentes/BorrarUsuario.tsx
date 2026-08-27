import { useEffect, useRef, useState } from 'react';
import { api, ErrorApi, type Usuario } from '../api';

/**
 * Confirmación para borrar un usuario de verdad.
 *
 * Dos cosas la separan de un `confirm()` común, y las dos importan:
 *
 * Muestra **qué se pierde**. Borrar deja anónimo el rastro del usuario: los
 * mensajes que envió dejan de decir quién fue. Eso hay que verlo antes, con el
 * número delante, no descubrirlo después.
 *
 * Pide **la contraseña de quien lo hace**. Un panel abierto en una máquina sin
 * bloquear alcanza para vaciar el equipo de un par de clics, y esto no se
 * deshace.
 */

interface Perdida {
  mensajes: number;
  notas: number;
  conversaciones: number;
}

export default function BorrarUsuario({
  usuario,
  onBorrado,
  onCerrar,
}: {
  usuario: Usuario;
  onBorrado: (mensaje: string) => void;
  onCerrar: () => void;
}) {
  const [perdida, setPerdida] = useState<Perdida | null>(null);
  const [clave, setClave] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const campoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .queSePierde(usuario.id)
      .then(setPerdida)
      .catch(() => setPerdida({ mensajes: 0, notas: 0, conversaciones: 0 }));

    const alTeclado = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', alTeclado);
    return () => window.removeEventListener('keydown', alTeclado);
  }, [usuario.id, onCerrar]);

  useEffect(() => {
    if (perdida) campoRef.current?.focus();
  }, [perdida]);

  async function borrar() {
    setOcupado(true);
    setError('');
    try {
      const r = await api.borrarUsuario(usuario.id, clave);
      onBorrado(
        r.devueltasALaCola > 0
          ? `${usuario.nombre} borrado. Sus ${r.devueltasALaCola} conversaciones volvieron a la cola.`
          : `${usuario.nombre} borrado.`,
      );
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo borrar');
      setOcupado(false);
    }
  }

  const tieneHistorial = !!perdida && (perdida.mensajes > 0 || perdida.notas > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">
          Borrar a {usuario.nombre}
        </h3>
        <p className="mb-4 text-xs text-slate-500">{usuario.email}</p>

        {!perdida ? (
          <p className="py-6 text-center text-sm text-slate-400">Revisando…</p>
        ) : (
          <>
            {tieneHistorial && (
              <div className="mb-3 rounded-lg bg-red-50 px-3 py-2.5">
                <p className="mb-1.5 text-xs font-medium text-red-800">
                  Se pierde el rastro de su trabajo
                </p>
                <ul className="space-y-0.5 text-[11px] leading-relaxed text-red-700">
                  {perdida.mensajes > 0 && (
                    <li>
                      <span className="font-medium">{perdida.mensajes} mensajes</span> que envió
                      dejan de decir quién los escribió
                    </li>
                  )}
                  {perdida.notas > 0 && (
                    <li>
                      <span className="font-medium">{perdida.notas} notas</span> quedan sin autor
                    </li>
                  )}
                </ul>
              </div>
            )}

            {perdida.conversaciones > 0 && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                Tiene <span className="font-medium">{perdida.conversaciones} conversaciones</span>{' '}
                abiertas. Vuelven a la cola para que alguien las tome.
              </p>
            )}

            {tieneHistorial && (
              <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
                Si se fue del negocio, conviene <span className="font-medium">darlo de baja</span>:
                no puede entrar más, pero el historial sigue diciendo quién atendió a cada cliente.
                Borrar es para una cuenta creada por error.
              </p>
            )}

            <label className="mb-1 block text-xs text-slate-500">
              Para confirmar, escribí <span className="font-medium">tu</span> contraseña
            </label>
            <input
              ref={campoRef}
              type="password"
              value={clave}
              onChange={(e) => setClave(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && clave && !ocupado && borrar()}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />

            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

            <div className="mt-4 flex gap-2">
              <button
                onClick={borrar}
                disabled={!clave || ocupado}
                className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-40"
              >
                {ocupado ? 'Borrando…' : 'Borrar definitivamente'}
              </button>
              <button
                onClick={onCerrar}
                className="rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-slate-100"
              >
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
