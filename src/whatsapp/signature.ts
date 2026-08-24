import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Valida la cabecera X-Hub-Signature-256 de Meta.
 * Se firma el cuerpo CRUDO: si el JSON se re-serializa, la firma no cuadra.
 */
export function firmaValida(
  rawBody: Buffer,
  cabecera: string | undefined,
  appSecret: string,
): boolean {
  if (!cabecera || !cabecera.startsWith('sha256=')) return false;

  const hex = cabecera.slice('sha256='.length).trim();
  // Buffer.from con hex invalido no lanza: trunca. La comparacion de largo lo cubre.
  if (!/^[0-9a-f]+$/i.test(hex)) return false;

  const recibido = Buffer.from(hex, 'hex');
  const esperado = createHmac('sha256', appSecret).update(rawBody).digest();

  if (recibido.length !== esperado.length) return false;
  return timingSafeEqual(recibido, esperado);
}
