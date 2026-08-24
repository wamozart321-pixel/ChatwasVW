import { Inject, Injectable } from '@nestjs/common';
import { DB, type Database } from '../db/db.module';
import { webhookEvents } from '../db/schema';

/**
 * Encolar = un solo INSERT. Debe ser lo mas rapido posible: Meta corta a los
 * 5 segundos y si el endpoint falla seguido, desactiva el webhook.
 */
@Injectable()
export class WebhookQueueService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async encolar(payload: Record<string, unknown>): Promise<number> {
    const [fila] = await this.db
      .insert(webhookEvents)
      .values({ payload })
      .returning({ id: webhookEvents.id });

    return fila.id;
  }
}
