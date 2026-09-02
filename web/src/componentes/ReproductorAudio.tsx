import { useEffect, useRef, useState } from 'react';
import { calcularOnda } from './decodificar-onda';
import { BARRAS } from './onda';

/**
 * Reproductor de notas de voz.
 *
 * El control que trae el navegador es una barra gris ancha, pensada para una
 * página de música: dentro de una burbuja de chat queda cortada y desentona.
 * Este muestra lo único que hace falta en una nota de voz — reproducir, dónde
 * va y cuánto falta — y se adapta al color de la burbuja.
 *
 * Va todo en un solo renglón. Antes eran dos —la barra y abajo los tiempos— y
 * con la hora del mensaje debajo la burbuja de una nota de voz ocupaba tres
 * líneas para decir «audio de cuatro segundos».
 */

function reloj(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos < 0) return '0:00';
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Mientras no se sepa la forma real, algo parejo que no salte al llegar. */
const ONDA_PLANA = Array.from({ length: BARRAS }, () => 0.35);

export default function ReproductorAudio({ url, mio }: { url: string; mio: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [sonando, setSonando] = useState(false);
  const [posicion, setPosicion] = useState(0);
  const [duracion, setDuracion] = useState(0);
  const [onda, setOnda] = useState<number[] | null>(null);

  useEffect(() => {
    let vivo = true;
    void calcularOnda(url).then((o) => {
      if (vivo && o) setOnda(o);
    });
    return () => {
      vivo = false;
    };
  }, [url]);

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

  function saltar(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current;
    if (!a || !duracion) return;
    const caja = e.currentTarget.getBoundingClientRect();
    const proporcion = (e.clientX - caja.left) / caja.width;
    a.currentTime = Math.max(0, Math.min(1, proporcion)) * duracion;
    setPosicion(a.currentTime);
  }

  const barras = onda ?? ONDA_PLANA;
  const avance = duracion > 0 ? posicion / duracion : 0;
  const reproducidas = Math.round(avance * barras.length);

  // Cuenta atrás: cuánto FALTA, no cuánto va. Es lo que uno quiere saber de una
  // nota de voz que está sonando, y así el número no cambia de ancho al azar.
  const restante = duracion > 0 ? Math.max(0, duracion - posicion) : 0;

  return (
    <div className="flex w-60 max-w-full items-center gap-2.5">
      <audio ref={audioRef} src={url} onLoadedMetadata={alCargar} preload="metadata" />

      {/*
        El tiempo va debajo del play y no al lado de la onda: ahi le robaba
        ancho al dibujo, que es lo unico que crece con lo larga que sea la nota.
      */}
      <div className="flex shrink-0 flex-col items-center gap-0.5">
        <button
          onClick={alternar}
          className={`flex size-9 items-center justify-center rounded-full text-sm transition ${
            mio
              ? 'bg-white/25 text-white hover:bg-white/35'
              : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
          }`}
        >
          {sonando ? '❚❚' : '▶'}
        </button>

        <span
          className={`font-mono text-[10px] tabular-nums ${
            mio ? 'text-white/70' : 'text-slate-500'
          }`}
        >
          {reloj(sonando || posicion > 0 ? restante : duracion)}
        </span>
      </div>

      {/* Clic en la onda para saltar a ese punto. */}
      <div
        onClick={saltar}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-[2px]"
      >
        {barras.map((alto, i) => (
          <span
            key={i}
            style={{ height: `${Math.max(12, alto * 100)}%` }}
            className={`w-full rounded-full transition-colors ${
              i < reproducidas
                ? mio
                  ? 'bg-white'
                  : 'bg-marca-500'
                : mio
                  ? 'bg-white/35'
                  : 'bg-slate-300'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
