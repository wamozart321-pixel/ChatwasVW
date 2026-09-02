/**
 * El cálculo de la onda de una nota de voz: la tira de barras que WhatsApp
 * dibuja debajo del botón de reproducir.
 *
 * Acá no se toca el navegador a propósito. Decodificar el audio es cosa suya y
 * vive en `decodificar-onda.ts`; repartir esas muestras en barras es nuestro, y
 * es la parte que puede estar mal, así que se prueba aparte.
 */

/** Cuántas barras tiene la onda. Suficientes para dar forma sin ser ruido. */
export const BARRAS = 40;

/**
 * De las muestras crudas a las alturas de las barras.
 *
 * Aparte de `calcularOnda` porque es la parte que puede estar mal y la única
 * que se puede probar sin un navegador: decodificar audio lo hace el navegador,
 * repartir esas muestras en barras lo hacemos nosotros.
 */
export function barrasDe(muestras: Float32Array, barras = BARRAS): number[] | null {
  const porBarra = Math.floor(muestras.length / barras);
  if (porBarra < 1) return null;

  const crudas: number[] = [];
  for (let i = 0; i < barras; i++) {
    // Valor eficaz y no el pico: un chasquido suelto haría una barra enorme al
    // lado de otras treinta planas, y la onda dejaría de decir nada.
    let suma = 0;
    for (let j = 0; j < porBarra; j++) {
      const v = muestras[i * porBarra + j] ?? 0;
      suma += v * v;
    }
    crudas.push(Math.sqrt(suma / porBarra));
  }

  // Se normaliza contra la barra más alta: una nota grabada bajito tiene que
  // verse igual de nítida que una gritada, porque lo que interesa es la forma
  // —dónde se habló y dónde se hizo silencio—, no el volumen absoluto.
  const techo = Math.max(...crudas);
  if (techo <= 0) return null;

  return crudas.map((v) => Math.min(1, v / techo));
}
