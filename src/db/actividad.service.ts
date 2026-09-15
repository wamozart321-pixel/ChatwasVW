import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

/**
 * Lleva la cuenta de cuándo la base hizo falta por última vez.
 *
 * Neon apaga el cómputo tras 5 minutos sin consultas, y se cobra —o se descuenta
 * de las 100 horas del plan gratis— sólo mientras está prendido. Pero el servidor
 * no la dejaba dormir nunca: el worker de webhooks preguntaba cada medio segundo
 * si había trabajo y dos revisiones corrían cada minuto. Llevaba 22 días prendida
 * sin parar, 24 horas por día, aunque de noche no escribe nadie.
 *
 * Esto separa "hay algo que hacer" de "preguntarle a la base si hay algo que
 * hacer". Todo lo que puede generar trabajo marca actividad acá, en memoria, sin
 * tocar la base:
 *
 *   - llega un webhook de Meta (un cliente escribió)
 *   - un asesor usa la bandeja (cualquier pedido autenticado a la API)
 *   - una revisión periódica encontró algo y lo movió
 *
 * Y todo lo periódico pregunta primero acá. Si pasó la ventana sin actividad, no
 * consulta: la base queda quieta y Neon la duerme. Cuando vuelve a pasar algo, la
 * primera consulta la despierta sola en unos cientos de milisegundos.
 *
 * La ventana no es un número suelto: tiene que cubrir la revisión más lenta. Si un
 * cliente escribe y se lo asignan a alguien, el rescate lo devuelve a la cola a los
 * RESCATE_MINUTOS; si la ventana cerrara antes, esa conversación quedaría asignada
 * a un asesor que ya se fue, hasta que otro cliente escribiera.
 */
@Injectable()
export class ActividadService {
  private readonly log = new Logger(ActividadService.name);

  /** Arrancar cuenta como actividad: puede haber trabajo pendiente de antes. */
  private ultima = Date.now();
  private dormida = false;
  private readonly esperando = new Set<() => void>();

  /** Cuánto dura la ventana después de la última actividad. */
  readonly ventanaMs =
    (Math.max(env.RESCATE_MINUTOS, env.BOT_ESPERA_MINUTOS, 5) + 5) * 60_000;

  /** Algo pasó: hay que tener la base a mano un rato. */
  marcar() {
    this.ultima = Date.now();

    if (this.dormida) {
      this.dormida = false;
      this.log.log('hay actividad: vuelvo a revisar la base');
    }

    // Despierta a quien esté esperando trabajo, en vez de hacerlo sondear.
    for (const despertar of this.esperando) despertar();
    this.esperando.clear();
  }

  /** ¿Hubo actividad dentro de la ventana? */
  reciente(): boolean {
    const hay = Date.now() - this.ultima < this.ventanaMs;

    // Se loguea sólo el cambio: una línea al quedar quieta, otra al despertar.
    if (!hay && !this.dormida) {
      this.dormida = true;
      this.log.log(
        `${Math.round(this.ventanaMs / 60_000)} min sin actividad: dejo de consultar la base ` +
          'y Neon la puede apagar',
      );
    }

    return hay;
  }

  /**
   * Espera hasta que haya actividad o pase \`ms\`, lo que llegue primero.
   *
   * Es lo que usa el worker cuando no hay nada: en lugar de preguntarle a la base
   * cada medio segundo, se queda acá hasta que un webhook lo despierte.
   */
  esperar(ms: number): Promise<void> {
    return new Promise((resolver) => {
      const listo = () => {
        clearTimeout(reloj);
        this.esperando.delete(listo);
        resolver();
      };
      const reloj = setTimeout(listo, ms);
      reloj.unref?.();
      this.esperando.add(listo);
    });
  }
}
