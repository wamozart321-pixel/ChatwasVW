import { Module } from '@nestjs/common';
import { AsignacionModule } from '../asignacion/asignacion.module';
import { OperacionModule } from '../operacion/operacion.module';
import { PlantillasModule } from '../plantillas/plantillas.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { BandejaController } from './bandeja.controller';
import { MediaController } from './media.controller';
import { OperacionController } from './operacion.controller';
import { PlantillasController } from './plantillas.controller';
import { GeocodificarService } from '../messages/geocodificar.service';
import { BandejaService } from './bandeja.service';

@Module({
  imports: [AsignacionModule, OperacionModule, PlantillasModule, WhatsappModule],
  controllers: [BandejaController, MediaController, OperacionController, PlantillasController],
  providers: [BandejaService, GeocodificarService],
})
export class ApiModule {}
