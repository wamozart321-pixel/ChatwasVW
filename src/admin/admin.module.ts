import { Module } from '@nestjs/common';
import { AsignacionModule } from '../asignacion/asignacion.module';
import { AdminGuard } from '../auth/admin.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AsignacionModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
