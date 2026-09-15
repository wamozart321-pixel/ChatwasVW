import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import { ActividadService } from './actividad.service';
import { configPostgres } from './conexion';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
export type Database = NodePgDatabase<typeof schema>;

const pool = new Pool(configPostgres(env.DATABASE_URL, 10));

/*
 * Una conexión que la base corta no puede tumbar el proceso.
 *
 * Cuando Neon apaga el cómputo cierra las conexiones que quedaron abiertas, y pg
 * avisa con un evento 'error' en el pool. Sin nadie escuchando, Node lo trata como
 * excepción no atrapada y el servidor se cae. Hasta ahora no pasaba porque la base
 * nunca dormía; ahora duerme todas las noches, así que sin esto el servicio se
 * reiniciaría cada vez, y al reiniciar la despertaría: un bucle.
 *
 * El pool ya descarta la conexión rota por su cuenta; acá sólo se deja constancia.
 */
pool.on('error', (e) => {
  new Logger('Pool').warn(`la base cerró una conexión inactiva: ${e.message}`);
});

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useValue: pool },
    { provide: DB, useValue: drizzle(pool, { schema }) },
    ActividadService,
  ],
  exports: [DB, PG_POOL, ActividadService],
})
export class DbModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await pool.end();
  }
}
