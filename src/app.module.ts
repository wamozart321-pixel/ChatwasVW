import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { ApiModule } from './api/api.module';
import { AsignacionModule } from './asignacion/asignacion.module';
import { AuthModule } from './auth/auth.module';
import { BotModule } from './bot/bot.module';
import { DbModule } from './db/db.module';
import { MediaModule } from './media/media.module';
import { DevController } from './dev/dev.controller';
import { RealtimeModule } from './realtime/realtime.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [DbModule, AuthModule, RealtimeModule, AsignacionModule, BotModule, WhatsappModule, MediaModule, ApiModule, AdminModule],
  controllers: [DevController],
})
export class AppModule {}
