import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Asesor } from './auth.service';
import type { PedidoConAsesor } from './auth.guard';

/** Inyecta el asesor autenticado: quien hace cada acción queda registrado. */
export const AsesorActual = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Asesor =>
    ctx.switchToHttp().getRequest<PedidoConAsesor>().asesor,
);
