import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { PedidoConAsesor } from './auth.guard';

/**
 * Sólo administradores.
 *
 * Va SIEMPRE después de AuthGuard, que es el que resuelve `req.asesor`. Si se
 * pone antes, `asesor` viene vacío y esto dejaría pasar a cualquiera; por eso
 * lanza en vez de devolver false cuando no hay asesor resuelto.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const { asesor } = ctx.switchToHttp().getRequest<PedidoConAsesor>();

    if (!asesor) throw new ForbiddenException('sin sesión');
    if (asesor.rol !== 'admin') {
      throw new ForbiddenException('esta sección es sólo para administradores');
    }

    return true;
  }
}
