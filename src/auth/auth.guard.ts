import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type Asesor } from './auth.service';

/** Request con el asesor ya resuelto por el guard. */
export interface PedidoConAsesor extends Request {
  asesor: Asesor;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PedidoConAsesor>();
    const cabecera = req.header('authorization') ?? '';

    if (!cabecera.startsWith('Bearer ')) throw new UnauthorizedException('falta el token');

    req.asesor = await this.auth.desdeToken(cabecera.slice(7));
    return true;
  }
}
