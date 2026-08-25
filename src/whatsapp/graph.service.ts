import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

export class GraphError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly detalle?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

interface RespuestaEnvio {
  messaging_product: string;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string; message_status?: string }[];
}

/** Cliente HTTP contra el Graph API de Meta. Sin logica de negocio. */
@Injectable()
export class GraphService {
  private readonly log = new Logger(GraphService.name);
  private readonly base = `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

  private async pedir<T>(ruta: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${ruta}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    const texto = await res.text();
    let cuerpo: any = null;
    try {
      cuerpo = texto ? JSON.parse(texto) : null;
    } catch {
      /* Meta a veces devuelve HTML en errores de infraestructura */
    }

    if (!res.ok) {
      const e = cuerpo?.error ?? {};
      throw new GraphError(
        e.message ?? `Graph respondio ${res.status}`,
        res.status,
        e.code,
        e.error_subcode,
        e.error_data?.details ?? texto.slice(0, 500),
      );
    }

    return cuerpo as T;
  }

  /** Envia texto libre. Solo funciona dentro de la ventana de 24h. */
  async enviarTexto(a: string, cuerpo: string, previewUrl = true): Promise<string> {
    const r = await this.pedir<RespuestaEnvio>(`/${env.META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: a,
        type: 'text',
        text: { preview_url: previewUrl, body: cuerpo },
      }),
    });

    const id = r.messages?.[0]?.id;
    if (!id) throw new GraphError('Meta acepto el envio pero no devolvio message id', 502);
    return id;
  }

  /**
   * Envia una ubicacion. Le llega al cliente como un mapa que puede tocar para
   * abrir en su aplicacion de mapas y trazar la ruta.
   */
  async enviarUbicacion(
    a: string,
    ubicacion: { latitud: number; longitud: number; nombre?: string; direccion?: string },
  ): Promise<string> {
    const r = await this.pedir<RespuestaEnvio>(`/${env.META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: a,
        type: 'location',
        location: {
          latitude: ubicacion.latitud,
          longitude: ubicacion.longitud,
          ...(ubicacion.nombre ? { name: ubicacion.nombre } : {}),
          ...(ubicacion.direccion ? { address: ubicacion.direccion } : {}),
        },
      }),
    });

    const id = r.messages?.[0]?.id;
    if (!id) throw new GraphError('Meta acepto el envio pero no devolvio message id', 502);
    return id;
  }

  /**
   * Envia una plantilla aprobada. Es la unica via fuera de la ventana de 24h.
   * (El flujo completo de plantillas llega en el paso 4; esto es el transporte.)
   */
  async enviarPlantilla(
    a: string,
    nombre: string,
    idioma: string,
    componentes: unknown[] = [],
  ): Promise<string> {
    const r = await this.pedir<RespuestaEnvio>(`/${env.META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: a,
        type: 'template',
        template: {
          name: nombre,
          language: { code: idioma },
          ...(componentes.length ? { components: componentes } : {}),
        },
      }),
    });

    const id = r.messages?.[0]?.id;
    if (!id) throw new GraphError('Meta acepto la plantilla pero no devolvio message id', 502);
    return id;
  }

  /**
   * Mensaje con botones. Es texto libre para WhatsApp, asi que solo funciona
   * dentro de la ventana de 24 h — igual que cualquier respuesta del bot.
   *
   * Limites de Meta: hasta 3 botones, 20 caracteres de titulo cada uno, y los
   * ids tienen que ser unicos dentro del mensaje.
   */
  async enviarBotones(
    a: string,
    cuerpo: string,
    botones: { id: string; titulo: string }[],
  ): Promise<string> {
    if (botones.length === 0 || botones.length > 3) {
      throw new GraphError('WhatsApp acepta entre 1 y 3 botones', 400);
    }

    const r = await this.pedir<RespuestaEnvio>(`/${env.META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: a,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: cuerpo },
          action: {
            buttons: botones.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.titulo.slice(0, 20) },
            })),
          },
        },
      }),
    });

    const id = r.messages?.[0]?.id;
    if (!id) throw new GraphError('Meta acepto los botones pero no devolvio message id', 502);
    return id;
  }

  /** Marca el mensaje como leido: al cliente le aparecen los dos checks azules. */
  async marcarLeido(waMessageId: string): Promise<void> {
    try {
      await this.pedir(`/${env.META_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: waMessageId,
        }),
      });
    } catch (e) {
      // No es critico: no debe tumbar el procesamiento del mensaje.
      this.log.warn(`no se pudo marcar leido ${waMessageId}: ${(e as Error).message}`);
    }
  }

  /** La URL devuelta expira a los ~5 minutos: hay que descargar de inmediato. */
  async urlDeMedia(mediaId: string): Promise<{ url: string; mime_type?: string; file_size?: number }> {
    return this.pedir(`/${mediaId}`);
  }

  /** Descarga binaria de media. Requiere el mismo Bearer token. */
  async descargarMedia(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new GraphError(`descarga de media fallo (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Sube un archivo a Meta y devuelve su media id.
   * El id sirve para enviarlo despues, y vale 30 dias.
   */
  async subirMedia(datos: Buffer, mime: string, nombre: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([new Uint8Array(datos)], { type: mime }), nombre);

    // Sin Content-Type propio: fetch lo arma con el boundary del multipart.
    const res = await fetch(`${this.base}/${env.META_PHONE_NUMBER_ID}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });

    const cuerpo: any = await res.json().catch(() => null);
    if (!res.ok || !cuerpo?.id) {
      const e = cuerpo?.error ?? {};
      throw new GraphError(e.message ?? `no se pudo subir el archivo (${res.status})`, res.status, e.code);
    }

    return cuerpo.id as string;
  }

  /** Envia un archivo ya subido. `tipo` es image | video | audio | document | sticker. */
  async enviarMedia(
    a: string,
    tipo: string,
    mediaId: string,
    opciones: { caption?: string; filename?: string } = {},
  ): Promise<string> {
    const contenido: Record<string, unknown> = { id: mediaId };

    // Meta rechaza caption en audio y sticker, y filename solo aplica a documentos.
    if (opciones.caption && ['image', 'video', 'document'].includes(tipo)) {
      contenido.caption = opciones.caption;
    }
    if (opciones.filename && tipo === 'document') contenido.filename = opciones.filename;

    const r = await this.pedir<RespuestaEnvio>(`/${env.META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: a,
        type: tipo,
        [tipo]: contenido,
      }),
    });

    const id = r.messages?.[0]?.id;
    if (!id) throw new GraphError('Meta acepto el archivo pero no devolvio message id', 502);
    return id;
  }

  /** Plantillas de la WABA, con su estado de aprobacion. */
  async plantillas(): Promise<
    { id: string; name: string; language: string; category?: string; status: string; components?: unknown[] }[]
  > {
    const salida: any[] = [];
    let ruta = `/${env.META_WABA_ID}/message_templates?fields=id,name,language,category,status,components&limit=100`;

    // Meta pagina de a 100; una WABA puede tener bastantes mas.
    while (ruta) {
      const r = await this.pedir<any>(ruta);
      salida.push(...(r.data ?? []));

      const siguiente: string | undefined = r.paging?.next;
      if (!siguiente || salida.length > 1000) break;
      ruta = siguiente.replace(`https://graph.facebook.com/${env.META_GRAPH_VERSION}`, '');
    }

    return salida;
  }

  /**
   * Crea una plantilla y la manda a aprobar.
   *
   * Queda en PENDING hasta que Meta la revisa (de horas a un par de dias). La
   * categoria importa mas de lo que parece: UTILITY es seguimiento de algo que
   * el cliente ya pidio y cuesta menos; MARKETING es promocion y cuesta mas. Si
   * el texto no encaja con la categoria declarada, Meta la recategoriza o la
   * rechaza.
   */
  async crearPlantilla(datos: {
    nombre: string;
    idioma: string;
    categoria: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
    componentes: unknown[];
  }): Promise<{ id: string; status: string; category?: string }> {
    return this.pedir(`/${env.META_WABA_ID}/message_templates`, {
      method: 'POST',
      body: JSON.stringify({
        name: datos.nombre,
        language: datos.idioma,
        category: datos.categoria,
        components: datos.componentes,
      }),
    });
  }

  /** Borra una plantilla de la WABA. Los mensajes ya enviados no se tocan. */
  async borrarPlantilla(nombre: string): Promise<void> {
    await this.pedir(
      `/${env.META_WABA_ID}/message_templates?name=${encodeURIComponent(nombre)}`,
      { method: 'DELETE' },
    );
  }

  /** Diagnostico: confirma que el token y el phone number id son correctos. */
  async infoDelNumero(): Promise<Record<string, unknown>> {
    return this.pedir(
      `/${env.META_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,quality_rating,platform_type`,
    );
  }
}
