import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PlantillasService } from './plantillas.service';

@Module({
  imports: [WhatsappModule],
  providers: [PlantillasService],
  exports: [PlantillasService],
})
export class PlantillasModule {}
