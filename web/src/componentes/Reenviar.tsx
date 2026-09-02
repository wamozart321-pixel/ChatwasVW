import { useEffect, useMemo, useState } from 'react';
import { api, ErrorApi, type Conversacion, type Mensaje } from '../api';

/**
 * Elige a qué conversación mandar un mensaje que ya existe.
 *
 * Es lo de todos los días en el negocio: llega la foto de una pieza rota y hay
 * que pasársela al proveedor, o una cotización le sirve a otros tres que
 * preguntaron lo mismo. Sin esto hay que bajar el archivo y volver a subirlo,
 * chat por chat.
 */

/** Un resumen de una línea del mensaje que se va a reenviar. */
const SIN_TEXTO: Record<string, string> = {
  audio: '🎤 Nota de voz',
  image: '📷 Foto',
  video: '🎥 Video',
  sticker: '🙂 Sticker',
  document: '📄 Documento',
  location: '📍 Ubicación',
  contacts: '👤 Contacto',
};

function resumen(m: Mensaje): string {
  if (m.cuerpo?.trim()) return m.cuerpo;
  return SIN_TEXTO[m.tipo] ?? 'Mensaje';
}

export default function Reenviar({
  mensaje,
  deConversacion,
  onCerrar,
  onListo,
}: {
  mensaje: Mensaje;
  /** La conversación donde está el mensaje: no tiene sentido reenviárselo a sí misma. */
  deConversacion: string;
  onCerrar: () => void;
  onListo: (aDonde: string) => void;
}) {
  const [chats, setChats] = useState<Conversacion[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [enviando, setEnviando] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // Todas, no solo las activas: reenviar algo a un chat resuelto es normal
    // —el cliente vuelve a preguntar por lo mismo la semana siguiente—.
    api
      .conversaciones('todas', '', 'todos')
      .then(setChats)
      .catch(() => setError('No se pudo cargar la lista de chats'));
  }, []);

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar();
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [onCerrar]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return chats
      .filter((c) => c.id !== deConversacion)
      .filter(
        (c) =>
          !q ||
          (c.contacto ?? '').toLowerCase().includes(q) ||
          c.telefono.includes(q.replace(/\D/g, '')),
      );
  }, [chats, busqueda, deConversacion]);

  async function mandar(c: Conversacion) {
    setEnviando(c.id);
    setError('');
    try {
      await api.reenviar(mensaje.id, c.id);
      onListo(c.contacto ?? `+${c.telefono}`);
    } catch (e) {
      const err = e as ErrorApi;
      setError(err.datos?.mensaje ?? err.message);
      setEnviando(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onCerrar}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Reenviar a…</h3>
          <p className="mt-0.5 truncate text-xs text-slate-500">{resumen(mensaje)}</p>
        </div>

        <div className="border-b border-slate-100 px-4 py-2">
          <input
            autoFocus
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre o teléfono…"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-marca-500 focus:bg-white"
          />
        </div>

        {error && <p className="bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visibles.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">
              {chats.length === 0 ? 'Cargando…' : 'Ningún chat coincide'}
            </p>
          ) : (
            visibles.map((c) => (
              <button
                key={c.id}
                onClick={() => void mandar(c)}
                disabled={enviando !== null}
                className="flex w-full items-center gap-3 border-b border-slate-50 px-4 py-2.5 text-left transition hover:bg-slate-50 disabled:opacity-50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {c.contacto ?? `+${c.telefono}`}
                  </p>
                  <p className="truncate text-[11px] text-slate-400">
                    +{c.telefono}
                    {/* La ventana importa: fuera de ella el envio se rechaza. */}
                    {!c.ventanaAbierta && ' · ventana cerrada'}
                  </p>
                </div>
                {enviando === c.id && <span className="text-xs text-slate-400">enviando…</span>}
              </button>
            ))
          )}
        </div>

        <div className="border-t border-slate-100 px-4 py-2 text-right">
          <button
            onClick={onCerrar}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-500 transition hover:bg-slate-100"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
