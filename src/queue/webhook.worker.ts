import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../db/db.module';
import { InboundService } from '../whatsapp/inbound.service';
import type { WaWebhookPayload } from '../whatsapp/webhook.types';

const INTERVALO_VACIO_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const LOTE = 25;
const MAX_INTENTOS = 5;

/**
 * Clave del lock de asesor unico. Cualquier numero sirve mientras sea el mismo
 * en todas las instancias.
 */
const LOCK_WORKER = 20260822;

/** Cada cuanto reintenta tomar el lock cuando otra instancia lo tiene. */
const REINTENTO_LOCK_MS = 15_000;

/**
 * Cola sobre Postgres con FOR UPDATE SKIP LOCKED.
 * Varias instancias del server pueden correr este worker sin pisarse:
 * cada una se lleva filas distintas.
 */
@Injectable()
export class WebhookWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(WebhookWorker.name);
  private parando = false;
  private fallosSeguidos = 0;
  private bucleTerminado: Promise<void> = Promise.resolve();
  /** Conexion dedicada: un advisory lock vive mientras viva su sesion. */
  private conexionLock: PoolClient | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly inbound: InboundService,
  ) {}

  onModuleInit() {
    this.bucleTerminado = this.bucle();
    this.log.log('worker de webhooks iniciado');
  }

  async onApplicationShutdown() {
    this.parando = true;
    await this.bucleTerminado;

    // Soltar el lock explicitamente acelera el relevo de otra instancia.
    if (this.conexionLock) {
      await this.conexionLock
        .query('SELECT pg_advisory_unlock($1)', [LOCK_WORKER])
        .catch(() => undefined);
      this.conexionLock.release();
      this.conexionLock = null;
    }
  }

  /**
   * Un solo worker a la vez, garantizado por la base.
   *
   * Con SKIP LOCKED varias instancias podrian repartirse la cola sin pisarse,
   * pero en esta app no sirve: la presencia de los asesores y el estado del bot
   * viven en la memoria del proceso, asi que la instancia que procesa un mensaje
   * TIENE que ser la que tiene los sockets abiertos. Si no, reparte a gente que
   * no esta conectada y saltea pasos del bot, en silencio y de forma aleatoria.
   *
   * El advisory lock se suelta solo si el proceso muere, asi que otra instancia
   * lo toma sin intervencion.
   */
  private async tomarLock(): Promise<boolean> {
    if (!this.conexionLock) this.conexionLock = await this.pool.connect();

    const { rows } = await this.conexionLock.query<{ tomado: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS tomado',
      [LOCK_WORKER],
    );

    return rows[0]?.tomado === true;
  }

  private async bucle(): Promise<void> {
    // Esperar el lock antes de tocar la cola.
    let aviso = false;
    while (!this.parando) {
      try {
        if (await this.tomarLock()) break;
      } catch (e) {
        this.log.error(`no se pudo pedir el lock: ${(e as Error).message}`);
      }

      if (!aviso) {
        aviso = true;
        this.log.warn(
          'otra instancia ya esta procesando la cola de webhooks. Esta se queda ' +
            'a la espera: dos workers sobre la misma base se roban los mensajes ' +
            'entre si y el ruteo y el bot dejan de funcionar. Si no es a proposito, ' +
            'apaga la otra instancia.',
        );
      }

      await this.dormir(REINTENTO_LOCK_MS);
    }

    if (this.parando) return;
    if (aviso) this.log.log('lock obtenido: esta instancia toma la cola');

    while (!this.parando) {
      let hizoAlgo = false;

      try {
        for (let i = 0; i < LOTE && !this.parando; i++) {
          if (!(await this.procesarUno())) break;
          hizoAlgo = true;
        }
        if (this.fallosSeguidos > 0) {
          this.log.log(`conexion recuperada tras ${this.fallosSeguidos} fallos`);
          this.fallosSeguidos = 0;
        }
      } catch (e) {
        // Casi siempre es la base caida. Con backoff para no inundar log ni red.
        this.fallosSeguidos++;
        const espera = Math.min(
          INTERVALO_VACIO_MS * 2 ** this.fallosSeguidos,
          BACKOFF_MAX_MS,
        );
        // Se loguea el primero y luego uno de cada diez: el resto es ruido.
        if (this.fallosSeguidos === 1 || this.fallosSeguidos % 10 === 0) {
          this.log.error(
            `bucle sin base (fallo ${this.fallosSeguidos}, reintento en ${espera}ms): ` +
              `${(e as Error).message}`,
          );
        }
        await this.dormir(espera);
        continue;
      }

      if (!hizoAlgo) await this.dormir(INTERVALO_VACIO_MS);
    }
  }

  /** @returns true si habia una fila para procesar (con exito o no). */
  private async procesarUno(): Promise<boolean> {
    const cliente = await this.pool.connect();
    let id: number | null = null;

    try {
      await cliente.query('BEGIN');

      const { rows } = await cliente.query<{ id: string; payload: WaWebhookPayload }>(
        `SELECT id, payload
           FROM webhook_events
          WHERE processed_at IS NULL
            AND attempts < $1
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [MAX_INTENTOS],
      );

      if (rows.length === 0) {
        await cliente.query('COMMIT');
        return false;
      }

      id = Number(rows[0].id);

      // El procesamiento corre en otra conexion (this.inbound usa el pool).
      // Si el COMMIT de abajo se cayera, la fila se reintenta: no pasa nada,
      // porque el UNIQUE de wa_message_id hace idempotente todo el proceso.
      await this.inbound.procesar(rows[0].payload);

      await cliente.query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [id]);
      await cliente.query('COMMIT');
      return true;
    } catch (e) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      const mensaje = (e as Error).message ?? String(e);

      if (id !== null) {
        await this.pool
          .query(
            `UPDATE webhook_events
                SET attempts = attempts + 1, last_error = $2
              WHERE id = $1`,
            [id, mensaje.slice(0, 1000)],
          )
          .catch(() => undefined);
        this.log.error(`webhook_event ${id} fallo: ${mensaje}`);
      } else {
        this.log.error(`no se pudo reclamar trabajo: ${mensaje}`);
        await this.dormir(INTERVALO_VACIO_MS);
      }
      return true;
    } finally {
      cliente.release();
    }
  }

  private dormir(ms: number): Promise<void> {
    return new Promise((resolver) => {
      // unref: un timer en espera no debe impedir que el proceso cierre.
      setTimeout(resolver, ms).unref?.();
    });
  }
}
