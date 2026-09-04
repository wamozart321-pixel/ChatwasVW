import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { PedidoConAsesor } from './auth.guard';

/**
 * Supervisores y administradores. Un asesor no pasa.
 *
 * Es distinto de `AdminGuard`, que sólo deja al administrador: las cuentas —
 * crearlas, borrarlas, cambiar claves y roles — son cosa del admin y de nadie
 * más. Esto es para lo de supervisar el trabajo del equipo, que sí le
 * corresponde a un supervisor: ver qué conversaciones tiene cada asesor encima.
 *
 * Va SIEMPRE después de AuthGuard, que es el que resuelve `req.asesor`. Si se
 * pone antes, `asesor` viene vacío y esto dejaría pasar a cualquiera; por eso
 * lanza en vez de devolver false cuando no hay asesor resuelto.
 */
@Injectable()
export class SupervisorGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const { asesor } = ctx.switchToHttp().getRequest<PedidoConAsesor>();

    if (!asesor) throw new ForbiddenException('sin sesión');
    if (asesor.rol !== 'admin' && asesor.rol !== 'supervisor') {
      throw new ForbiddenException('sólo un supervisor o el administrador pueden ver esto');
    }

    return true;
  }
}
