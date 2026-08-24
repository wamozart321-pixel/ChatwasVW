import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import { configPostgres } from './conexion';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
export type Database = NodePgDatabase<typeof schema>;

const pool = new Pool(configPostgres(env.DATABASE_URL, 10));

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useValue: pool },
    { provide: DB, useValue: drizzle(pool, { schema }) },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await pool.end();
  }
}
