import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { env } from '../config/env';
import { DB, type Database } from '../db/db.module';
import { templates } from '../db/schema';
import { GraphService } from '../whatsapp/graph.service';

interface ComponenteMeta {
  type: string; // HEADER | BODY | FOOTER | BUTTONS
  format?: string; // TEXT | IMAGE | VIDEO | DOCUMENT
  text?: string;
  buttons?: { type: string; text: string }[];
}

/**
 * Las que quedaron de probar y no se pueden borrar.
 *
 * Meta rechaza el DELETE con «Need permission on either WhatsApp Business
 * Account or owner/shared business» aunque el token tenga
 * whatsapp_business_management: borrar plantillas pide control total sobre la
 * cuenta, y la nuestra es compartida. Así que se esconden acá: siguen en la
 * cuenta de Meta, pero no en el selector, que es donde estorban —un asesor
 * apurado manda «Prueba temporal.» a un cliente y no hay cómo recogerlo—.
 *
 * La regla es por nombre para que valga también para la próxima: cualquiera
 * que empiece con «prueba» o termine en «_tmp» no se muestra. El que quiera
 * una plantilla de verdad, que no la bautice así.
 */
const ES_DE_PRUEBA = /^prueba|_tmp$/i;

/** Cuenta los {{1}}, {{2}}… de un texto y devuelve cuántos hay. */
function cuantasVariables(texto: string | undefined): number {
  if (!texto) return 0;
  const encontrados = texto.match(/\{\{\s*(\d+)\s*\}\}/g) ?? [];
  const numeros = encontrados.map((m) => Number(m.replace(/\D/g, '')));
  return numeros.length ? Math.max(...numeros) : 0;
}

@Injectable()
export class PlantillasService {
  private readonly log = new Logger(PlantillasService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly graph: GraphService,
  ) {}

  /**
   * Copia las plantillas de la WABA a la base.
   *
   * Se guardan localmente en vez de consultar Meta en cada envío: la lista casi
   * no cambia, y el asesor no puede esperar una llamada a la API para ver qué
   * tiene disponible. Las que Meta ya no devuelve se marcan como eliminadas en
   * lugar de borrarse, porque hay mensajes que las referencian.
   */
  async sincronizar() {
    const deMeta = await this.graph.plantillas();

    for (const p of deMeta) {
      await this.db
        .insert(templates)
        .values({
          metaId: p.id,
          nombre: p.name,
          idioma: p.language,
          categoria: p.category ?? null,
          estado: p.status,
          componentes: (p.components ?? []) as unknown[],
          sincronizadaEn: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          target: [templates.nombre, templates.idioma],
          set: {
            metaId: p.id,
            categoria: p.category ?? null,
            estado: p.status,
            componentes: (p.components ?? []) as unknown[],
            sincronizadaEn: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          },
        });
    }

    const vistas = deMeta.map((p) => `${p.name}:${p.language}`);
    if (vistas.length) {
      // ARRAY[$1, $2, ...] parametrizado: interpolar los nombres a mano sería
      // una inyección esperando a un nombre con comilla. Y pasar el array de JS
      // directo no sirve: Drizzle lo expande como una fila, no como un array.
      const lista = sql.join(
        vistas.map((v) => sql`${v}`),
        sql`, `,
      );

      await this.db
        .update(templates)
        .set({ estado: 'ELIMINADA', updatedAt: sql`clock_timestamp()` })
        .where(
          sql`${templates.nombre} || ':' || ${templates.idioma} <> ALL(ARRAY[${lista}]::text[])`,
        );
    }

    this.log.log(`${deMeta.length} plantillas sincronizadas`);
    return { sincronizadas: deMeta.length };
  }

  /**
   * Sólo las aprobadas, en el idioma del negocio y que no sean de prueba.
   *
   * Las que Meta deja de fábrica en la cuenta —hello_world y las cuatro de la
   * tienda de ejemplo «Jasper's Market»— están en inglés y no se pueden borrar
   * sin control total sobre la cuenta de WhatsApp. Filtrarlas por idioma las
   * saca del selector: una plantilla en inglés no se le manda a un cliente de
   * Bogotá, así que la regla vale igual para cualquiera que aparezca después.
   *
   * Las de prueba se filtran por nombre, ver ES_DE_PRUEBA.
   */
  async listar() {
    const filas = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.estado, 'APPROVED'), eq(templates.idioma, env.PLANTILLAS_IDIOMA)))
      .orderBy(asc(templates.nombre));

    return filas
      .filter((t) => !ES_DE_PRUEBA.test(t.nombre))
      .map((t) => {
        const componentes = (t.componentes ?? []) as ComponenteMeta[];
        const cuerpo = componentes.find((c) => c.type === 'BODY');
        const encabezado = componentes.find((c) => c.type === 'HEADER');
        const pie = componentes.find((c) => c.type === 'FOOTER');
        const botones = componentes.find((c) => c.type === 'BUTTONS');

        return {
          id: t.id,
          nombre: t.nombre,
          idioma: t.idioma,
          categoria: t.categoria,
          textoEncabezado: encabezado?.format === 'TEXT' ? (encabezado.text ?? null) : null,
          formatoEncabezado: encabezado?.format ?? null,
          textoCuerpo: cuerpo?.text ?? '',
          textoPie: pie?.text ?? null,
          botones: botones?.buttons?.map((b) => b.text) ?? [],
          variablesEncabezado:
            encabezado?.format === 'TEXT' ? cuantasVariables(encabezado.text) : 0,
          variablesCuerpo: cuantasVariables(cuerpo?.text),
          /** Un encabezado de imagen/video/documento necesita un archivo, no texto. */
          necesitaArchivo: !!encabezado && encabezado.format !== 'TEXT',
        };
      });
  }

  /**
   * Arma el array `components` que espera Meta a partir de los valores que
   * cargó el asesor, y valida que estén todos: si falta uno, Meta rechaza el
   * envío con un error críptico.
   */
  async componentesPara(templateId: string, valores: { encabezado?: string[]; cuerpo?: string[] }) {
    const lista = await this.listar();
    const plantilla = lista.find((t) => t.id === templateId);

    if (!plantilla) throw new NotFoundException('plantilla inexistente o no aprobada');
    if (plantilla.necesitaArchivo) {
      throw new BadRequestException(
        'esta plantilla lleva un archivo en el encabezado; todavía no está soportado',
      );
    }

    const enc = valores.encabezado ?? [];
    const cue = valores.cuerpo ?? [];

    if (enc.length < plantilla.variablesEncabezado || cue.length < plantilla.variablesCuerpo) {
      throw new BadRequestException('faltan valores para las variables de la plantilla');
    }

    const componentes: unknown[] = [];

    if (plantilla.variablesEncabezado > 0) {
      componentes.push({
        type: 'header',
        parameters: enc
          .slice(0, plantilla.variablesEncabezado)
          .map((text) => ({ type: 'text', text })),
      });
    }

    if (plantilla.variablesCuerpo > 0) {
      componentes.push({
        type: 'body',
        parameters: cue.slice(0, plantilla.variablesCuerpo).map((text) => ({ type: 'text', text })),
      });
    }

    return { plantilla, componentes };
  }

  /** Texto final, con las variables reemplazadas: lo que se guarda en el hilo. */
  vistaPrevia(
    plantilla: { textoCuerpo: string; textoEncabezado: string | null },
    valores: { encabezado?: string[]; cuerpo?: string[] },
  ): string {
    const reemplazar = (texto: string, vals: string[]) =>
      texto.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => vals[Number(n) - 1] ?? `{{${n}}}`);

    const partes = [
      plantilla.textoEncabezado
        ? reemplazar(plantilla.textoEncabezado, valores.encabezado ?? [])
        : null,
      reemplazar(plantilla.textoCuerpo, valores.cuerpo ?? []),
    ].filter(Boolean);

    return partes.join('\n\n');
  }
}
