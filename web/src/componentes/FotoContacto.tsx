import { useEffect, useState } from 'react';
import { sesion } from '../api';

/**
 * La foto de un contacto, o sus iniciales si no tiene.
 *
 * NO es la foto de perfil de WhatsApp: esa no se puede leer, y no por falta de
 * ganas. La Cloud API no la expone, y la única vía que sí la tiene —una sesión
 * de WhatsApp Web— exige que el número esté registrado en la app normal, cosa
 * que deja de ser cierta en cuanto se migra a la API. Los dos sistemas se
 * excluyen. Ésta la pone el equipo.
 *
 * Se baja con el token, como el resto de los archivos: son fotos de clientes y
 * no pueden quedar accesibles con adivinar la URL. Por eso no alcanza con un
 * `<img src>` a secas.
 */

/**
 * Las fotos ya bajadas, compartidas por toda la bandeja.
 *
 * Sin esto, la misma foto se pide una vez en la lista de chats, otra en el
 * panel del contacto y otra cada vez que se vuelve a dibujar la lista.
 */
const cache = new Map<string, Promise<string | null>>();

function bajar(contactoId: string): Promise<string | null> {
  const guardada = cache.get(contactoId);
  if (guardada) return guardada;

  const promesa = fetch(`/api/contactos/${contactoId}/foto`, {
    headers: { Authorization: `Bearer ${sesion.token() ?? ''}` },
  })
    .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
    .catch(() => null);

  cache.set(contactoId, promesa);
  return promesa;
}

/** Se llama al cambiar una foto: si no, sigue viéndose la anterior. */
export function olvidarFoto(contactoId: string): void {
  const guardada = cache.get(contactoId);
  if (guardada) void guardada.then((url) => url && URL.revokeObjectURL(url));
  cache.delete(contactoId);
}

export default function FotoContacto({
  contactoId,
  tieneFoto,
  iniciales,
  color,
  className = 'size-10',
}: {
  contactoId: string;
  tieneFoto: boolean;
  iniciales: string;
  /** Clases del fondo cuando no hay foto; el color es estable por contacto. */
  color: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!tieneFoto) {
      setUrl(null);
      return;
    }

    let vigente = true;
    void bajar(contactoId).then((u) => vigente && setUrl(u));

    return () => {
      vigente = false;
    };
  }, [contactoId, tieneFoto]);

  if (tieneFoto && url) {
    return (
      <img
        src={url}
        alt=""
        className={`${className} shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${className} flex shrink-0 items-center justify-center rounded-full text-xs font-semibold ${color}`}
    >
      {iniciales}
    </div>
  );
}
