/**
 * Mensajes rápidos: lo que el asesor escribe veinte veces al día.
 *
 * En el redactor se abren tecleando «/» al principio del mensaje —o con el
 * botón ⚡—, se filtran siguiendo la escritura y se eligen con Enter. El texto
 * cae en el campo para poder retocarlo antes de mandarlo: nunca sale solo. Eso
 * es a propósito: un mensaje rápido acierta el 90 % de las veces, y el 10 %
 * restante hay que corregirlo antes de que salga por WhatsApp.
 *
 * ── Para agregar uno ──────────────────────────────────────────────────────
 * Copiá una de las líneas de abajo y cambiala:
 *
 *   { atajo: 'saludo', paraQue: 'Abrir la conversación', texto: 'Hola...' },
 *
 *   atajo    lo que se teclea después de la barra. Sin espacios y en
 *            minúscula, para que se pueda escribir de corrido: /saludo
 *   paraQue  una línea de ayuda que se ve en gris en la lista. Opcional.
 *   texto    lo que queda escrito en el redactor. Puede tener varios
 *            renglones si se escribe con \n.
 *
 * Dentro del texto hay dos huecos que se rellenan al elegirlo:
 *
 *   {nombre}  el nombre del cliente (sólo el primero, si tiene varios)
 *   {asesor}  el nombre del asesor conectado
 *
 * Si el contacto todavía no tiene nombre guardado, {nombre} desaparece y la
 * frase se acomoda sola: «Hola, con gusto...» en vez de «Hola , con gusto...».
 *
 * El orden de esta lista es el orden en que aparecen, así que conviene dejar
 * arriba los tres o cuatro de todos los días.
 */
export interface MensajeRapido {
  /** Lo que se teclea después de «/». Sin espacios. */
  atajo: string;
  /** El texto que entra al redactor. Admite {nombre} y {asesor}. */
  texto: string;
  /** Para qué sirve, en criollo. Se ve en la lista. */
  paraQue?: string;
}

export const MENSAJES_RAPIDOS: MensajeRapido[] = [
  {
    atajo: 'saludo',
    paraQue: 'Abrir la conversación',
    texto:
      'Hola {nombre}, gracias por escribir a Repuestos Volkswagen Jhon Pardo. ' +
      'Soy {asesor}, con gusto te ayudo.',
  },
  {
    atajo: 'datos',
    paraQue: 'Pedir los datos del carro para poder cotizar',
    texto:
      'Para confirmarte la pieza exacta, me ayudas con estos datos:\n' +
      '• Modelo y año del carro\n' +
      '• Motor (cilindraje)\n' +
      '• Una foto de la pieza o el número de referencia',
  },
  {
    atajo: 'revisando',
    paraQue: 'El cliente pidió algo y hay que buscarlo en bodega',
    texto: 'Permíteme un momento, {nombre}: reviso disponibilidad y te confirmo enseguida.',
  },
  {
    atajo: 'envio',
    paraQue: 'Cómo se hacen los envíos',
    texto:
      'Hacemos envíos a todo el país. El despacho sale el mismo día si el pedido queda ' +
      'confirmado antes de las 3:00 p. m., y el flete lo cotizamos según la ciudad.',
  },
  {
    atajo: 'pago',
    paraQue: 'Las formas de pago',
    texto:
      'Recibimos efectivo, transferencia y tarjeta. Si prefieres transferencia te paso ' +
      'los datos de la cuenta y apenas nos llegue el soporte despachamos.',
  },
  {
    atajo: 'horario',
    paraQue: 'Horario de atención',
    texto:
      'Atendemos de lunes a viernes de 8:00 a. m. a 6:00 p. m. y los sábados de ' +
      '8:00 a. m. a 1:00 p. m.',
  },
  {
    atajo: 'gracias',
    paraQue: 'Cerrar la conversación',
    texto:
      'Gracias por escribirnos, {nombre}. Cualquier cosa que necesites quedamos por aquí ' +
      'a la orden.',
  },
];

/** El nombre de pila: «Carlos Andrés Pérez» → «Carlos». */
function primerNombre(completo: string | null | undefined): string {
  return (completo ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * Rellena {nombre} y {asesor}.
 *
 * Cuando el contacto no tiene nombre el hueco queda vacío, y sin limpiar
 * después la frase sale con un espacio suelto antes de la coma —«Hola ,»—, que
 * es justo lo que delata que el mensaje fue armado por una máquina.
 */
export function resolverRapido(
  texto: string,
  datos: { contacto?: string | null; asesor?: string | null },
): string {
  return texto
    .replace(/\{nombre\}/g, primerNombre(datos.contacto))
    .replace(/\{asesor\}/g, (datos.asesor ?? '').trim())
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Los que calzan con lo tecleado tras la barra.
 *
 * Busca en el atajo y en el texto: nadie se acuerda de que el atajo del horario
 * es «/horario», pero sí de que el mensaje decía «sábados».
 */
export function buscarRapidos(filtro: string): MensajeRapido[] {
  const q = filtro.trim().toLowerCase();
  if (!q) return MENSAJES_RAPIDOS;

  const empiezan = MENSAJES_RAPIDOS.filter((m) => m.atajo.toLowerCase().startsWith(q));

  // Buscar dentro del texto sólo desde tres letras: con «en» calzaban los siete
  // mensajes, porque «en» está en todos, y la lista dejaba de filtrar nada.
  const resto = MENSAJES_RAPIDOS.filter(
    (m) =>
      !empiezan.includes(m) &&
      (m.atajo.toLowerCase().includes(q) ||
        (q.length >= 3 &&
          (m.texto.toLowerCase().includes(q) || (m.paraQue ?? '').toLowerCase().includes(q)))),
  );

  // Primero los que empiezan igual: tecleando «/en» lo que se busca es /envio,
  // no los seis mensajes que en alguna parte dicen «en».
  return [...empiezan, ...resto];
}
