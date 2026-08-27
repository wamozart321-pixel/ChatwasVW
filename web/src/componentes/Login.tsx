import { useEffect, useRef, useState } from 'react';
import { api, sesion, type Asesor } from '../api';

export default function Login({ onEntrar }: { onEntrar: (asesor: Asesor) => void }) {
  // Arranca con el último que entró en esta máquina. Se guarda sólo el correo:
  // la clave no se recuerda nunca.
  const [email, setEmail] = useState(sesion.ultimoEmail());
  const [clave, setClave] = useState('');
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);
  const claveRef = useRef<HTMLInputElement>(null);

  // Si ya sabemos quién es, el cursor va directo a la contraseña.
  useEffect(() => {
    if (sesion.ultimoEmail()) claveRef.current?.focus();
  }, []);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setCargando(true);
    setError('');
    try {
      const { token, asesor } = await api.login(email.trim(), clave);
      sesion.guardar(token);
      // Recién al entrar bien: recordar un correo mal escrito sería peor que
      // no recordar ninguno.
      sesion.recordarEmail(email.trim());
      onEntrar(asesor);
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo entrar');
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={entrar}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-marca-500 text-lg font-bold text-white">
            W
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">WhatsWV</h1>
            <p className="text-xs text-slate-500">Bandeja compartida</p>
          </div>
        </div>

        <label className="mb-1.5 block text-sm font-medium text-slate-700">Email</label>
        <input
          type="email"
          autoFocus={!sesion.ultimoEmail()}
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-marca-500 focus:ring-2 focus:ring-marca-100"
          placeholder="vos@repuestos.com"
        />

        <label className="mb-1.5 block text-sm font-medium text-slate-700">Contraseña</label>
        <input
          ref={claveRef}
          type="password"
          autoComplete="current-password"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-marca-500 focus:ring-2 focus:ring-marca-100"
        />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={cargando || !email.trim() || !clave}
          className="mt-5 w-full rounded-lg bg-marca-500 py-2.5 text-sm font-medium text-white transition hover:bg-marca-600 disabled:opacity-40"
        >
          {cargando ? 'Entrando…' : 'Entrar'}
        </button>

        {sesion.ultimoEmail() && (
          <button
            type="button"
            onClick={() => {
              sesion.olvidarEmail();
              setEmail('');
              setClave('');
            }}
            className="mt-3 w-full text-center text-[11px] text-slate-400 underline underline-offset-2 hover:text-slate-600"
          >
            No sos vos? Entrar con otra cuenta
          </button>
        )}

        <p className="mt-4 text-center text-[11px] text-slate-400">
          Las cuentas las crea un administrador
        </p>
      </form>
    </div>
  );
}
