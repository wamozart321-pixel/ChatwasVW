import { useEffect, useRef, useState } from 'react';

/**
 * Reproductor de notas de voz.
 *
 * El control que trae el navegador es una barra gris ancha, pensada para una
 * página de música: dentro de una burbuja de chat queda cortada y desentona.
 * Este muestra lo único que hace falta en una nota de voz — reproducir, dónde
 * va y cuánto dura — y se adapta al color de la burbuja.
 */

function reloj(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos < 0) return '0:00';
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ReproductorAudio({ url, mio }: { url: string; mio: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [sonando, setSonando] = useState(false);
  const [posicion, setPosicion] = useState(0);
  const [duracion, setDuracion] = useState(0);

  /**
   * Averigua la duración cuando el navegador dice `Infinity`.
   *
   * Pasa con los audios grabados en vivo: el navegador no sabe cuánto duran
   * hasta que llega al final. Saltar a un instante lejano lo obliga a
   * calcularla, y después se vuelve al principio.
   */
  function alCargar() {
    const a = audioRef.current;
    if (!a) return;

    if (Number.isFinite(a.duration)) {
      setDuracion(a.duration);
      return;
    }

    const alBuscar = () => {
      if (Number.isFinite(a.duration)) setDuracion(a.duration);
      a.currentTime = 0;
      a.removeEventListener('seeked', alBuscar);
    };
    a.addEventListener('seeked', alBuscar);
    a.currentTime = 1e6;
  }

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const alAvanzar = () => setPosicion(a.currentTime);
    const alTerminar = () => {
      setSonando(false);
      setPosicion(0);
      a.currentTime = 0;
    };

    a.addEventListener('timeupdate', alAvanzar);
    a.addEventListener('ended', alTerminar);
    return () => {
      a.removeEventListener('timeupdate', alAvanzar);
      a.removeEventListener('ended', alTerminar);
    };
  }, []);

  function alternar() {
    const a = audioRef.current;
    if (!a) return;

    if (sonando) {
      a.pause();
      setSonando(false);
    } else {
      void a.play();
      setSonando(true);
    }
  }

  const avance = duracion > 0 ? (posicion / duracion) * 100 : 0;

  return (
    <div className="flex w-56 max-w-full items-center gap-2.5">
      <audio ref={audioRef} src={url} onLoadedMetadata={alCargar} preload="metadata" />

      <button
        onClick={alternar}
        className={`flex size-9 shrink-0 items-center justify-center rounded-full text-sm transition ${
          mio ? 'bg-white/25 text-white hover:bg-white/35' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
        }`}
      >
        {sonando ? '❚❚' : '▶'}
      </button>

      <div className="min-w-0 flex-1">
        {/* Clic en la barra para saltar a ese punto. */}
        <div
          onClick={(e) => {
            const a = audioRef.current;
            if (!a || !duracion) return;
            const caja = e.currentTarget.getBoundingClientRect();
            a.currentTime = ((e.clientX - caja.left) / caja.width) * duracion;
          }}
          className={`h-1.5 cursor-pointer rounded-full ${mio ? 'bg-white/25' : 'bg-slate-200'}`}
        >
          <div
            className={`h-full rounded-full ${mio ? 'bg-white' : 'bg-slate-500'}`}
            style={{ width: `${avance}%` }}
          />
        </div>

        <div
          className={`mt-1 flex justify-between text-[10px] ${
            mio ? 'text-white/70' : 'text-slate-500'
          }`}
        >
          <span>{reloj(posicion)}</span>
          <span>{reloj(duracion)}</span>
        </div>
      </div>
    </div>
  );
}
