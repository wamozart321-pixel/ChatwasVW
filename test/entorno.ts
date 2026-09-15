/**
 * A que servidor le pegan las pruebas, y una traba para no arruinar produccion.
 *
 * Las suites de integracion no son de solo lectura: crean contactos, reparten
 * conversaciones y usan `vaciarBandejaDe`, que SUELTA todo lo que un asesor
 * tenga encima. Corriendo eso contra el servidor de verdad, un cliente que
 * estaba siendo atendido vuelve a la cola sin que nadie entienda por que.
 *
 * Por eso, contra cualquier cosa que no sea localhost hay que decirlo a mano:
 *
 *   BASE_PRUEBAS=https://bandeja.chatwasvw.com PRUEBAS_EN_PRODUCCION=si npm run test:admin
 */
import { esBaseDeProduccion } from '../scripts/es-produccion';

export const BASE = process.env.BASE_PRUEBAS ?? `http://localhost:${process.env.PORT ?? '3000'}`;

const esLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);

export function exigirEntornoSeguro(): void {
  /*
   * Primero la base, aunque el servidor sea local.
   *
   * La traba de abajo mira a qué servidor le pegan las pruebas, y eso alcanzaba
   * mientras localhost usaba la base de desarrollo. Pero esa base se borra al
   * migrar los clientes, y de ahí en más el servidor local —el mismo localhost que
   * la traba deja pasar— escribe en producción.
   */
  try {
    process.loadEnvFile();
  } catch {
    /* sin .env */
  }

  if (esBaseDeProduccion(process.env.DATABASE_URL) && process.env.PRUEBAS_EN_PRODUCCION !== 'si') {
    console.error(`
  El .env apunta a la base de PRODUCCIÓN.

  Estas suites crean contactos y conversaciones falsas y sueltan las que los
  asesores tengan asignadas: corridas acá, ensucian la bandeja de verdad y le
  sacan clientes de encima a quien los está atendiendo.

  Para probar algo con datos reales sin tocarlos, sacá una rama de producción en
  Neon, apuntá el .env a esa rama, y borrala al terminar.
`);
    process.exit(1);
  }

  if (esLocal) return;
  if (process.env.PRUEBAS_EN_PRODUCCION === 'si') {
    console.log(`\n  ATENCION: corriendo contra ${BASE}, que no es local.\n`);
    return;
  }

  console.error(`
  Las pruebas apuntan a ${BASE}, que no es local.

  Estas suites escriben: crean conversaciones falsas y sueltan las que los
  asesores tengan asignadas. Contra el servidor de verdad eso le saca
  clientes de encima a gente que los esta atendiendo.

  Si aun asi es lo que queres:

    PRUEBAS_EN_PRODUCCION=si npm run test:...

  Lo correcto es tener una base aparte para desarrollo. En Neon se hace con
  una rama de la base, que es una copia y no cuesta nada.
`);
  process.exit(1);
}
