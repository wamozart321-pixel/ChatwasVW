/**
 * Crea y consulta plantillas de WhatsApp sin pasar por el panel de Meta.
 *
 *   npm run plantillas -- listar
 *   npm run plantillas -- sugeridas          crea el juego para el negocio
 *   npm run plantillas -- crear <archivo.json>
 *   npm run plantillas -- borrar <nombre>
 *
 * Las plantillas quedan en PENDING hasta que Meta las aprueba: de horas a un
 * par de días. Recién ahí aparecen en el selector de la bandeja.
 */
import { readFileSync } from 'node:fs';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const V = process.env.META_GRAPH_VERSION ?? 'v23.0';
const TOKEN = process.env.META_ACCESS_TOKEN ?? '';
const WABA = process.env.META_WABA_ID ?? '';

if (!TOKEN || !WABA) {
  console.error('faltan META_ACCESS_TOKEN o META_WABA_ID en el .env');
  process.exit(1);
}

interface Plantilla {
  nombre: string;
  idioma: string;
  categoria: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  /** Para qué sirve, en criollo. No se manda a Meta. */
  paraQue: string;
  cuerpo: string;
  /** Un valor de ejemplo por variable. Meta los exige para poder revisarla. */
  ejemplo: string[];
  pie?: string;
}

/**
 * El juego base para un negocio de repuestos.
 *
 * Todas son UTILITY a propósito: hablan de algo que el cliente ya pidió, que es
 * lo que Meta entiende por utilidad y lo que hace que cuesten menos. Una del
 * estilo «tenemos promociones» sería MARKETING, más cara, y con más chances de
 * que la gente la marque como spam.
 *
 * El texto es neutro (sin «vos» ni «usted» marcados) para que suene natural en
 * cualquier parte de Colombia.
 */
const SUGERIDAS: Plantilla[] = [
  {
    nombre: 'seguimiento_consulta',
    idioma: 'es',
    categoria: 'UTILITY',
    paraQue: 'Retomar una conversación que pasó las 24 h sin cerrarse',
    cuerpo:
      'Hola {{1}}, te escribimos de Repuestos Volkswagen Jhon Pardo por tu consulta sobre {{2}}. ' +
      'Seguimos a la orden: responde por aquí y continuamos donde quedamos.',
    ejemplo: ['Carlos', 'pastillas de freno para Golf 2015'],
    pie: 'Repuestos Volkswagen Jhon Pardo',
  },
  {
    nombre: 'cotizacion_lista',
    idioma: 'es',
    categoria: 'UTILITY',
    paraQue: 'Avisar el precio de algo que el cliente pidió cotizar',
    cuerpo:
      'Hola {{1}}, ya tenemos la cotización de {{2}}: {{3}}. ' +
      'Si quieres que te lo apartemos, responde por aquí y lo dejamos separado.',
    ejemplo: ['Andrea', 'espejo retrovisor derecho para Jetta 2018', '$320.000 instalado'],
    pie: 'Repuestos Volkswagen Jhon Pardo',
  },
  {
    nombre: 'repuesto_disponible',
    idioma: 'es',
    categoria: 'UTILITY',
    paraQue: 'Avisar que llegó un repuesto que el cliente estaba esperando',
    cuerpo:
      'Hola {{1}}, ya llegó el {{2}} que estabas esperando. ' +
      'Puedes pasar a recogerlo o responder por aquí y coordinamos el envío.',
    ejemplo: ['Luisa', 'kit de embrague para Tiguan'],
    pie: 'Repuestos Volkswagen Jhon Pardo',
  },
];

function componentesDe(p: Plantilla): unknown[] {
  const componentes: unknown[] = [
    {
      type: 'BODY',
      text: p.cuerpo,
      // Meta rechaza una plantilla con variables si no le das ejemplos: los usa
      // para entender qué va en cada hueco durante la revisión.
      ...(p.ejemplo.length ? { example: { body_text: [p.ejemplo] } } : {}),
    },
  ];

  if (p.pie) componentes.push({ type: 'FOOTER', text: p.pie });
  return componentes;
}

async function graph(ruta: string, init: RequestInit = {}) {
  const r = await fetch(`https://graph.facebook.com/${V}${ruta}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const cuerpo = (await r.json().catch(() => null)) as any;
  return { ok: r.ok, status: r.status, cuerpo };
}

async function listar() {
  const { ok, cuerpo } = await graph(
    `/${WABA}/message_templates?fields=name,language,category,status,components&limit=100`,
  );

  if (!ok) {
    console.error(`no se pudo listar: ${cuerpo?.error?.message ?? ''}`);
    process.exit(1);
  }

  const plantillas = cuerpo.data ?? [];
  if (!plantillas.length) {
    console.log('\nno hay plantillas. Creá las sugeridas con: npm run plantillas -- sugeridas\n');
    return;
  }

  console.log();
  for (const p of plantillas) {
    const marca = p.status === 'APPROVED' ? 'ok      ' : `${p.status.padEnd(8)}`;
    const texto = (p.components ?? []).find((c: any) => c.type === 'BODY')?.text ?? '';
    console.log(`  ${marca} ${p.name.padEnd(24)} ${String(p.category).padEnd(10)} ${p.language}`);
    console.log(`           ${texto.replace(/\n/g, ' ').slice(0, 78)}`);
  }

  const pendientes = plantillas.filter((p: any) => p.status === 'PENDING').length;
  if (pendientes) {
    console.log(`\n  ${pendientes} esperando aprobación de Meta. Sólo las APPROVED se pueden enviar.`);
  }
  console.log();
}

async function crear(p: Plantilla) {
  const { ok, cuerpo } = await graph(`/${WABA}/message_templates`, {
    method: 'POST',
    body: JSON.stringify({
      name: p.nombre,
      language: p.idioma,
      category: p.categoria,
      components: componentesDe(p),
    }),
  });

  if (!ok) {
    const e = cuerpo?.error ?? {};
    // 2388023 = ya existe una con ese nombre e idioma.
    if (e.error_subcode === 2388023 || String(e.message ?? '').includes('already exists')) {
      console.log(`  ya existía   ${p.nombre}`);
      return;
    }
    console.error(`  ERROR        ${p.nombre}: ${e.error_user_msg ?? e.message ?? 'desconocido'}`);
    return;
  }

  console.log(`  ${String(cuerpo.status ?? 'CREADA').padEnd(12)} ${p.nombre}`);

  // Meta puede recategorizar: si pedís UTILITY y el texto suena promocional,
  // te la pasa a MARKETING y ahí cambia lo que cuesta cada envío.
  if (cuerpo.category && cuerpo.category !== p.categoria) {
    console.log(`               ojo: Meta la clasificó como ${cuerpo.category}, no ${p.categoria}`);
  }
}

async function sugeridas() {
  console.log('\ncreando plantillas para el negocio...\n');

  for (const p of SUGERIDAS) {
    console.log(`  · ${p.paraQue}`);
    await crear(p);
  }

  console.log('\nQuedan PENDING hasta que Meta las revise (horas a un par de días).');
  console.log('Cuando estén aprobadas, traelas con: npm run plantillas -- listar');
  console.log('y aparecen solas en el selector de la bandeja.\n');
}

async function main() {
  const [comando, arg] = process.argv.slice(2);

  switch (comando) {
    case 'listar':
      await listar();
      break;

    case 'sugeridas':
      await sugeridas();
      break;

    case 'crear': {
      if (!arg) {
        console.error('uso: npm run plantillas -- crear <archivo.json>');
        process.exit(1);
      }
      const propia = JSON.parse(readFileSync(arg, 'utf8')) as Plantilla;
      await crear(propia);
      break;
    }

    case 'borrar': {
      if (!arg) {
        console.error('uso: npm run plantillas -- borrar <nombre>');
        process.exit(1);
      }
      const { ok, cuerpo } = await graph(
        `/${WABA}/message_templates?name=${encodeURIComponent(arg)}`,
        { method: 'DELETE' },
      );
      console.log(ok ? `borrada: ${arg}` : `no se pudo: ${cuerpo?.error?.message ?? ''}`);
      break;
    }

    default:
      console.log('comandos: listar | sugeridas | crear <archivo.json> | borrar <nombre>');
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
