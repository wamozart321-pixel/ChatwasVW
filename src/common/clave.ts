import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Compara contra DEV_API_KEY en tiempo constante.
 *
 * Es una clave compartida por todo el equipo, no autenticacion real: sirve para
 * probar contra la base sin pasar por la bandeja. La atencion real va por el
 * login de asesores, que ademas permite saber QUIEN respondio cada mensaje.
 *
 * Si DEV_API_KEY no esta puesta, estos endpoints quedan cerrados para todos.
 */
export function claveValida(valor: unknown): boolean {
  // Sin DEV_API_KEY configurada no hay clave que valga: es como se apagan los
  // endpoints de prueba en produccion. Nunca devuelve true por estar vacia.
  if (!env.DEV_API_KEY) return false;
  if (typeof valor !== 'string') return false;

  const enviada = Buffer.from(valor);
  const esperada = Buffer.from(env.DEV_API_KEY);

  if (enviada.length !== esperada.length) return false;
  return timingSafeEqual(enviada, esperada);
}
