import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { GraphError } from './graph.service';

/**
 * Traduce los rechazos de Meta a algo que le sirva al asesor.
 *
 * Sin esto, cualquier error de la Cloud API sale como "Internal server error":
 * el mensaje queda marcado como fallido en el hilo con el motivo real, pero el
 * cartel de arriba dice que se rompio el servidor, que es a la vez alarmante y
 * falso. La causa casi nunca esta de nuestro lado.
 */

/** Los codigos que se ven de verdad, en criollo. */
const EXPLICACIONES: Record<number, string> = {
  131030:
    'El numero no esta en la lista de destinatarios permitidos. Mientras uses el numero de prueba de Meta, solo se le puede escribir a los numeros cargados en esa lista.',
  131047:
    'Pasaron mas de 24 horas desde el ultimo mensaje del cliente. Solo se puede enviar una plantilla aprobada.',
  131026:
    'El numero no tiene WhatsApp, o no puede recibir mensajes. Verifica que este bien escrito y con el indicativo del pais.',
  131031: 'La cuenta de WhatsApp del negocio esta restringida o suspendida por Meta.',
  132000: 'La plantilla no coincide con lo aprobado: faltan o sobran variables.',
  132001: 'Esa plantilla no existe o todavia no esta aprobada.',
  132015: 'La plantilla fue pausada por Meta, normalmente por calidad baja.',
  133010: 'El numero del negocio no esta registrado en la Cloud API.',
  368: 'Meta bloqueo temporalmente la cuenta por politicas de la plataforma.',
  80007: 'Se alcanzo el limite de envios. Espera unos minutos antes de reintentar.',
  4: 'Demasiadas llamadas seguidas a la API de Meta. Espera un momento.',
};

@Catch(GraphError)
export class GraphErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('MetaAPI');

  catch(error: GraphError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    const explicacion = error.code ? EXPLICACIONES[error.code] : undefined;

    // 502 y no 500: el que fallo fue Meta, no esta app. La diferencia importa
    // cuando alguien mira los logs buscando que se rompio.
    const estado =
      error.httpStatus >= 400 && error.httpStatus < 500
        ? HttpStatus.UNPROCESSABLE_ENTITY
        : HttpStatus.BAD_GATEWAY;

    this.log.warn(`envio rechazado [${error.code ?? '?'}] ${error.message}`);

    res.status(estado).json({
      statusCode: estado,
      error: 'meta_rechazo',
      // `mensaje` es lo que la bandeja muestra en el cartel; `message` queda
      // para que cualquier cliente generico tambien lea algo util.
      mensaje: explicacion ?? error.detalle ?? error.message,
      message: explicacion ?? error.message,
      codigo: error.code ?? null,
    });
  }
}
