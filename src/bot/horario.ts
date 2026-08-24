/**
 * Horario de atención y festivos de Colombia.
 *
 * Los festivos se calculan, no se listan: una lista escrita a mano vence en
 * diciembre y el bot empieza a contestar «estamos abiertos» un 6 de enero.
 */

/** Domingo de Pascua por el algoritmo de Meeus/Jones/Butcher. */
function pascua(anio: number): Date {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(Date.UTC(anio, mes - 1, dia));
}

const sumarDias = (fecha: Date, dias: number) =>
  new Date(fecha.getTime() + dias * 86_400_000);

/** Ley Emiliani: varios festivos se corren al lunes siguiente. */
function alLunes(fecha: Date): Date {
  const dia = fecha.getUTCDay();
  return dia === 1 ? fecha : sumarDias(fecha, (8 - dia) % 7);
}

const clave = (f: Date) => f.toISOString().slice(0, 10);

const cache = new Map<number, Set<string>>();

/** Festivos colombianos de un año, como 'YYYY-MM-DD'. */
export function festivosDe(anio: number): Set<string> {
  const guardado = cache.get(anio);
  if (guardado) return guardado;

  const p = pascua(anio);

  const fechas = [
    // Fijos: no se mueven.
    new Date(Date.UTC(anio, 0, 1)), // Año Nuevo
    new Date(Date.UTC(anio, 4, 1)), // Día del Trabajo
    new Date(Date.UTC(anio, 6, 20)), // Independencia
    new Date(Date.UTC(anio, 7, 7)), // Batalla de Boyacá
    new Date(Date.UTC(anio, 11, 8)), // Inmaculada Concepción
    new Date(Date.UTC(anio, 11, 25)), // Navidad

    // Semana Santa: tampoco se mueven.
    sumarDias(p, -3), // Jueves Santo
    sumarDias(p, -2), // Viernes Santo

    // Ley Emiliani: al lunes siguiente.
    alLunes(new Date(Date.UTC(anio, 0, 6))), // Reyes Magos
    alLunes(new Date(Date.UTC(anio, 2, 19))), // San José
    alLunes(new Date(Date.UTC(anio, 5, 29))), // San Pedro y San Pablo
    alLunes(new Date(Date.UTC(anio, 7, 15))), // Asunción
    alLunes(new Date(Date.UTC(anio, 9, 12))), // Día de la Raza
    alLunes(new Date(Date.UTC(anio, 10, 1))), // Todos los Santos
    alLunes(new Date(Date.UTC(anio, 10, 11))), // Independencia de Cartagena

    // Móviles con Emiliani ya aplicada en el desplazamiento.
    sumarDias(p, 43), // Ascensión
    sumarDias(p, 64), // Corpus Christi
    sumarDias(p, 71), // Sagrado Corazón
  ];

  const set = new Set(fechas.map(clave));
  cache.set(anio, set);
  return set;
}

export interface Franja {
  /** Minutos desde medianoche. */
  desde: number;
  hasta: number;
}

export interface Horario {
  /** 0 = domingo … 6 = sábado. `null` = cerrado. */
  porDia: (Franja | null)[];
  zona: string;
}

/** '08:30-17:30' -> { desde: 510, hasta: 1050 }. 'cerrado' -> null. */
export function parsearFranja(texto: string): Franja | null {
  const limpio = texto.trim().toLowerCase();
  if (!limpio || limpio === 'cerrado') return null;

  const m = limpio.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`horario inválido: "${texto}". Se espera 08:30-17:30 o "cerrado"`);

  const desde = Number(m[1]) * 60 + Number(m[2]);
  const hasta = Number(m[3]) * 60 + Number(m[4]);
  if (hasta <= desde) throw new Error(`horario inválido: "${texto}". La hora final va después`);

  return { desde, hasta };
}

/** Día de la semana y minutos del día, en la zona horaria del negocio. */
function localDe(fecha: Date, zona: string): { dia: number; minutos: number; ymd: string } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);

  const buscar = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // El servidor puede estar en cualquier zona: la única que importa es la del
  // negocio, o el bot dice «estamos abiertos» a las 3 de la mañana.
  return {
    dia: dias[buscar('weekday')] ?? 0,
    minutos: Number(buscar('hour')) * 60 + Number(buscar('minute')),
    ymd: `${buscar('year')}-${buscar('month')}-${buscar('day')}`,
  };
}

export function esFestivo(fecha: Date, zona: string): boolean {
  const { ymd } = localDe(fecha, zona);
  return festivosDe(Number(ymd.slice(0, 4))).has(ymd);
}

export function estaAbierto(fecha: Date, horario: Horario): boolean {
  if (esFestivo(fecha, horario.zona)) return false;

  const { dia, minutos } = localDe(fecha, horario.zona);
  const franja = horario.porDia[dia];

  return !!franja && minutos >= franja.desde && minutos < franja.hasta;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const hhmm = (minutos: number) =>
  `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;

/**
 * Cuándo vuelve a abrir, en criollo: «mañana a las 8:30», «el lunes a las 8:30».
 * Sirve para que el mensaje de fuera de horario diga algo útil y no sólo
 * «estamos cerrados».
 */
export function proximaApertura(fecha: Date, horario: Horario): string {
  const { dia, minutos } = localDe(fecha, horario.zona);

  // Hoy mismo, si todavía no abrió.
  const hoy = horario.porDia[dia];
  if (hoy && minutos < hoy.desde && !esFestivo(fecha, horario.zona)) {
    return `hoy a las ${hhmm(hoy.desde)}`;
  }

  for (let i = 1; i <= 8; i++) {
    const candidato = new Date(fecha.getTime() + i * 86_400_000);
    if (esFestivo(candidato, horario.zona)) continue;

    const { dia: d } = localDe(candidato, horario.zona);
    const franja = horario.porDia[d];
    if (!franja) continue;

    const cuando = i === 1 ? 'mañana' : `el ${DIAS[d]}`;
    return `${cuando} a las ${hhmm(franja.desde)}`;
  }

  return 'apenas volvamos a abrir';
}
