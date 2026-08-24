import { Global, Module } from '@nestjs/common';
import { AsignacionModule } from '../asignacion/asignacion.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { BotService } from './bot.service';

/**
 * Global, igual que MediaModule: el bot necesita GraphService (de WhatsappModule)
 * y a la vez InboundService lo necesita a el. Declararlo global rompe el ciclo
 * sin forwardRef, que es mas fragil de mantener.
 */
@Global()
@Module({
  imports: [AsignacionModule, WhatsappModule],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
