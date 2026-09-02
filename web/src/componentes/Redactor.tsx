import { useEffect, useRef, useState } from 'react';
import type { UbicacionNegocio } from '../api';
import EnviarUbicacion from './EnviarUbicacion';
import GrabarAudio from './GrabarAudio';

function restante(vence: string | null): string {
  if (!vence) return '';
  const ms = new Date(vence).getTime() - Date.now();
  if (ms <= 0) return '';
  const horas = Math.floor(ms / 3_600_000);
  const min = Math.floor((ms % 3_600_000) / 60_000);
  return horas > 0 ? `${horas} h ${min} min` : `${min} min`;
}

/**
 * Caja de escritura. Se bloquea sola cuando la ventana de 24 h vence: fuera de
 * ella Meta rechaza el texto libre, asi que es mejor que el asesor lo sepa antes
 * de escribir el mensaje y no despues de darle enviar.
 */
export default function Redactor({
  ventanaAbierta,
  ventanaVence,
  enviando,
  onEnviar,
  onArchivo,
  onAudio,
  onPlantilla,
  onUbicacion,
  ubicacionNegocio,
  onEscribiendo,
  onDejarDeEscribir,
}: {
  ventanaAbierta: boolean;
  ventanaVence: string | null;
  enviando: boolean;
  onEnviar: (texto: string) => void;
  onArchivo: (archivo: File) => void;
  onAudio: (archivo: File) => void;
  onPlantilla: () => void;
  onUbicacion: (datos: {
    latitud?: number;
    longitud?: number;
    texto?: string;
    nombre?: string;
    direccion?: string;
  }) => void;
  ubicacionNegocio: UbicacionNegocio | null;
  onEscribiendo: () => void;
  onDejarDeEscribir: () => void;
}) {
  const [texto, setTexto] = useState('');
  const [verUbicacion, setVerUbicacion] = useState(false);
  const [grabando, setGrabando] = useState(false);
  const [verCamara, setVerCamara] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const archivoRef = useRef<HTMLInputElement>(null);
  const fotoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  // Crece con el contenido, hasta un tope.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [texto]);

  function enviar() {
    const limpio = texto.trim();
    if (!limpio || enviando) return;
    onEnviar(limpio);
    setTexto('');
    onDejarDeEscribir();
  }

  function alTipear(valor: string) {
    setTexto(valor);
    // El servidor expira el aviso solo; aca solo hace falta refrescarlo.
    if (valor.trim()) onEscribiendo();
    else onDejarDeEscribir();
  }

  if (!ventanaAbierta) {
    return (
      <div className="border-t border-amber-200 bg-amber-50 px-4 py-4 md:px-6">
        <p className="text-sm font-medium text-amber-900">Ventana de 24 horas cerrada</p>
        <p className="mt-1 text-xs text-amber-700">
          Pasaron más de 24 h desde el último mensaje del cliente. WhatsApp sólo permite
          retomar la conversación con una plantilla aprobada.
        </p>
        <button
          onClick={onPlantilla}
          className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
        >
          Elegir plantilla
        </button>
      </div>
    );
  }

  const queda = restante(ventanaVence);
  // Sin "h" en el texto significa que falta menos de una hora.
  const porVencer = queda !== '' && !queda.includes('h');

  return (
    <div className="border-t border-slate-200 bg-white px-3 py-3 md:px-6">
      {porVencer && (
        <p className="mb-2 text-xs font-medium text-amber-600">La ventana vence en {queda}</p>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={archivoRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            // No se envia todavia: primero se muestra para confirmar. Un archivo
            // que ya salio por WhatsApp no se puede corregir.
            if (archivo) onArchivo(archivo);
            // Se limpia para poder volver a elegir el mismo archivo.
            e.target.value = '';
          }}
        />
        <button
          onClick={() => archivoRef.current?.click()}
          disabled={enviando}
          title="Adjuntar archivo"
          className="mb-0.5 rounded-xl border border-slate-200 px-3 py-2.5 text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
        >
          📎
        </button>

        {/*
            «capture» le pide al teléfono la cámara de atrás en vez del
            explorador de archivos. En un computador el navegador lo ignora y
            abre el selector de siempre, que es lo único que puede hacer ahí.
        */}
        <input
          ref={fotoRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            if (archivo) onArchivo(archivo);
            e.target.value = '';
          }}
        />
        <input
          ref={videoRef}
          type="file"
          accept="video/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            if (archivo) onArchivo(archivo);
            e.target.value = '';
          }}
        />

        <div className="relative mb-0.5">
          <button
            onClick={() => setVerCamara((v) => !v)}
            disabled={enviando}
            title="Tomar una foto o grabar un video"
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
          >
            📷
          </button>

          {verCamara && (
            <>
              {/* Tapa la pantalla para poder cerrar tocando al lado. */}
              <div className="fixed inset-0 z-10" onClick={() => setVerCamara(false)} />
              <div className="absolute bottom-full left-0 z-20 mb-2 w-40 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                <button
                  onClick={() => {
                    setVerCamara(false);
                    fotoRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  📸 Foto
                </button>
                <button
                  onClick={() => {
                    setVerCamara(false);
                    videoRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  🎥 Video
                </button>
              </div>
            </>
          )}
        </div>

        <button
          onClick={() => setVerUbicacion(true)}
          disabled={enviando}
          title="Enviar ubicación"
          className="mb-0.5 rounded-xl border border-slate-200 px-3 py-2.5 text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
        >
          📍
        </button>

        <div className="relative mb-0.5">
          <button
            onClick={() => setGrabando(true)}
            disabled={enviando}
            title="Grabar una nota de voz"
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
          >
            🎤
          </button>

          {grabando && (
            <GrabarAudio
              enviando={enviando}
              onCerrar={() => setGrabando(false)}
              onEnviar={(archivo) => {
                setGrabando(false);
                // Directo, sin pasar por la pantalla de epígrafe: una nota de
                // voz no lleva texto, y en el grabador ya se escuchó antes de
                // mandarla. Pedir un pie de foto ahí es un paso de más.
                onAudio(archivo);
              }}
            />
          )}
        </div>

        {/* El mapa va en un modal a pantalla completa: en un globito de 300 px
            no se puede elegir un punto de una ciudad. */}
        {verUbicacion && (
          <EnviarUbicacion
            negocio={ubicacionNegocio}
            enviando={enviando}
            onCerrar={() => setVerUbicacion(false)}
            onEnviar={(datos) => {
              setVerUbicacion(false);
              onUbicacion(datos);
            }}
          />
        )}
        <textarea
          ref={areaRef}
          rows={1}
          value={texto}
          onChange={(e) => alTipear(e.target.value)}
          onKeyDown={(e) => {
            // Enter envia, Shift+Enter hace salto de linea: como WhatsApp.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              enviar();
            }
          }}
          placeholder="Escribí un mensaje..."
          className="max-h-36 flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-marca-500 focus:bg-white"
        />
        <button
          onClick={enviar}
          disabled={!texto.trim() || enviando}
          className="mb-0.5 rounded-xl bg-marca-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-marca-600 disabled:opacity-40"
        >
          {enviando ? '...' : 'Enviar'}
        </button>
      </div>

      {queda && (
        <p className="mt-1.5 text-[11px] text-slate-400">Ventana abierta · quedan {queda}</p>
      )}
    </div>
  );
}
