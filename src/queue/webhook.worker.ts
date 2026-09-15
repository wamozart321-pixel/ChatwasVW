import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ActividadService } from '../db/actividad.service';
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
 * Cada cuanto se mira la cola aunque no haya pasado nada.
 *
 * Con todo quieto el worker no pregunta: espera a que un webhook lo despierte.
 * Esto es la red de seguridad para lo que no avisa —un evento que fallo y quedo
 * para reintentar—, y es largo a proposito: cada vuelta despierta la base cinco
 * minutos, y cuatro por dia son veinte minutos de computo, no veinticuatro horas.
 */
const BARRIDO_MS = 6 * 60 * 60 * 1000;

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
  /** Si el lock sigue en pie. Se cae cada vez que Neon duerme la base. */
  private tieneLock = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly inbound: InboundService,
    private readonly actividad: ActividadService,
  ) {}

  onModuleInit() {
    this.bucleTerminado = this.bucle();
    this.log.log('worker de webhooks iniciado');
  }

  async onApplicationShutdown() {
    this.parando = true;
    await this.bucleTerminado;

    // Soltar el lock explicitamente acelera el relevo de otra instancia.
    if (this.conexionLock && this.tieneLock) {
      await this.conexionLock
        .query('SELECT pg_advisory_unlock($1)', [LOCK_WORKER])
        .catch(() => undefined);
    }
    this.soltarConexionLock();
  }

  /**
   * Descarta la conexion del lock.
   *
   * `release(true)` la destruye en lugar de devolverla al pool: una conexion que la
   * base corto no sirve para nada, y devuelta al pool la recibiria la proxima
   * consulta, que fallaria sin motivo aparente.
   */
  private soltarConexionLock(error?: Error) {
    const cliente = this.conexionLock;
    this.conexionLock = null;
    this.tieneLock = false;

    try {
      cliente?.release(error ?? true);
    } catch {
      // Ya estaba liberada: pasa si se corto y ademas se apago el proceso.
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
    if (!this.conexionLock) {
      const cliente = await this.pool.connect();

      /*
       * El lock se pierde cada noche, y hay que enterarse.
       *
       * Cuando Neon duerme la base cierra esta conexion, y el advisory lock muere
       * con ella. Sin escuchar el corte, el worker seguiria creyendo que lo tiene;
       * y sin un 'error' atendido en un cliente sacado del pool, Node lo toma como
       * excepcion no atrapada y tumba el servidor.
       */
      const alCortarse = (e?: Error) => {
        if (this.conexionLock !== cliente) return;
        const detalle = e ? ': ' + e.message : '';
        this.log.log('la base cerro la conexion del lock' + detalle + '; se toma de nuevo al volver');
        this.soltarConexionLock(e);
      };
      cliente.on('error', alCortarse);
      cliente.on('end', () => alCortarse());

      this.conexionLock = cliente;
    }

    const { rows } = await this.conexionLock.query<{ tomado: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS tomado',
      [LOCK_WORKER],
    );

    this.tieneLock = rows[0]?.tomado === true;
    return this.tieneLock;
  }

  private async bucle(): Promise<void> {
    let aviso = false;

    while (!this.parando) {
      /*
       * El lock antes de tocar la cola, y no solo al arrancar.
       *
       * Antes se tomaba una vez y duraba lo que durara el proceso, porque la base
       * nunca dormia. Ahora se pierde cada vez que Neon la apaga, asi que se
       * vuelve a pedir en la primera vuelta despues de despertar.
       */
      if (!this.tieneLock) {
        let tomado = false;

        try {
          tomado = await this.tomarLock();
        } catch (e) {
          this.log.error(`no se pudo pedir el lock: ${(e as Error).message}`);
          this.soltarConexionLock(e as Error);
          await this.dormir(REINTENTO_LOCK_MS);
          continue;
        }

        if (!tomado) {
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
          continue;
        }

        if (aviso) {
          this.log.log('lock obtenido: esta instancia toma la cola');
          aviso = false;
        }
      }

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

      if (hizoAlgo) {
        // Procesar un mensaje es actividad: puede haber dejado una conversacion
        // asignada, y el rescate tiene que seguir mirando.
        this.actividad.marcar();
        continue;
      }

      /*
       * Nada en la cola.
       *
       * Con actividad reciente se vuelve a mirar en medio segundo, como siempre: es
       * horario de trabajo y un webhook que falla tiene que reintentarse rapido.
       * Pasada la ventana se deja de preguntar y se espera a que alguien encole —el
       * aviso llega en memoria, sin tocar la base—. Esa es toda la diferencia entre
       * una base prendida las 24 horas y una que duerme de noche.
       */
      if (this.actividad.reciente()) await this.dormir(INTERVALO_VACIO_MS);
      else await this.actividad.esperar(BARRIDO_MS);
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
