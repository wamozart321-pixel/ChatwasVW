import { useEffect, useState } from 'react';
import { descargarMedia, type Mensaje } from '../api';
import ReproductorAudio from './ReproductorAudio';

function pesoLegible(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Descarga el archivo con el token y lo expone como blob URL.
 *
 * Revoca la URL al desmontar: sin eso, en un hilo con muchas fotos el navegador
 * se queda con todos los blobs en memoria hasta recargar la página.
 */
function useArchivo(messageId: string, activo: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!activo) return;
    let vigente = true;
    let creada: string | null = null;

    descargarMedia(messageId)
      .then((u) => {
        creada = u;
        if (vigente) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => vigente && setError(true));

    return () => {
      vigente = false;
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [messageId, activo]);

  return { url, error };
}

/**
 * Visor a pantalla completa.
 *
 * Antes el clic abria el blob URL en otra pestaña: se veia la imagen suelta,
 * sin contexto y sin forma de volver salvo cerrar la pestaña. Con fotos de
 * repuestos el asesor necesita agrandar y volver al hilo enseguida.
 */
function Visor({
  url,
  nombre,
  onCerrar,
}: {
  url: string;
  nombre: string;
  onCerrar: () => void;
}) {
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [onCerrar]);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-slate-900/90 p-4"
      onClick={onCerrar}
    >
      <div className="flex items-center gap-3 pb-3">
        <span className="truncate text-sm text-white/80">{nombre}</span>
        <a
          href={url}
          download={nombre}
          onClick={(e) => e.stopPropagation()}
          className="ml-auto rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/25"
        >
          Descargar
        </a>
        <button className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/25">
          Cerrar
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        <img
          src={url}
          alt={nombre}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full object-contain"
        />
      </div>

      <p className="pt-3 text-center text-[11px] text-white/40">
        Clic afuera o Esc para cerrar
      </p>
    </div>
  );
}

export default function Media({ mensaje, mio }: { mensaje: Mensaje; mio: boolean }) {
  const { url, error } = useArchivo(mensaje.id, mensaje.tieneMedia);
  const [ampliada, setAmpliada] = useState(false);
  const mime = mensaje.mediaMime ?? '';

  if (!mensaje.tieneMedia) {
    return (
      <div
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
          mio ? 'bg-white/15 text-white/80' : 'bg-slate-100 text-slate-500'
        }`}
      >
        <span className="animate-pulse">●</span>
        Descargando archivo…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
        No se pudo cargar el archivo
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className={`h-40 w-56 animate-pulse rounded-lg ${mio ? 'bg-white/20' : 'bg-slate-200'}`}
      />
    );
  }

  if (mime.startsWith('image/')) {
    return (
      <>
        <button onClick={() => setAmpliada(true)} className="block cursor-zoom-in">
          <img
            src={url}
            alt={mensaje.caption ?? 'imagen'}
            className="max-h-72 max-w-full rounded-lg object-cover"
            loading="lazy"
          />
        </button>

        {ampliada && (
          <Visor
            url={url}
            nombre={mensaje.mediaNombre ?? 'imagen'}
            onCerrar={() => setAmpliada(false)}
          />
        )}
      </>
    );
  }

  if (mime.startsWith('video/')) {
    return <video src={url} controls className="max-h-72 max-w-full rounded-lg" />;
  }

  if (mime.startsWith('audio/')) {
    // Las notas de voz de WhatsApp llegan como audio/ogg; Chrome las reproduce.
    return <ReproductorAudio url={url} mio={mio} />;
  }

  return (
    <a
      href={url}
      download={mensaje.mediaNombre ?? 'archivo'}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 transition ${
        mio ? 'bg-white/15 hover:bg-white/25' : 'bg-slate-100 hover:bg-slate-200'
      }`}
    >
      <span className="text-lg">📄</span>
      <span className="min-w-0">
        <span
          className={`block truncate text-xs font-medium ${mio ? 'text-white' : 'text-slate-800'}`}
        >
          {mensaje.mediaNombre ?? 'documento'}
        </span>
        <span className={`text-[10px] ${mio ? 'text-white/70' : 'text-slate-500'}`}>
          {pesoLegible(mensaje.mediaTamano)}
        </span>
      </span>
    </a>
  );
}
