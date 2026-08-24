/**
 * El flujo del bot, declarado en un solo lugar.
 *
 * Está en código y no en una tabla a propósito: son cinco pasos, cambian poco,
 * y leerlos de corrido acá es más fácil que reconstruirlos de varias filas. El
 * día que el equipo quiera editarlos sin tocar código, esto se mueve a la base
 * sin cambiar el motor.
 */

export type Paso = 'menu' | 'vehiculo' | 'repuesto';

export interface OpcionBoton {
  id: string;
  titulo: string;
}

/** Lo que el bot manda al entrar a un paso. */
export interface Pregunta {
  texto: string;
  botones?: OpcionBoton[];
}

export const BOTONES_MENU: OpcionBoton[] = [
  { id: 'cotizar', titulo: 'Cotizar repuesto' },
  { id: 'pedido', titulo: 'Estado de pedido' },
  { id: 'asesor', titulo: 'Hablar con asesor' },
];

/**
 * Si el cliente escribe algo de esto, se va derecho a un humano.
 *
 * Nadie tiene que quedar atrapado en un menú: es la queja número uno contra
 * cualquier bot, y en un negocio donde la venta depende del trato personal
 * sale mucho más caro que atender un mensaje de más.
 */
const PIDE_HUMANO =
  /\b(asesor|humano|persona|alguien|operador|hablar con|atienda|atiendan|real)\b/i;

/** Cuántas veces puede no entender antes de pasar a un humano. */
export const MAX_INTENTOS = 2;

export function pideHumano(texto: string): boolean {
  return PIDE_HUMANO.test(texto);
}

/**
 * Interpreta la respuesta del menú: sirve tanto el id del botón como el texto
 * suelto, porque siempre hay quien escribe «1» o «cotizar» en vez de tocar.
 */
export function opcionElegida(texto: string, botonId?: string): string | null {
  if (botonId && BOTONES_MENU.some((b) => b.id === botonId)) return botonId;

  const t = texto.trim().toLowerCase();

  if (/^1\b/.test(t) || /\b(cotiz|precio|vale|cuesta|cuanto)/.test(t)) return 'cotizar';
  if (/^2\b/.test(t) || /\b(pedido|orden|encargo|envio|envío)/.test(t)) return 'pedido';
  if (/^3\b/.test(t) || pideHumano(t)) return 'asesor';

  return null;
}

export function saludo(negocio: string, abierto: boolean, vuelve: string): Pregunta {
  const base = `¡Hola! Gracias por escribir a ${negocio}.`;

  const texto = abierto
    ? `${base}\n\nPara atenderte más rápido, cuéntame qué necesitas:`
    : `${base}\n\nEn este momento estamos cerrados, volvemos ${vuelve}. ` +
      `Igual déjame los datos y apenas abramos te respondemos:`;

  return { texto, botones: BOTONES_MENU };
}

export function noEntendi(): Pregunta {
  return {
    texto: 'Disculpa, no te entendí. Elige una de estas opciones:',
    botones: BOTONES_MENU,
  };
}

export function preguntaDe(paso: Paso, datosPrevios?: Record<string, string>): Pregunta {
  switch (paso) {
    case 'vehiculo':
      // Si ya se sabe el vehículo de una conversación anterior, se confirma en
      // vez de volver a preguntar: es lo que más molesta de repetir.
      return datosPrevios?.vehiculo
        ? {
            texto: `¿Es para el mismo vehículo de la última vez? (${datosPrevios.vehiculo})`,
            botones: [
              { id: 'mismo', titulo: 'Sí, el mismo' },
              { id: 'otro', titulo: 'Es otro vehículo' },
            ],
          }
        : {
            texto:
              '¿Para qué vehículo es? Dime modelo y año.\n\nPor ejemplo: Golf 2015 1.4 TSI',
          };

    case 'repuesto':
      return { texto: '¿Y qué repuesto necesitas?' };

    default:
      return { texto: '' };
  }
}

export function despedida(abierto: boolean, vuelve: string): string {
  return abierto
    ? 'Listo, ya le paso tu consulta a un asesor. En un momento te responde.'
    : `Listo, tomé nota. Apenas abramos ${vuelve} un asesor te responde.`;
}

/** Resumen para la nota interna: lo que el asesor ve antes de abrir el chat. */
export function resumenParaAsesor(datos: Record<string, string>): string {
  const etiquetas: Record<string, string> = {
    motivo: 'Motivo',
    vehiculo: 'Vehículo',
    repuesto: 'Repuesto',
  };

  const lineas = Object.entries(etiquetas)
    .filter(([k]) => datos[k])
    .map(([k, etiqueta]) => `${etiqueta}: ${datos[k]}`);

  return lineas.length
    ? `Recolectado por el bot —\n${lineas.join('\n')}`
    : 'El cliente pidió hablar directo con un asesor.';
}
