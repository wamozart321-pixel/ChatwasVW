import type { WaMensaje } from '../whatsapp/webhook.types';

export interface ContenidoNormalizado {
  tipo: string;
  cuerpo: string | null;
  caption: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  ubicacionLat: number | null;
  ubicacionLon: number | null;
}

/** Aplana los ~14 tipos de mensaje de WhatsApp a una forma unica para la tabla. */
export function extraerContenido(m: WaMensaje): ContenidoNormalizado {
  const base: ContenidoNormalizado = {
    tipo: m.type,
    cuerpo: null,
    caption: null,
    mediaId: null,
    mediaMime: null,
    ubicacionLat: null,
    ubicacionLon: null,
  };

  switch (m.type) {
    case 'text':
      return { ...base, cuerpo: m.text?.body ?? null };

    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const media = (m as any)[m.type];
      return {
        ...base,
        mediaId: media?.id ?? null,
        mediaMime: media?.mime_type ?? null,
        caption: media?.caption ?? null,
        cuerpo: media?.caption ?? media?.filename ?? null,
      };
    }

    case 'location': {
      const l = m.location;
      const etiqueta = [l?.name, l?.address].filter(Boolean).join(' - ');
      return {
        ...base,
        cuerpo: etiqueta || `${l?.latitude}, ${l?.longitude}`,
        ubicacionLat: typeof l?.latitude === 'number' ? l.latitude : null,
        ubicacionLon: typeof l?.longitude === 'number' ? l.longitude : null,
      };
    }

    case 'button':
      return { ...base, cuerpo: m.button?.text ?? m.button?.payload ?? null };

    case 'interactive':
      return {
        ...base,
        cuerpo:
          m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null,
      };

    case 'reaction':
      return { ...base, cuerpo: m.reaction?.emoji ?? null };

    case 'contacts':
      return { ...base, cuerpo: '[contacto compartido]' };

    case 'order':
      return { ...base, cuerpo: '[pedido de catalogo]' };

    case 'unsupported':
      return { ...base, cuerpo: m.errors?.[0]?.title ?? '[mensaje no soportado]' };

    default:
      return { ...base, cuerpo: `[${m.type}]` };
  }
}

/** Meta manda epoch en segundos como string. */
export function fechaDeMeta(timestamp: string | undefined): Date {
  const seg = Number(timestamp);
  return Number.isFinite(seg) && seg > 0 ? new Date(seg * 1000) : new Date();
}
