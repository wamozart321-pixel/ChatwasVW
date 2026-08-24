/** Formas del payload de webhook de la Cloud API que realmente consumimos. */

export interface WaPerfil {
  name?: string;
}

export interface WaContacto {
  wa_id: string;
  profile?: WaPerfil;
}

export interface WaMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

export interface WaMensaje {
  id: string;
  from: string;
  /** Epoch en SEGUNDOS, como string. */
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WaMedia;
  video?: WaMedia;
  audio?: WaMedia;
  document?: WaMedia;
  sticker?: WaMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown[];
  button?: { text?: string; payload?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  reaction?: { message_id: string; emoji?: string };
  /** Presente cuando el cliente responde citando otro mensaje. */
  context?: { from?: string; id?: string };
  errors?: WaError[];
}

export interface WaError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

export interface WaEstado {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: WaError[];
}

export interface WaValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WaContacto[];
  messages?: WaMensaje[];
  statuses?: WaEstado[];
  errors?: WaError[];
}

export interface WaChange {
  field: string;
  value: WaValue;
}

export interface WaEntry {
  id: string;
  changes?: WaChange[];
}

export interface WaWebhookPayload {
  object?: string;
  entry?: WaEntry[];
}
