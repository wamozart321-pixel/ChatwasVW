import { useEffect, useState } from 'react';
import { api, ErrorApi, type Asesor, type Usuario } from '../api';
import BorrarUsuario from './BorrarUsuario';

/**
 * Administración de usuarios. Sólo la ve el rol `admin`.
 *
 * Va en una pantalla completa y aparte de la bandeja, no en un menú lateral:
 * crear gente, cambiar claves y dar de baja no son cosas que se hagan entre
 * dos mensajes de un cliente, y tenerlas a un clic de la conversación es cómo
 * se termina dando de baja a alguien sin querer.
 */

const ROLES = [
  { valor: 'asesor', etiqueta: 'Asesor', ayuda: 'Atiende clientes. Recibe reparto automático.' },
  {
    valor: 'supervisor',
    etiqueta: 'Supervisor',
    ayuda: 'Ve todo y las métricas. No recibe reparto automático.',
  },
  {
    valor: 'admin',
    etiqueta: 'Administrador',
    ayuda: 'Todo lo anterior, más esta pantalla. No recibe reparto automático.',
  },
] as const;

function Etiqueta({ rol }: { rol: string }) {
  const estilo =
    rol === 'admin'
      ? 'bg-violet-100 text-violet-700'
      : rol === 'supervisor'
        ? 'bg-sky-100 text-sky-700'
        : 'bg-slate-100 text-slate-600';

  const texto = ROLES.find((r) => r.valor === rol)?.etiqueta ?? rol;
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${estilo}`}>{texto}</span>;
}

export default function PanelUsuarios({
  yo,
  onCerrar,
}: {
  yo: Asesor;
  onCerrar: () => void;
}) {
  const [usuarios, setUsuarios] = useState<Usuario[] | null>(null);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const [creando, setCreando] = useState(false);
  const [nuevo, setNuevo] = useState({ nombre: '', email: '', clave: '', rol: 'asesor' });

  /** Id del usuario al que se le está cambiando la clave. */
  const [cambiando, setCambiando] = useState<string | null>(null);
  const [claveNueva, setClaveNueva] = useState('');

  /** El usuario que se está por borrar, o null. */
  const [borrando, setBorrando] = useState<Usuario | null>(null);

  const cargar = () =>
    api
      .usuarios()
      .then(setUsuarios)
      .catch(() => setError('No se pudo cargar la lista de usuarios'));

  useEffect(() => {
    void cargar();
  }, []);

  /** Envuelve una acción: apaga los botones, muestra el error y recarga. */
  async function accion(fn: () => Promise<unknown>, exito: string) {
    setOcupado(true);
    setError('');
    setAviso('');
    try {
      await fn();
      setAviso(exito);
      await cargar();
      return true;
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo completar la acción');
      return false;
    } finally {
      setOcupado(false);
    }
  }

  async function crear() {
    const ok = await accion(
      () => api.crearUsuario(nuevo),
      `${nuevo.nombre} ya puede entrar con ${nuevo.email}`,
    );
    if (ok) {
      setNuevo({ nombre: '', email: '', clave: '', rol: 'asesor' });
      setCreando(false);
    }
  }

  async function guardarClave(u: Usuario) {
    const ok = await accion(
      () => api.claveDeUsuario(u.id, claveNueva),
      `Clave cambiada para ${u.nombre}. Pasásela por un medio seguro.`,
    );
    if (ok) {
      setCambiando(null);
      setClaveNueva('');
    }
  }

  async function cambiarEstado(u: Usuario) {
    if (u.activo && !confirm(`¿Dar de baja a ${u.nombre}? No va a poder entrar más.`)) return;

    await accion(async () => {
      const r = await api.estadoDeUsuario(u.id, !u.activo);
      setAviso(
        u.activo
          ? `${u.nombre} dado de baja.` +
              (r.devueltasALaCola
                ? ` Sus ${r.devueltasALaCola} conversaciones volvieron a la cola.`
                : '')
          : `${u.nombre} reactivado.`,
      );
    }, '');
  }

  /** Clave sugerida: nadie inventa una buena a las apuradas. */
  const sugerir = () => {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
  };

  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-slate-50">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Usuarios</h1>
          <p className="text-xs text-slate-500">
            Crear, cambiar claves, dar de baja y borrar. Sólo lo ven los administradores.
          </p>
        </div>
        <button
          onClick={onCerrar}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          Volver a la bandeja
        </button>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-6">
        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</p>
        )}
        {aviso && (
          <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">
            {aviso}
          </p>
        )}

        {!creando ? (
          <button
            onClick={() => setCreando(true)}
            className="mb-5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Agregar usuario
          </button>
        ) : (
          <div className="mb-5 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Usuario nuevo</h2>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">Nombre y apellido</span>
                <input
                  value={nuevo.nombre}
                  onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="María Restrepo"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">
                  Usuario (con forma de correo)
                </span>
                <input
                  value={nuevo.email}
                  onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="maria@chatwasvw.com"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">Clave (mínimo 8)</span>
                <div className="flex gap-2">
                  <input
                    value={nuevo.clave}
                    onChange={(e) => setNuevo({ ...nuevo, clave: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setNuevo({ ...nuevo, clave: sugerir() })}
                    className="shrink-0 rounded-lg border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    Sugerir
                  </button>
                </div>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">Rol</span>
                <select
                  value={nuevo.rol}
                  onChange={(e) => setNuevo({ ...nuevo, rol: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  {ROLES.map((r) => (
                    <option key={r.valor} value={r.valor}>
                      {r.etiqueta}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="mt-2 text-xs text-slate-500">
              {ROLES.find((r) => r.valor === nuevo.rol)?.ayuda}
            </p>

            <div className="mt-4 flex gap-2">
              <button
                onClick={crear}
                disabled={ocupado}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Crear
              </button>
              <button
                onClick={() => setCreando(false)}
                className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {usuarios === null ? (
            <p className="px-5 py-8 text-center text-sm text-slate-400">Cargando…</p>
          ) : (
            usuarios.map((u) => (
              <div key={u.id} className="border-b border-slate-100 px-5 py-3.5 last:border-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          u.conectado ? 'bg-emerald-500' : 'bg-slate-300'
                        }`}
                        title={u.conectado ? 'Conectado' : 'Desconectado'}
                      />
                      <span
                        className={`truncate text-sm font-medium ${
                          u.activo ? 'text-slate-900' : 'text-slate-400 line-through'
                        }`}
                      >
                        {u.nombre}
                      </span>
                      <Etiqueta rol={u.rol} />
                      {u.id === yo.id && (
                        <span className="text-xs text-slate-400">(vos)</span>
                      )}
                      {!u.activo && (
                        <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-600">
                          De baja
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">{u.email}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <select
                      value={u.rol}
                      disabled={ocupado || !u.activo}
                      onChange={(e) =>
                        accion(
                          () => api.rolDeUsuario(u.id, e.target.value),
                          `${u.nombre} ahora es ${
                            ROLES.find((r) => r.valor === e.target.value)?.etiqueta
                          }`,
                        )
                      }
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
                    >
                      {ROLES.map((r) => (
                        <option key={r.valor} value={r.valor}>
                          {r.etiqueta}
                        </option>
                      ))}
                    </select>

                    <button
                      onClick={() => {
                        setCambiando(cambiando === u.id ? null : u.id);
                        setClaveNueva('');
                      }}
                      disabled={ocupado || !u.activo}
                      className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      Clave
                    </button>

                    <button
                      onClick={() => cambiarEstado(u)}
                      disabled={ocupado || u.id === yo.id}
                      title={u.id === yo.id ? 'No podés darte de baja a vos mismo' : ''}
                      className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40 ${
                        u.activo
                          ? 'border-red-200 text-red-600 hover:bg-red-50'
                          : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                      }`}
                    >
                      {u.activo ? 'Dar de baja' : 'Reactivar'}
                    </button>

                    {/*
                      Borrar tiene su propio botón, no un ícono apagado: una
                      cuenta que ya no se usa ocupa lugar en la lista y hay que
                      poder sacarla. Lo que evita el accidente no es esconder el
                      botón, es que pida la contraseña.
                    */}
                    <button
                      onClick={() => setBorrando(u)}
                      disabled={ocupado || u.id === yo.id}
                      title={
                        u.id === yo.id
                          ? 'No podés borrarte a vos mismo'
                          : 'Borrar definitivamente'
                      }
                      className="rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 transition hover:bg-red-600 hover:text-white disabled:opacity-40"
                    >
                      Borrar
                    </button>
                  </div>
                </div>

                {cambiando === u.id && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-3">
                    <input
                      value={claveNueva}
                      onChange={(e) => setClaveNueva(e.target.value)}
                      placeholder="Clave nueva (mínimo 8)"
                      className="min-w-52 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setClaveNueva(sugerir())}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-white"
                    >
                      Sugerir
                    </button>
                    <button
                      onClick={() => guardarClave(u)}
                      disabled={ocupado}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      Guardar
                    </button>
                    <button
                      onClick={() => setCambiando(null)}
                      className="rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-white"
                    >
                      Cancelar
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {borrando && (
          <BorrarUsuario
            usuario={borrando}
            onCerrar={() => setBorrando(null)}
            onBorrado={(mensaje) => {
              setBorrando(null);
              setAviso(mensaje);
              void cargar();
            }}
          />
        )}

        <p className="mt-4 text-xs text-slate-500">
          <span className="font-medium">Dar de baja</span> no borra nada: no puede entrar más,
          pero el historial sigue mostrando quién respondió cada mensaje.{' '}
          <span className="font-medium">Borrar</span> lo saca de la lista para siempre; el
          historial que tuviera queda sin autor. Las dos devuelven sus conversaciones a la cola.
        </p>
      </div>
    </div>
  );
}
