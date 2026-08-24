import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { claveValida } from './clave';

@Injectable()
export class ClaveGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!claveValida(req.header('x-dev-key'))) {
      throw new UnauthorizedException('clave invalida');
    }
    return true;
  }
}
