import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Lugar, type UbicacionNegocio } from '../api';

/**
 * Mapa para elegir y mandar una ubicación.
 *
 * Se usa OpenStreetMap y no Google Maps: Google cobra por carga de mapa y exige
 * tarjeta y clave de API. Para marcar dónde vive un cliente en Bogotá, OSM
 * alcanza y no cuesta nada.
 *
 * El pin arranca donde tenga sentido —el local, si está configurado— y se mueve
 * tocando el mapa o arrastrándolo. Cada vez que se mueve se consulta qué
 * dirección es: mandar un punto sin ver a qué calle corresponde es cómo se
 * termina mandando la cuadra equivocada.
 */

const BOGOTA: [number, number] = [4.6482, -74.0776];

/**
 * Pin dibujado, no una imagen.
 *
 * El marcador que trae Leaflet apunta a archivos .png por ruta relativa, que
 * con un empaquetador quedan fuera del build y el pin no se ve. Un divIcon no
 * depende de ningún archivo.
 */
const PIN = L.divIcon({
  className: '',
  html: `<div style="
    width:26px;height:26px;border-radius:50% 50% 50% 0;
    background:#059669;border:3px solid #fff;
    transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 26],
});

export default function EnviarUbicacion({
  negocio,
  enviando,
  onEnviar,
  onCerrar,
}: {
  negocio: UbicacionNegocio | null;
  enviando: boolean;
  onEnviar: (datos: {
    latitud?: number;
    longitud?: number;
    texto?: string;
    nombre?: string;
    direccion?: string;
  }) => void;
  onCerrar: () => void;
}) {
  const contenedorRef = useRef<HTMLDivElement>(null);
  const mapaRef = useRef<L.Map | null>(null);
  const marcaRef = useRef<L.Marker | null>(null);

  const inicial: [number, number] = negocio
    ? [negocio.latitud, negocio.longitud]
    : BOGOTA;

  const [punto, setPunto] = useState<[number, number]>(inicial);
  const [direccion, setDireccion] = useState<string | null>(null);
  const [buscandoDireccion, setBuscandoDireccion] = useState(false);

  const [consulta, setConsulta] = useState('');
  const [resultados, setResultados] = useState<Lugar[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState('');

  // --- mapa -----------------------------------------------------------------

  useEffect(() => {
    if (!contenedorRef.current || mapaRef.current) return;

    const mapa = L.map(contenedorRef.current, { zoomControl: true }).setView(inicial, 15);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // La atribución es obligatoria por la licencia de OpenStreetMap.
      attribution: '&copy; OpenStreetMap',
    }).addTo(mapa);

    const marca = L.marker(inicial, { icon: PIN, draggable: true }).addTo(mapa);

    marca.on('dragend', () => {
      const { lat, lng } = marca.getLatLng();
      setPunto([lat, lng]);
    });

    mapa.on('click', (e: L.LeafletMouseEvent) => {
      marca.setLatLng(e.latlng);
      setPunto([e.latlng.lat, e.latlng.lng]);
    });

    mapaRef.current = mapa;
    marcaRef.current = marca;

    // El mapa se dibuja mal si el contenedor cambia de tamaño después de
    // montarlo, que es lo que pasa dentro de un modal que aparece.
    setTimeout(() => mapa.invalidateSize(), 100);

    return () => {
      mapa.remove();
      mapaRef.current = null;
      marcaRef.current = null;
    };
    // Solo al montar: mover el mapa después se hace con la ref, no recreándolo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const alTeclado = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', alTeclado);
    return () => window.removeEventListener('keydown', alTeclado);
  }, [onCerrar]);

  /** Qué calle es el punto actual. Con retraso: mover el pin dispara muchos. */
  useEffect(() => {
    let vigente = true;
    setBuscandoDireccion(true);

    const t = setTimeout(() => {
      api
        .direccionDe(punto[0], punto[1])
        .then((r) => vigente && setDireccion(r.direccion))
        .catch(() => vigente && setDireccion(null))
        .finally(() => vigente && setBuscandoDireccion(false));
    }, 600);

    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [punto]);

  const irA = useCallback((lat: number, lon: number, zoom = 17) => {
    setPunto([lat, lon]);
    marcaRef.current?.setLatLng([lat, lon]);
    mapaRef.current?.setView([lat, lon], zoom);
  }, []);

  // --- búsqueda -------------------------------------------------------------

  async function buscar() {
    const q = consulta.trim();
    if (q.length < 3) return;

    setBuscando(true);
    setError('');
    try {
      const encontrados = await api.buscarDireccion(q);
      setResultados(encontrados);
      if (encontrados.length === 0) setError('No se encontró esa dirección. Probá con otra.');
    } catch {
      setError('El buscador de direcciones no responde. Podés marcar el punto en el mapa.');
    } finally {
      setBuscando(false);
    }
  }

  /** Pegar un enlace de Maps sigue sirviendo: mueve el pin, no manda de una. */
  async function usarPegado(texto: string) {
    if (!texto.trim()) return;
    setError('');
    try {
      const r = await api.resolverUbicacion(texto);
      irA(r.latitud, r.longitud);
      setResultados(null);
      setConsulta('');
    } catch {
      setError('Ese texto no es una dirección ni un enlace de mapa.');
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Enviar ubicación</h3>
          <button
            onClick={onCerrar}
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100"
          >
            ✕
          </button>
        </header>

        <div className="border-b border-slate-100 px-4 py-3">
          <div className="flex gap-2">
            <input
              value={consulta}
              autoFocus
              onChange={(e) => setConsulta(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                // Si pegaron un enlace de mapa, se resuelve; si no, se busca.
                if (/^https?:\/\//i.test(consulta.trim())) usarPegado(consulta);
                else buscar();
              }}
              placeholder="Buscá una dirección, o pegá un enlace de Maps"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              onClick={() => (/^https?:\/\//i.test(consulta.trim()) ? usarPegado(consulta) : buscar())}
              disabled={buscando || consulta.trim().length < 3}
              className="rounded-lg border border-slate-300 px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {buscando ? '…' : 'Buscar'}
            </button>
          </div>

          {negocio && (
            <button
              onClick={() => irA(negocio.latitud, negocio.longitud)}
              className="mt-2 text-xs text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
            >
              🏪 Ir a nuestro local
            </button>
          )}

          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
            Direcciones tipo <span className="font-mono">Cra 27A #66-82</span> caen en la
            esquina; la placa exacta se ajusta moviendo el pin. El mapa no tiene los números
            de las casas en Colombia.
          </p>

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

          {resultados && resultados.length > 0 && (
            <ul className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-slate-200">
              {resultados.map((r, i) => (
                <li key={i}>
                  <button
                    onClick={() => {
                      irA(r.latitud, r.longitud);
                      setResultados(null);
                    }}
                    className="block w-full border-b border-slate-100 px-3 py-2 text-left text-xs last:border-0 hover:bg-slate-50"
                  >
                    {/* La esquina calculada es la respuesta correcta a una
                        direccion colombiana; el resto son tramos sueltos con
                        ese nombre, que pueden estar en la otra punta. */}
                    {/^[^—]*—\s*(esquina|cerca)/.test(r.nombre) ? (
                      <span className="font-medium text-emerald-700">📍 {r.nombre}</span>
                    ) : (
                      <span className="text-slate-600">{r.nombre}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div ref={contenedorRef} className="h-80 w-full shrink-0 bg-slate-100" />

        <div className="border-t border-slate-100 px-4 py-3">
          <p className="text-[11px] text-slate-400">
            Tocá el mapa o arrastrá el pin para mover el punto
          </p>
          <p className="mt-1 min-h-8 text-xs text-slate-700">
            {buscandoDireccion ? (
              <span className="text-slate-400">Buscando la dirección…</span>
            ) : (
              (direccion ?? `${punto[0].toFixed(5)}, ${punto[1].toFixed(5)}`)
            )}
          </p>

          <div className="mt-2 flex gap-2">
            <button
              disabled={enviando}
              onClick={() =>
                onEnviar({
                  latitud: punto[0],
                  longitud: punto[1],
                  // El nombre solo si es el local: para un punto cualquiera, la
                  // dirección ya dice todo lo que hay que decir.
                  nombre:
                    negocio && punto[0] === negocio.latitud && punto[1] === negocio.longitud
                      ? negocio.nombre
                      : undefined,
                  direccion: direccion ?? undefined,
                })
              }
              className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Enviar esta ubicación
            </button>
            <button
              onClick={onCerrar}
              className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100"
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
