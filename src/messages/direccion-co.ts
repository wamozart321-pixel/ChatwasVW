/**
 * Entiende una direccion colombiana.
 *
 * "Cra 27A #66-82" no es un texto libre: es una coordenada. Significa
 * *Carrera 27A, a la altura de la Calle 66, placa 82*. El buscador de
 * OpenStreetMap no sabe eso: busca la cadena entera, encuentra que existe una
 * "Carrera 27A", y devuelve cualquiera de los 16 tramos con ese nombre que hay
 * en Bogota — uno queda en Galerias y otro en Ciudad Bolivar.
 *
 * Partiendo la direccion en sus dos vias se puede buscar cada una y quedarse
 * con el punto donde se cruzan, que es lo que el cliente quiso decir.
 *
 * Lo que NO se puede sacar es la placa exacta (el "-82"): OpenStreetMap casi no
 * tiene numeros de casa en Colombia. Se llega a la esquina; los metros finales
 * los ajusta el asesor arrastrando el pin.
 */

export interface DireccionColombiana {
  /** La via sobre la que esta el lugar. Ej: "Carrera 27A". */
  principal: string;
  /** La via que la cruza, deducida del primer numero. Ej: "Calle 66". */
  cruce: string;
  /** Los metros desde la esquina. Se conserva para mostrarlo, no se puede geocodificar. */
  placa: string | null;
}

/** Como escribe la gente cada tipo de via, y su nombre completo. */
const TIPOS: [RegExp, string][] = [
  [/^(?:cra|kra|kr|cr|carrera|cll?ra)$/i, 'Carrera'],
  [/^(?:cl|cll|clle|calle|ca)$/i, 'Calle'],
  [/^(?:av|avda|avenida)$/i, 'Avenida'],
  [/^(?:ak|av\.?\s*cra|avenida\s*carrera)$/i, 'Avenida Carrera'],
  [/^(?:ac|av\.?\s*cll?|avenida\s*calle)$/i, 'Avenida Calle'],
  [/^(?:dg|diag|diagonal)$/i, 'Diagonal'],
  [/^(?:tv|tvs|trans|transv|transversal)$/i, 'Transversal'],
  [/^(?:cq|circunvalar)$/i, 'Circunvalar'],
];

/**
 * Que via cruza a cual.
 *
 * En la cuadricula de las ciudades colombianas las carreras van en un sentido
 * y las calles en el otro, asi que una direccion sobre una carrera se ubica por
 * una calle y viceversa. Diagonales y transversales cortan la cuadricula en
 * diagonal; se las busca contra calles, que es lo que mas veces acierta.
 */
function tipoDelCruce(principal: string): string {
  if (/carrera/i.test(principal)) return 'Calle';
  if (/calle/i.test(principal)) return 'Carrera';
  if (/transversal/i.test(principal)) return 'Calle';
  if (/diagonal/i.test(principal)) return 'Carrera';
  return 'Calle';
}

function nombreDeTipo(abreviatura: string): string | null {
  const limpio = abreviatura.replace(/\./g, '').trim();
  for (const [patron, nombre] of TIPOS) if (patron.test(limpio)) return nombre;
  return null;
}

/**
 * Parte una direccion en sus dos vias. null si no parece una direccion.
 *
 * Acepta lo que la gente escribe de verdad: con y sin '#', con 'No', con
 * puntos, en mayusculas, con el sufijo de letra pegado o separado.
 */
export function parsearDireccionCo(texto: string): DireccionColombiana | null {
  const limpio = (texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // sin tildes: "Diagonal" y "Diagonál"
    .replace(/\s+/g, ' ')
    .trim();

  if (!limpio) return null;

  // tipo + numero + [letra] + separador + numero del cruce + [letra] + [- placa]
  const m = limpio.match(
    /^([a-z.]+)\s*(\d{1,3})\s*([a-z](?:\s*bis)?)?\s*(?:#|no\.?|nro\.?|num\.?|-)?\s*(\d{1,3})\s*([a-z])?\s*(?:-\s*(\d{1,3}))?/i,
  );
  if (!m) return null;

  const tipo = nombreDeTipo(m[1]);
  if (!tipo) return null;

  const sufijo = m[3] ? m[3].replace(/\s+/g, '').toUpperCase() : '';
  const sufijoCruce = m[5] ? m[5].toUpperCase() : '';

  return {
    principal: `${tipo} ${m[2]}${sufijo}`,
    cruce: `${tipoDelCruce(tipo)} ${m[4]}${sufijoCruce}`,
    placa: m[6] ?? null,
  };
}

/** Como se muestra de vuelta, ya ordenada. */
export function comoTexto(d: DireccionColombiana): string {
  return d.placa ? `${d.principal} # ${d.cruce.replace(/^\D+/, '')}-${d.placa}` : d.principal;
}
