import { useEffect, useMemo, useState } from 'react';
import { api, type Plantilla } from '../api';

/** Reemplaza {{1}}, {{2}}… por lo que cargó el asesor, o deja el hueco visible. */
function resolver(texto: string, valores: string[]): string {
  return texto.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => valores[Number(n) - 1] || `{{${n}}}`);
}

function Campos({
  cantidad,
  valores,
  etiqueta,
  onCambio,
}: {
  cantidad: number;
  valores: string[];
  etiqueta: string;
  onCambio: (i: number, v: string) => void;
}) {
  if (cantidad === 0) return null;

  return (
    <div className="space-y-2">
      {Array.from({ length: cantidad }, (_, i) => (
        <div key={i}>
          <label className="mb-1 block text-[11px] font-medium text-slate-600">
            {etiqueta} {`{{${i + 1}}}`}
          </label>
          <input
            value={valores[i] ?? ''}
            onChange={(e) => onCambio(i, e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm outline-none focus:border-marca-500"
            placeholder="valor"
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Elegir plantilla, completar variables y ver cómo va a quedar.
 *
 * La vista previa importa más de lo que parece: el asesor está escribiendo algo
 * que no puede corregir después, y las plantillas se leen distinto con los
 * valores puestos que con los {{1}} a la vista.
 */
export default function SelectorPlantilla({
  conversationId,
  onCerrar,
  onEnviada,
  onError,
}: {
  conversationId: string;
  onCerrar: () => void;
  onEnviada: () => void;
  onError: (mensaje: string) => void;
}) {
  const [plantillas, setPlantillas] = useState<Plantilla[] | null>(null);
  const [elegidaId, setElegidaId] = useState<string | null>(null);
  const [encabezado, setEncabezado] = useState<string[]>([]);
  const [cuerpo, setCuerpo] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [busqueda, setBusqueda] = useState('');

  useEffect(() => {
    api
      .plantillas()
      .then(setPlantillas)
      .catch(() => setPlantillas([]));
  }, []);

  const elegida = plantillas?.find((p) => p.id === elegidaId) ?? null;

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return plantillas ?? [];
    return (plantillas ?? []).filter(
      (p) => p.nombre.toLowerCase().includes(q) || p.textoCuerpo.toLowerCase().includes(q),
    );
  }, [plantillas, busqueda]);

  const listo =
    !!elegida &&
    !elegida.necesitaArchivo &&
    encabezado.filter(Boolean).length >= elegida.variablesEncabezado &&
    cuerpo.filter(Boolean).length >= elegida.variablesCuerpo;

  async function sincronizar() {
    setSincronizando(true);
    try {
      await api.sincronizarPlantillas();
      setPlantillas(await api.plantillas());
    } catch (e: any) {
      onError(e?.message ?? 'no se pudo sincronizar');
    } finally {
      setSincronizando(false);
    }
  }

  async function enviar() {
    if (!elegida || !listo) return;
    setEnviando(true);
    try {
      await api.enviarPlantilla(elegida.id, { conversationId, encabezado, cuerpo });
      onEnviada();
      onCerrar();
    } catch (e: any) {
      onError(e?.datos?.mensaje ?? e?.message ?? 'no se pudo enviar la plantilla');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-xl">
        {/* Lista */}
        <div className="flex w-64 shrink-0 flex-col border-r border-slate-200">
          <div className="border-b border-slate-100 p-3">
            <h3 className="text-sm font-semibold text-slate-900">Plantillas</h3>
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs outline-none focus:border-marca-500 focus:bg-white"
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {plantillas === null && (
              <p className="px-3 py-4 text-xs text-slate-400">Cargando…</p>
            )}

            {plantillas?.length === 0 && (
              <div className="px-3 py-4">
                <p className="text-xs text-slate-500">No hay plantillas aprobadas.</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  Se crean y se aprueban en el WhatsApp Manager de Meta. Después traelas
                  con «Sincronizar».
                </p>
              </div>
            )}

            {filtradas.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setElegidaId(p.id);
                  setEncabezado([]);
                  setCuerpo([]);
                }}
                className={`w-full border-b border-slate-50 px-3 py-2.5 text-left transition ${
                  p.id === elegidaId ? 'bg-marca-50' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-medium text-slate-800">{p.nombre}</span>
                  <span className="shrink-0 text-[10px] uppercase text-slate-400">{p.idioma}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{p.textoCuerpo}</p>
              </button>
            ))}
          </div>

          <button
            onClick={sincronizar}
            disabled={sincronizando}
            className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {sincronizando ? 'Sincronizando…' : 'Sincronizar con Meta'}
          </button>
        </div>

        {/* Detalle */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-slate-100 px-5 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-900">
                {elegida?.nombre ?? 'Elegí una plantilla'}
              </h3>
              {elegida?.categoria && (
                <p className="text-[11px] text-slate-400">{elegida.categoria.toLowerCase()}</p>
              )}
            </div>
            <button
              onClick={onCerrar}
              className="ml-auto text-slate-400 transition hover:text-slate-600"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {!elegida ? (
              <p className="text-sm text-slate-400">
                Fuera de la ventana de 24 h sólo se pueden mandar plantillas aprobadas por Meta.
              </p>
            ) : elegida.necesitaArchivo ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-medium text-amber-900">
                  Esta plantilla lleva un archivo en el encabezado
                </p>
                <p className="mt-1 text-[11px] text-amber-700">
                  Todavía no está soportado. Elegí una de sólo texto.
                </p>
              </div>
            ) : (
              <>
                <div className="mb-4 rounded-xl bg-slate-50 p-4">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Así lo va a ver el cliente
                  </p>
                  <div className="rounded-lg bg-marca-500 px-3.5 py-2 text-sm text-white shadow-sm">
                    {elegida.textoEncabezado && (
                      <p className="mb-1 font-semibold">
                        {resolver(elegida.textoEncabezado, encabezado)}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap">{resolver(elegida.textoCuerpo, cuerpo)}</p>
                    {elegida.textoPie && (
                      <p className="mt-1.5 text-[11px] text-white/70">{elegida.textoPie}</p>
                    )}
                  </div>

                  {elegida.botones.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {elegida.botones.map((b, i) => (
                        <span
                          key={i}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-sky-600"
                        >
                          {b}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <Campos
                    cantidad={elegida.variablesEncabezado}
                    valores={encabezado}
                    etiqueta="Encabezado"
                    onCambio={(i, v) =>
                      setEncabezado((prev) => {
                        const copia = [...prev];
                        copia[i] = v;
                        return copia;
                      })
                    }
                  />
                  <Campos
                    cantidad={elegida.variablesCuerpo}
                    valores={cuerpo}
                    etiqueta="Variable"
                    onCambio={(i, v) =>
                      setCuerpo((prev) => {
                        const copia = [...prev];
                        copia[i] = v;
                        return copia;
                      })
                    }
                  />
                  {elegida.variablesCuerpo === 0 && elegida.variablesEncabezado === 0 && (
                    <p className="text-xs text-slate-400">Esta plantilla no tiene variables.</p>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-slate-100 px-5 py-3">
            <p className="text-[11px] text-slate-400">
              Abre una ventana nueva de 24 h si el cliente responde
            </p>
            <button
              onClick={enviar}
              disabled={!listo || enviando}
              className="ml-auto rounded-lg bg-marca-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-marca-600 disabled:opacity-40"
            >
              {enviando ? 'Enviando…' : 'Enviar plantilla'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
