import { useEffect, useRef, useState } from 'react';

function pesoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function icono(mime: string): string {
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime === 'application/pdf') return '📕';
  return '📄';
}

/**
 * Confirmación antes de mandar un archivo.
 *
 * Un archivo enviado por WhatsApp no se puede corregir: el asesor tiene que ver
 * qué eligió antes de que salga. Con fotos de repuestos, mandar la del auto
 * equivocado le cuesta al negocio una conversación entera de aclaraciones.
 */
export default function PreviaArchivo({
  archivo,
  maxMB,
  maxVideoMB,
  enviando,
  onEnviar,
  onCancelar,
}: {
  archivo: File;
  maxMB: number;
  maxVideoMB: number;
  enviando: boolean;
  onEnviar: (caption: string) => void;
  onCancelar: () => void;
}) {
  const [caption, setCaption] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const esImagen = archivo.type.startsWith('image/');
  const esVideo = archivo.type.startsWith('video/');

  // Un video se admite mas grande porque el servidor lo recomprime antes de
  // mandarlo. Si aun asi no entra, el aviso llega desde alla.
  const tope = esVideo ? maxVideoMB : maxMB;
  const excedido = archivo.size > tope * 1024 * 1024;

  useEffect(() => {
    if (!esImagen && !esVideo) return;

    const creada = URL.createObjectURL(archivo);
    setUrl(creada);
    // Sin revocar, cada archivo que se previsualiza queda en memoria hasta recargar.
    return () => URL.revokeObjectURL(creada);
  }, [archivo, esImagen, esVideo]);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-900">{archivo.name}</h3>
            <p className="text-[11px] text-slate-400">
              {pesoLegible(archivo.size)} · {archivo.type || 'tipo desconocido'}
            </p>
          </div>
          <button
            onClick={onCancelar}
            className="ml-auto text-slate-400 transition hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="flex max-h-[55vh] items-center justify-center overflow-auto bg-slate-50 p-5">
          {esImagen && url && (
            <img src={url} alt={archivo.name} className="max-h-[45vh] rounded-lg object-contain" />
          )}
          {esVideo && url && (
            <video src={url} controls className="max-h-[45vh] rounded-lg" />
          )}
          {!esImagen && !esVideo && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <span className="text-5xl">{icono(archivo.type)}</span>
              <p className="max-w-xs break-all text-xs text-slate-500">{archivo.name}</p>
            </div>
          )}
        </div>

        {excedido && (
          <p className="border-t border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700">
            {esVideo
              ? `Supera los ${tope} MB. Elegí un video más corto.`
              : `Supera el límite de ${tope} MB que acepta WhatsApp. Elegí un archivo más chico.`}
          </p>
        )}

        <div className="border-t border-slate-100 p-4">
          <textarea
            ref={areaRef}
            rows={2}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!excedido && !enviando) onEnviar(caption.trim());
              }
              if (e.key === 'Escape') onCancelar();
            }}
            placeholder="Epígrafe (opcional)"
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-marca-500 focus:bg-white"
          />

          <div className="mt-3 flex items-center gap-2">
            <p className="text-[11px] text-slate-400">
              {archivo.type.startsWith('audio/')
                ? 'Los audios se envían sin epígrafe'
                : 'Enter para enviar · Esc para cancelar'}
            </p>

            <button
              onClick={onCancelar}
              className="ml-auto rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              onClick={() => onEnviar(caption.trim())}
              disabled={excedido || enviando}
              className="rounded-lg bg-marca-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-marca-600 disabled:opacity-40"
            >
              {enviando ? 'Enviando…' : 'Enviar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
