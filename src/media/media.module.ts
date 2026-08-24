import { Global, Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AlmacenService } from './almacen.service';
import { MediaService } from './media.service';

/**
 * Global porque lo usan tanto el flujo entrante (worker) como el saliente (API),
 * y no tiene sentido duplicar el servicio de disco.
 */
@Global()
@Module({
  imports: [WhatsappModule],
  providers: [AlmacenService, MediaService],
  exports: [AlmacenService, MediaService],
})
export class MediaModule {}
