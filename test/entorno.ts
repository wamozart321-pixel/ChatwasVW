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
export const BASE = process.env.BASE_PRUEBAS ?? `http://localhost:${process.env.PORT ?? '3000'}`;

const esLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);

export function exigirEntornoSeguro(): void {
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
