import { useEffect, useRef, useState } from 'react';
import FotoContacto, { olvidarFoto } from './FotoContacto';
import {
  api,
  ErrorApi,
  type Asesor,
  type DetalleConversacion,
  type Etiqueta,
  type Nota,
  type TipoNota,
} from '../api';

const COLORES: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  green: 'bg-marca-100 text-marca-700 border-marca-100',
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  red: 'bg-red-100 text-red-700 border-red-200',
  sky: 'bg-sky-100 text-sky-700 border-sky-200',
  violet: 'bg-violet-100 text-violet-700 border-violet-200',
};

const PALETA = Object.keys(COLORES);

function fecha(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-xs text-slate-500">{etiqueta}</span>
      <span className="text-right text-xs font-medium text-slate-800">{valor}</span>
    </div>
  );
}

/** Barra de progreso de la ventana de 24 h: se vacía a medida que se agota. */
function Ventana({ vence, abierta }: { vence: string | null; abierta: boolean }) {
  if (!abierta || !vence) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs font-semibold text-amber-900">Ventana cerrada</p>
        <p className="mt-1 text-[11px] leading-relaxed text-amber-700">
          Sólo se puede retomar con una plantilla aprobada.
        </p>
      </div>
    );
  }

  const restanteMs = new Date(vence).getTime() - Date.now();
  const proporcion = Math.max(0, Math.min(1, restanteMs / (24 * 3_600_000)));
  const horas = Math.floor(restanteMs / 3_600_000);
  const min = Math.floor((restanteMs % 3_600_000) / 60_000);

  return (
    <div className="rounded-lg border border-marca-100 bg-marca-50 p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold text-marca-700">Ventana abierta</p>
        <p className="text-[11px] font-medium text-marca-700">
          {horas > 0 ? `${horas} h ${min} min` : `${min} min`}
        </p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white">
        <div
          className="h-full rounded-full bg-marca-500 transition-all"
          style={{ width: `${proporcion * 100}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-marca-700/80">Vence {fecha(vence)}</p>
    </div>
  );
}

function Etiquetas({
  conversationId,
  onCambio,
}: {
  conversationId: string;
  onCambio: () => void;
}) {
  const [puestas, setPuestas] = useState<Etiqueta[]>([]);
  const [todas, setTodas] = useState<Etiqueta[]>([]);
  const [abierto, setAbierto] = useState(false);
  const [nueva, setNueva] = useState('');

  useEffect(() => {
    let vigente = true;
    api.etiquetasDe(conversationId).then((e) => vigente && setPuestas(e));
    api.etiquetas().then((e) => vigente && setTodas(e));
    return () => {
      vigente = false;
    };
  }, [conversationId]);

  const disponibles = todas.filter((t) => !puestas.some((p) => p.id === t.id));

  async function crear() {
    const nombre = nueva.trim();
    if (!nombre) return;

    // Color estable por nombre: la misma etiqueta se ve igual siempre, y no
    // hace falta que nadie elija uno.
    const color = PALETA[Math.abs([...nombre].reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETA.length];

    const creada = await api.crearEtiqueta(nombre, color);
    setTodas(await api.etiquetas());
    if (creada.id) setPuestas(await api.etiquetar(conversationId, creada.id));
    setNueva('');
    // El filtro de la lista tiene que enterarse de la etiqueta nueva.
    onCambio();
  }

  return (
    <div className="border-t border-slate-100 px-5 py-4">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Etiquetas
      </h4>

      <div className="flex flex-wrap gap-1.5">
        {puestas.map((e) => (
          <span
            key={e.id}
            className={`group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              COLORES[e.color] ?? COLORES.slate
            }`}
          >
            {e.nombre}
            <button
              onClick={async () => setPuestas(await api.desetiquetar(conversationId, e.id!))}
              className="opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
            >
              ✕
            </button>
          </span>
        ))}

        <button
          onClick={() => setAbierto((v) => !v)}
          className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400 transition hover:border-slate-400 hover:text-slate-600"
        >
          + etiqueta
        </button>
      </div>

      {abierto && (
        <div className="mt-2 rounded-lg border border-slate-200 p-2">
          {disponibles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {disponibles.map((e) => (
                <button
                  key={e.id}
                  onClick={async () => setPuestas(await api.etiquetar(conversationId, e.id!))}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition hover:opacity-80 ${
                    COLORES[e.color] ?? COLORES.slate
                  }`}
                >
                  {e.nombre}
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-1.5">
            <input
              value={nueva}
              onChange={(e) => setNueva(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && crear()}
              placeholder="Nueva etiqueta"
              className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-marca-500"
            />
            <button
              onClick={crear}
              disabled={!nueva.trim()}
              className="rounded bg-slate-800 px-2 py-1 text-[11px] text-white disabled:opacity-40"
            >
              Crear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * La foto del contacto: se ve, se cambia y se quita.
 *
 * NO es la de WhatsApp. Esa no se puede leer: la Cloud API no la expone, y la
 * única vía que la tiene —una sesión de WhatsApp Web— exige que el número esté
 * registrado en la app normal, cosa que deja de ser cierta en cuanto se migra a
 * la API. Los dos sistemas se excluyen. Ésta la pone el equipo, y para el
 * cliente de siempre resuelve lo mismo: reconocerlo de un vistazo.
 */
function Avatar({
  detalle,
  onCambio,
}: {
  detalle: DetalleConversacion;
  onCambio: () => void;
}) {
  const archivoRef = useRef<HTMLInputElement>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState('');
  const inicial = (detalle.contacto ?? detalle.telefono).trim()[0]?.toUpperCase() ?? '?';

  async function conLaFoto(hacer: () => Promise<unknown>) {
    setTrabajando(true);
    setError('');
    try {
      await hacer();
      // La cacheada es la anterior: sin olvidarla se seguiría viendo esa.
      olvidarFoto(detalle.contactoId);
      onCambio();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo cambiar la foto');
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <>
      <input
        ref={archivoRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const archivo = e.target.files?.[0];
          if (archivo) void conLaFoto(() => api.subirFoto(detalle.contactoId, archivo));
          e.target.value = '';
        }}
      />

      <button
        onClick={() => archivoRef.current?.click()}
        disabled={trabajando}
        title={detalle.tieneFoto ? 'Cambiar la foto' : 'Poner una foto'}
        className="group relative rounded-full disabled:opacity-50"
      >
        <FotoContacto
          contactoId={detalle.contactoId}
          tieneFoto={detalle.tieneFoto}
          iniciales={inicial}
          color="bg-slate-200 text-slate-600"
          className="size-16 text-xl"
        />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100">
          {trabajando ? '…' : 'cambiar'}
        </span>
      </button>

      {detalle.tieneFoto && !trabajando && (
        <button
          onClick={() => void conLaFoto(() => api.quitarFoto(detalle.contactoId))}
          className="mt-1 text-[10px] text-slate-400 transition hover:text-red-600"
        >
          quitar foto
        </button>
      )}

      {error && <p className="mt-1 text-[10px] text-red-600">{error}</p>}
    </>
  );
}

/**
 * Los datos del pedido: la referencia, el modelo, lo cotizado.
 *
 * Van acá y no en el hilo a propósito. En la conversación se hunden con el
 * tiempo: a la media hora hay que subir buscándolas. Acá quedan siempre a la
 * vista, que es lo que uno quiere de un dato — la nota interna sí va en el
 * hilo, porque es un comentario sobre un momento de la charla.
 */
function Informacion({
  notas,
  puedeBorrar,
  onBorrar,
}: {
  notas: Nota[];
  puedeBorrar: (nota: Nota) => boolean;
  onBorrar: (id: string) => void;
}) {
  const datos = notas.filter((n) => n.tipo === 'informacion');
  if (datos.length === 0) return null;

  return (
    <div className="border-t border-slate-100 px-5 py-4">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sky-600">
        Información
      </h4>

      <div className="space-y-1.5">
        {datos.map((n) => (
          <div
            key={n.id}
            className="group rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5"
          >
            <p className="whitespace-pre-wrap break-words text-xs text-sky-900">{n.cuerpo}</p>

            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-[10px] text-sky-500">{n.autor ?? 'alguien'}</span>
              {puedeBorrar(n) && (
                <button
                  onClick={() => onBorrar(n.id)}
                  className="ml-auto text-[10px] text-sky-400 transition hover:text-sky-700 md:opacity-0 md:group-hover:opacity-100"
                >
                  borrar
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NuevaNota({
  onAgregar,
}: {
  onAgregar: (cuerpo: string, tipo: TipoNota) => Promise<void>;
}) {
  const [texto, setTexto] = useState('');
  const [tipo, setTipo] = useState<TipoNota>('interna');
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    const limpio = texto.trim();
    if (!limpio) return;
    setGuardando(true);
    try {
      await onAgregar(limpio, tipo);
      setTexto('');
    } finally {
      setGuardando(false);
    }
  }

  // Cada clase se escribe con su color, el mismo que va a tener después: se ve
  // antes de guardar de qué va a quedar marcada. Y van a sitios distintos —la
  // interna al hilo, la información acá arriba—, así que el texto lo dice.
  const esInfo = tipo === 'informacion';

  return (
    <div className="border-t border-slate-100 px-5 py-4">
      <div className="mb-2 flex gap-1">
        <button
          onClick={() => setTipo('interna')}
          className={`flex-1 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition ${
            esInfo ? 'text-slate-400 hover:bg-slate-100' : 'bg-amber-100 text-amber-700'
          }`}
        >
          Nota interna
        </button>
        <button
          onClick={() => setTipo('informacion')}
          className={`flex-1 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition ${
            esInfo ? 'bg-sky-100 text-sky-700' : 'text-slate-400 hover:bg-slate-100'
          }`}
        >
          Información
        </button>
      </div>

      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void guardar();
        }}
        rows={3}
        placeholder={
          esInfo
            ? 'La referencia, el modelo, lo cotizado. Queda acá arriba, siempre a la vista'
            : 'Un comentario del equipo. Va en la conversación; el cliente no lo ve'
        }
        className={`w-full resize-none rounded-lg border border-slate-200 px-2.5 py-2 text-xs outline-none ${
          esInfo ? 'bg-sky-50/40 focus:border-sky-400' : 'bg-amber-50/40 focus:border-amber-400'
        }`}
      />
      <button
        onClick={guardar}
        disabled={!texto.trim() || guardando}
        className={`mt-1.5 w-full rounded-lg py-1.5 text-[11px] font-medium text-white transition disabled:opacity-40 ${
          esInfo ? 'bg-sky-600 hover:bg-sky-700' : 'bg-amber-500 hover:bg-amber-600'
        }`}
      >
        {guardando ? 'Guardando…' : esInfo ? 'Agregar información' : 'Agregar nota'}
      </button>
    </div>
  );
}

export default function PanelContacto({
  detalle,
  yo,
  onAgregarNota,
  onEtiquetasCambiaron,
  onFotoCambio,
  notas,
  onBorrarNota,
  puedeBorrarNota,
  className,
  onCerrar,
}: {
  detalle: DetalleConversacion | null;
  yo: Asesor;
  onAgregarNota: (cuerpo: string, tipo: TipoNota) => Promise<void>;
  /** Se llama al poner o quitar la foto, para que la lista de chats se entere. */
  onFotoCambio: () => void;
  /** Las de tipo `informacion` se muestran acá; las internas van en el hilo. */
  notas: Nota[];
  onBorrarNota: (id: string) => void;
  puedeBorrarNota: (nota: Nota) => boolean;
  onEtiquetasCambiaron: () => void;
  /**
   * Como se coloca el panel. Por defecto es la columna fija de la derecha; en
   * un celular no cabe y se abre a pantalla completa, con las mismas partes
   * adentro.
   */
  className?: string;
  /** Solo a pantalla completa: sin esto no habria como volver al chat. */
  onCerrar?: () => void;
}) {
  const caja = className ?? 'hidden w-72 shrink-0 overflow-y-auto border-l border-slate-200 bg-white xl:block';

  if (!detalle) {
    return <aside className={caja} />;
  }

  return (
    <aside className={caja}>
      {onCerrar && (
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-100 bg-white px-3 py-2">
          <button
            onClick={onCerrar}
            className="rounded-lg px-1.5 py-1 text-lg text-slate-500 transition hover:bg-slate-100"
          >
            ←
          </button>
          <span className="text-sm font-medium text-slate-700">Datos del contacto</span>
        </div>
      )}

      <div className="flex flex-col items-center border-b border-slate-100 px-5 py-6">
        <Avatar detalle={detalle} onCambio={onFotoCambio} />
        <h3 className="mt-3 text-center text-sm font-semibold text-slate-900">
          {detalle.contacto ?? 'Sin nombre'}
        </h3>
        <a
          href={`https://wa.me/${detalle.telefono}`}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 text-xs text-slate-400 hover:text-marca-600"
        >
          +{detalle.telefono}
        </a>
      </div>

      <div className="px-5 py-4">
        <Ventana vence={detalle.ventanaVence} abierta={detalle.ventanaAbierta} />
      </div>

      <Etiquetas conversationId={detalle.id} onCambio={onEtiquetasCambiaron} />

      <Informacion notas={notas} puedeBorrar={puedeBorrarNota} onBorrar={onBorrarNota} />

      <NuevaNota onAgregar={onAgregarNota} />

      <div className="border-t border-slate-100 px-5 py-4">
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Conversación
        </h4>
        <Dato
          etiqueta="Asesor"
          valor={
            detalle.asignadoId
              ? detalle.asignadoId === yo.id
                ? 'Vos'
                : (detalle.asignadoNombre ?? '—')
              : 'Sin asignar'
          }
        />
        <Dato etiqueta="Estado" valor={detalle.estado} />
        <Dato etiqueta="Mensajes" valor={String(detalle.totalMensajes)} />
        <Dato etiqueta="Iniciada" valor={fecha(detalle.creada)} />
        <Dato etiqueta="Último del cliente" valor={fecha(detalle.ultimoEntrante)} />
      </div>
    </aside>
  );
}
