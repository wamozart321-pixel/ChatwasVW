import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AsesorActual } from '../auth/asesor.decorator';
import { AuthGuard } from '../auth/auth.guard';
import type { Asesor } from '../auth/auth.service';
import { AdminService } from './admin.service';

/**
 * Administración de usuarios. Sólo para el rol `admin`.
 *
 * Va aparte de la bandeja a propósito: crear gente y cambiar claves no es algo
 * que un asesor deba tener siquiera a la vista. El orden de los guards importa
 * —AuthGuard resuelve la sesión y AdminGuard la revisa— y Nest los ejecuta en
 * el orden en que se declaran.
 */
@Controller('api/admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('usuarios')
  listar() {
    return this.admin.listar();
  }

  @Post('usuarios')
  crear(@Body() body: { nombre?: string; email?: string; clave?: string; rol?: string }) {
    return this.admin.crear(body);
  }

  @Post('usuarios/:id/clave')
  clave(@Param('id') id: string, @Body() body: { clave?: string }) {
    return this.admin.cambiarClave(id, body?.clave ?? '');
  }

  @Post('usuarios/:id/rol')
  rol(@Param('id') id: string, @Body() body: { rol?: string }, @AsesorActual() quien: Asesor) {
    return this.admin.cambiarRol(id, body?.rol ?? '', quien);
  }

  @Post('usuarios/:id/estado')
  estado(
    @Param('id') id: string,
    @Body() body: { activo?: boolean },
    @AsesorActual() quien: Asesor,
  ) {
    return this.admin.cambiarEstado(id, body?.activo === true, quien);
  }
}
