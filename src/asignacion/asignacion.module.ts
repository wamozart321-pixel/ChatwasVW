import { Module } from '@nestjs/common';
import { AsignacionService } from './asignacion.service';

@Module({
  providers: [AsignacionService],
  exports: [AsignacionService],
})
export class AsignacionModule {}
