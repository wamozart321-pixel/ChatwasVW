import { useEffect, useRef, useState } from 'react';
import { api, ErrorApi } from '../api';

/**
 * Abrir un chat con alguien que todavía no escribió.
 *
 * Lo importante de esta pantalla es la advertencia, no el formulario. Si el
 * cliente nunca escribió, la ventana de 24 h está cerrada y WhatsApp **no
 * permite texto libre**: lo único que sale es una plantilla aprobada. Decirlo
 * acá evita que el asesor escriba un mensaje largo y se lo rechacen al enviar.
 */
export default function NuevoChat({
  onAbrir,
  onCerrar,
}: {
  onAbrir: (conversationId: string) => void;
  onCerrar: () => void;
}) {
  const [telefono, setTelefono] = useState('');
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const campoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    campoRef.current?.focus();
    const alTeclado = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', alTeclado);
    return () => window.removeEventListener('keydown', alTeclado);
  }, [onCerrar]);

  /**
   * Cómo va a quedar el número, en vivo.
   *
   * Se calcula igual que en el servidor: 10 dígitos es un celular colombiano y
   * le falta el indicativo. Verlo antes de enviar es lo que evita escribirle a
   * un número equivocado.
   */
  const digitos = telefono.replace(/\D/g, '').replace(/^00/, '');
  const final = digitos.length === 10 ? `57${digitos}` : digitos;
  const valido = final.length >= 10 && final.length <= 15;

  async function abrir() {
    setOcupado(true);
    setError('');
    try {
      const r = await api.abrirChat(telefono, nombre.trim() || undefined);
      onAbrir(r.id);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo abrir el chat');
      setOcupado(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Escribirle a un número</h3>
        <p className="mb-4 text-xs leading-relaxed text-slate-500">
          Para clientes que todavía no escribieron al negocio.
        </p>

        <label className="mb-1 block text-xs text-slate-500">Número de celular</label>
        <input
          ref={campoRef}
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valido && !ocupado && abrir()}
          placeholder="318 187 5988"
          inputMode="tel"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        {digitos.length > 0 && (
          <p className="mt-1 text-[11px] text-slate-500">
            Se le va a escribir a <span className="font-mono text-slate-700">+{final}</span>
            {digitos.length === 10 && ' (le agregamos el 57)'}
          </p>
        )}

        <label className="mb-1 mt-3 block text-xs text-slate-500">Nombre (opcional)</label>
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valido && !ocupado && abrir()}
          placeholder="Para reconocerlo en la bandeja"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-amber-800">
            <span className="font-medium">Solo vas a poder mandarle una plantilla.</span> WhatsApp
            no deja escribir libremente a alguien que no te escribió en las últimas 24 horas. En
            cuanto conteste, se abre el chat normal.
          </p>
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            onClick={abrir}
            disabled={!valido || ocupado}
            className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {ocupado ? 'Abriendo…' : 'Abrir chat'}
          </button>
          <button
            onClick={onCerrar}
            className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
