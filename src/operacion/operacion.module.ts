import { Module } from '@nestjs/common';
import { OperacionService } from './operacion.service';

@Module({
  providers: [OperacionService],
  exports: [OperacionService],
})
export class OperacionModule {}
