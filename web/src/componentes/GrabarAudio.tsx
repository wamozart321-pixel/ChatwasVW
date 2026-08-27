import { useEffect, useRef, useState } from 'react';

/**
 * Graba una nota de voz.
 *
 * Se graba en `audio/webm` porque Chromium no sabe grabar OGG — comprobado en
 * Chromium 150: `MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')` da
 * false. El servidor lo pasa a OGG antes de enviarlo, que es el único formato
 * que WhatsApp muestra como nota de voz con su onda.
 *
 * Antes de mandarla se puede escuchar. Una nota de voz que salió mal no se
 * puede corregir: al cliente ya le llegó.
 */

function comoReloj(segundos: number): string {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Tope de duración. Más que esto nadie lo escucha, y pesa. */
const MAXIMO_SEGUNDOS = 180;

export default function GrabarAudio({
  enviando,
  onEnviar,
  onCerrar,
}: {
  enviando: boolean;
  onEnviar: (archivo: File) => void;
  onCerrar: () => void;
}) {
  const [estado, setEstado] = useState<'pidiendo' | 'grabando' | 'listo' | 'error'>('pidiendo');
  const [segundos, setSegundos] = useState(0);
  const [error, setError] = useState('');
  const [urlPrevia, setUrlPrevia] = useState<string | null>(null);

  const grabadorRef = useRef<MediaRecorder | null>(null);
  const trozosRef = useRef<Blob[]>([]);
  const pistaRef = useRef<MediaStream | null>(null);
  const grabadoRef = useRef<Blob | null>(null);

  /** Corta el micrófono. Sin esto el navegador deja el indicador encendido. */
  function soltarMicrofono() {
    pistaRef.current?.getTracks().forEach((t) => t.stop());
    pistaRef.current = null;
  }

  useEffect(() => {
    let vivo = true;

    (async () => {
      try {
        const pista = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!vivo) {
          pista.getTracks().forEach((t) => t.stop());
          return;
        }

        pistaRef.current = pista;

        // webm/opus: es lo que Chromium sabe grabar. La conversión a OGG la
        // hace el servidor, donde sí hay ffmpeg.
        const tipo = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

        const grabador = new MediaRecorder(pista, { mimeType: tipo });
        grabadorRef.current = grabador;
        trozosRef.current = [];

        grabador.ondataavailable = (e) => {
          if (e.data.size > 0) trozosRef.current.push(e.data);
        };

        grabador.onstop = () => {
          const blob = new Blob(trozosRef.current, { type: 'audio/webm' });
          grabadoRef.current = blob;
          setUrlPrevia(URL.createObjectURL(blob));
          setEstado('listo');
          soltarMicrofono();
        };

        grabador.start();
        setEstado('grabando');
      } catch {
        if (!vivo) return;
        setError(
          'No se pudo usar el micrófono. Revisá que el navegador tenga permiso y que haya uno conectado.',
        );
        setEstado('error');
      }
    })();

    return () => {
      vivo = false;
      soltarMicrofono();
    };
  }, []);

  // El contador, y el corte automático al llegar al tope.
  useEffect(() => {
    if (estado !== 'grabando') return;

    const t = setInterval(() => {
      setSegundos((s) => {
        if (s + 1 >= MAXIMO_SEGUNDOS) {
          grabadorRef.current?.stop();
          return MAXIMO_SEGUNDOS;
        }
        return s + 1;
      });
    }, 1000);

    return () => clearInterval(t);
  }, [estado]);

  // La URL del audio se libera al desmontar: si no, queda en memoria.
  useEffect(() => () => {
    if (urlPrevia) URL.revokeObjectURL(urlPrevia);
  }, [urlPrevia]);

  function enviar() {
    const blob = grabadoRef.current;
    if (!blob) return;

    const nombre = `nota-de-voz-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.webm`;
    onEnviar(new File([blob], nombre, { type: 'audio/webm' }));
  }

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={estado === 'grabando' ? undefined : onCerrar} />

      <div className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
        {estado === 'error' ? (
          <>
            <p className="text-xs leading-relaxed text-red-600">{error}</p>
            <button
              onClick={onCerrar}
              className="mt-3 w-full rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
            >
              Cerrar
            </button>
          </>
        ) : estado === 'pidiendo' ? (
          <p className="py-3 text-center text-xs text-slate-400">Pidiendo el micrófono…</p>
        ) : estado === 'grabando' ? (
          <>
            <div className="flex items-center gap-2">
              <span className="size-2.5 animate-pulse rounded-full bg-red-500" />
              <span className="font-mono text-sm text-slate-700">{comoReloj(segundos)}</span>
              <span className="ml-auto text-[10px] text-slate-400">
                máx {comoReloj(MAXIMO_SEGUNDOS)}
              </span>
            </div>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => grabadorRef.current?.stop()}
                className="flex-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
              >
                ■ Detener
              </button>
              <button
                onClick={() => {
                  // Cancelar durante la grabación tira lo grabado: no se manda
                  // nada y no queda un archivo a medias dando vueltas.
                  trozosRef.current = [];
                  grabadorRef.current?.stop();
                  soltarMicrofono();
                  onCerrar();
                }}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
              >
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 text-[11px] text-slate-500">
              Escuchala antes de enviar — después no se puede corregir.
            </p>
            {urlPrevia && <audio src={urlPrevia} controls className="w-full" />}

            <div className="mt-3 flex gap-2">
              <button
                onClick={enviar}
                disabled={enviando}
                className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Enviar
              </button>
              <button
                onClick={onCerrar}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
              >
                Descartar
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
