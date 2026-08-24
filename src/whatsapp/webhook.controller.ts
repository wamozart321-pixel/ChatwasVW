import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { WebhookQueueService } from '../queue/webhook-queue.service';
import { firmaValida } from './signature';

@Controller('webhooks/whatsapp')
export class WebhookController {
  private readonly log = new Logger(WebhookController.name);

  constructor(private readonly cola: WebhookQueueService) {}

  /** Handshake de verificacion. Meta lo llama una vez al guardar la URL. */
  @Get()
  verificar(@Query() q: Record<string, string>, @Res() res: Response) {
    if (
      q['hub.mode'] === 'subscribe' &&
      q['hub.verify_token'] === env.META_WEBHOOK_VERIFY_TOKEN
    ) {
      this.log.log('webhook verificado por Meta');
      // Debe devolver el challenge tal cual, en texto plano.
      res.status(200).type('text/plain').send(q['hub.challenge']);
      return;
    }

    this.log.warn('intento de verificacion con token invalido');
    throw new ForbiddenException();
  }

  /**
   * Recepcion. Regla de oro: validar firma, encolar, responder 200. Nada mas.
   * Si esto tarda mas de 5s o devuelve error de forma repetida, Meta apaga el webhook.
   */
  @Post()
  @HttpCode(200)
  async recibir(@Req() req: RawBodyRequest<Request>) {
    const crudo = req.rawBody;

    if (!crudo) {
      this.log.error('rawBody ausente: revisa NestFactory.create(..., { rawBody: true })');
      throw new UnauthorizedException();
    }

    if (!firmaValida(crudo, req.header('x-hub-signature-256'), env.META_APP_SECRET)) {
      this.log.warn('firma invalida: peticion descartada');
      throw new UnauthorizedException();
    }

    const id = await this.cola.encolar(req.body as Record<string, unknown>);
    this.log.debug(`webhook encolado #${id}`);

    return { ok: true };
  }
}
