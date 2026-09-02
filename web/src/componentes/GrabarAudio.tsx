import { useEffect, useRef, useState } from 'react';
import ReproductorAudio from './ReproductorAudio';

/**
 * Graba una nota de voz, en el lugar del campo de texto.
 *
 * Ocupa el renglón donde se escribe en vez de abrir una ventanita: es como lo
 * hace WhatsApp, y en un celular una ventana flotante sobre el teclado tapa
 * justo lo que uno está mirando. Al terminar, el redactor vuelve como estaba.
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

/** Barras del medidor en vivo. Menos que en la onda del reproductor: se mueven. */
const BARRAS_VIVAS = 24;

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
  const [niveles, setNiveles] = useState<number[]>(() => Array(BARRAS_VIVAS).fill(0));

  const grabadorRef = useRef<MediaRecorder | null>(null);
  const trozosRef = useRef<Blob[]>([]);
  const pistaRef = useRef<MediaStream | null>(null);
  const grabadoRef = useRef<Blob | null>(null);
  const analisisRef = useRef<{ ctx: AudioContext; analizador: AnalyserNode } | null>(null);
  const cuadroRef = useRef<number | null>(null);

  /** Corta el micrófono. Sin esto el navegador deja el indicador encendido. */
  function soltarMicrofono() {
    pistaRef.current?.getTracks().forEach((t) => t.stop());
    pistaRef.current = null;

    if (cuadroRef.current !== null) cancelAnimationFrame(cuadroRef.current);
    cuadroRef.current = null;

    void analisisRef.current?.ctx.close().catch(() => undefined);
    analisisRef.current = null;
  }

  /**
   * El medidor que se mueve mientras se habla.
   *
   * Es la señal de que el micrófono está tomando algo. Sin esto, una nota
   * grabada con el micrófono apagado se ve igual que una buena, y el asesor se
   * entera recién cuando el cliente le dice que no se escucha nada.
   */
  function arrancarMedidor(pista: MediaStream) {
    const Constructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return;

    const ctx = new Constructor();
    const analizador = ctx.createAnalyser();
    analizador.fftSize = 512;
    ctx.createMediaStreamSource(pista).connect(analizador);
    analisisRef.current = { ctx, analizador };

    const muestras = new Uint8Array(analizador.fftSize);

    const pintar = () => {
      analizador.getByteTimeDomainData(muestras);

      // Valor eficaz de la ventana: cuánta señal hay ahora mismo.
      let suma = 0;
      for (const v of muestras) {
        const centrado = (v - 128) / 128;
        suma += centrado * centrado;
      }
      const nivel = Math.min(1, Math.sqrt(suma / muestras.length) * 3);

      // Las barras corren hacia la izquierda: la última es el instante actual.
      setNiveles((prev) => [...prev.slice(1), nivel]);
      cuadroRef.current = requestAnimationFrame(pintar);
    };

    cuadroRef.current = requestAnimationFrame(pintar);
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
          soltarMicrofono();

          // Cancelar vacía los trozos: si no quedó nada, no hay nota que oír.
          if (trozosRef.current.length === 0) return;

          const blob = new Blob(trozosRef.current, { type: 'audio/webm' });
          grabadoRef.current = blob;
          setUrlPrevia(URL.createObjectURL(blob));
          setEstado('listo');
        };

        grabador.start();
        arrancarMedidor(pista);
        setEstado('grabando');
      } catch {
        if (!vivo) return;
        setError('No se pudo usar el micrófono. Revisá que el navegador tenga permiso.');
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
  useEffect(
    () => () => {
      if (urlPrevia) URL.revokeObjectURL(urlPrevia);
    },
    [urlPrevia],
  );

  function descartar() {
    // Vaciar antes de parar: `onstop` mira esto para saber que se canceló.
    trozosRef.current = [];
    grabadorRef.current?.stop();
    soltarMicrofono();
    onCerrar();
  }

  function enviar() {
    const blob = grabadoRef.current;
    if (!blob) return;

    const nombre = `nota-de-voz-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.webm`;
    onEnviar(new File([blob], nombre, { type: 'audio/webm' }));
  }

  if (estado === 'error') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-red-700">{error}</p>
        <button
          onClick={onCerrar}
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-100"
        >
          Cerrar
        </button>
      </div>
    );
  }

  if (estado === 'pidiendo') {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-400">
        Pidiendo el micrófono…
      </div>
    );
  }

  if (estado === 'grabando') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2">
        <button
          onClick={descartar}
          title="Descartar"
          className="shrink-0 rounded-lg px-1.5 py-1 text-slate-400 transition hover:bg-slate-200 hover:text-red-600"
        >
          🗑
        </button>

        <span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />
        <span className="shrink-0 font-mono text-xs tabular-nums text-slate-700">
          {comoReloj(segundos)}
        </span>

        <div className="flex h-7 min-w-0 flex-1 items-center gap-[2px]">
          {niveles.map((n, i) => (
            <span
              key={i}
              style={{ height: `${Math.max(8, n * 100)}%` }}
              className="w-full rounded-full bg-marca-400"
            />
          ))}
        </div>

        <button
          onClick={() => grabadorRef.current?.stop()}
          className="shrink-0 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-900"
        >
          ■ Listo
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2">
      <button
        onClick={onCerrar}
        title="Descartar"
        className="shrink-0 rounded-lg px-1.5 py-1 text-slate-400 transition hover:bg-slate-200 hover:text-red-600"
      >
        🗑
      </button>

      {/* La misma onda que va a ver el cliente, para escucharla antes de mandarla. */}
      <div className="min-w-0 flex-1">
        {urlPrevia && <ReproductorAudio url={urlPrevia} mio={false} />}
      </div>

      <button
        onClick={enviar}
        disabled={enviando}
        className="shrink-0 rounded-lg bg-marca-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-marca-600 disabled:opacity-40"
      >
        Enviar
      </button>
    </div>
  );
}
