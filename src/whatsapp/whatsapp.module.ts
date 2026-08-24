import { Module } from '@nestjs/common';
import { AsignacionModule } from '../asignacion/asignacion.module';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { OutboundService } from '../messages/outbound.service';
import { WebhookQueueService } from '../queue/webhook-queue.service';
import { WebhookWorker } from '../queue/webhook.worker';
import { GraphService } from './graph.service';
import { InboundService } from './inbound.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [AsignacionModule],
  controllers: [WebhookController],
  providers: [
    GraphService,
    InboundService,
    ConversationsService,
    MessagesService,
    OutboundService,
    WebhookQueueService,
    WebhookWorker,
  ],
  exports: [GraphService, OutboundService, ConversationsService, MessagesService],
})
export class WhatsappModule {}
