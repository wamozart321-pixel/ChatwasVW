/*
 * Prueba de integracion del modo "dormir", contra la base de DESARROLLO.
 *
 *   npm run test:dormir
 *
 * Va en JS contra dist/ y no en TS con tsx como las demas: tsx no emite la
 * metadata de los decoradores, y sin ella Nest no sabe que inyectarle al worker.
 *
 * Simula lo que hace Neon al apagar el computo: terminar las conexiones. Verifica
 * que el proceso no se caiga, que el worker deje de consultar sin actividad, y que
 * al volver la actividad retome el lock y procese la cola.
 */
process.loadEnvFile();

// Directo, sin el pooler: asi se conecta produccion, y con PgBouncer en el medio
// terminar la conexion del servidor no le llega al cliente.
const url = (process.env.DATABASE_URL ?? '').replace('-pooler', '');
process.env.DATABASE_URL = url;
if (!url.includes('ep-cold-pine')) {
  console.error('esta prueba solo corre contra la base de desarrollo (ep-cold-pine)');
  process.exit(1);
}

require('reflect-metadata');
const { Module, Logger } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Pool } = require('pg');
const { DbModule, PG_POOL } = require('../dist/db/db.module');
const { ActividadService } = require('../dist/db/actividad.service');
const { WebhookWorker } = require('../dist/queue/webhook.worker');
const { InboundService } = require('../dist/whatsapp/inbound.service');
const { configPostgres } = require('../dist/db/conexion');

const LOCK = 20260822;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Si algo tumba el proceso, que se vea como FALLA de la prueba y no pase callado.
let seCayo = null;
process.on('uncaughtException', (e) => {
  seCayo = e;
  console.error('\nFALLA: excepcion no atrapada ->', e.message);
});

const procesados = [];

async function main() {
  class Prueba {}
  Module({
    imports: [DbModule],
    providers: [
      WebhookWorker,
      { provide: InboundService, useValue: { procesar: async (p) => procesados.push(p) } },
    ],
  })(Prueba);

  const app = await NestFactory.createApplicationContext(Prueba, { logger: ['log', 'warn', 'error'] });
  const pool = app.get(PG_POOL);
  const actividad = app.get(ActividadService);
  const worker = app.get(WebhookWorker);

  // Un contador de todo lo que toca la base desde el pool de la app.
  let consultas = 0;
  const conectar = pool.connect.bind(pool);
  pool.connect = (...a) => { consultas++; return conectar(...a); };
  const consultar = pool.query.bind(pool);
  pool.query = (...a) => { consultas++; return consultar(...a); };

  // Conexion aparte para mirar y para "apagar" la base.
  const ojo = new Pool(configPostgres(url, 1));
  const quienTieneElLock = async () =>
    (await ojo.query(
      `select pid from pg_locks where locktype = 'advisory' and objid = $1 and granted`,
      [LOCK],
    )).rows[0]?.pid ?? null;

  const resultados = [];
  const comprobar = (nombre, ok, detalle = '') => {
    resultados.push(ok);
    console.log(`  ${ok ? 'OK   ' : 'FALLA'} ${nombre}${detalle ? '  (' + detalle + ')' : ''}`);
  };

  console.log('\n1) arranque');
  await esperar(3000);
  const pid1 = await quienTieneElLock();
  comprobar('el worker toma el lock al arrancar', pid1 !== null, 'pid ' + pid1);

  console.log('\n2) sin actividad deja de consultar');
  actividad.ventanaMs = 2000; // la ventana real es de 10 min
  await esperar(4000); // pasa la ventana y el worker entra a esperar
  const antes = consultas;
  await esperar(5000);
  comprobar('en 5 s sin actividad no toca la base', consultas === antes, `${consultas - antes} consultas`);

  console.log('\n3) Neon apaga la base: termina las conexiones');
  await ojo.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and usename = current_user`,
  );
  await esperar(1500);
  comprobar('el proceso sigue vivo', seCayo === null);
  comprobar('el worker sabe que perdio el lock', worker.tieneLock === false);
  comprobar('y no lo retoma solo mientras no hay actividad (dejaria la base despierta)', (await quienTieneElLock()) === null);

  console.log('\n4) llega un webhook: vuelve la actividad');
  const { rows: [fila] } = await ojo.query(
    `insert into webhook_events (payload) values ($1) returning id`,
    [JSON.stringify({ prueba_dormir: true })],
  );
  actividad.ventanaMs = 60_000;
  actividad.marcar(); // lo que hace encolar()
  await esperar(4000);

  const pid2 = await quienTieneElLock();
  comprobar('retoma el lock al despertar', pid2 !== null && pid2 !== pid1, `pid ${pid1} -> ${pid2}`);
  comprobar('procesa el webhook que desperto', procesados.some((p) => p?.prueba_dormir), `${procesados.length} procesados`);

  const { rows: [estado] } = await ojo.query(`select processed_at from webhook_events where id = $1`, [fila.id]);
  comprobar('lo marca procesado en la base', estado?.processed_at != null);

  // Limpieza: la fila de prueba.
  await ojo.query(`delete from webhook_events where id = $1`, [fila.id]);

  await app.close();
  await ojo.end();

  const bien = resultados.every(Boolean) && seCayo === null;
  console.log(`\n${bien ? 'TODO BIEN' : 'HAY FALLAS'}: ${resultados.filter(Boolean).length} de ${resultados.length}\n`);
  process.exit(bien ? 0 : 1);
}

main().catch((e) => {
  console.error('la prueba se rompio:', e);
  process.exit(1);
});
