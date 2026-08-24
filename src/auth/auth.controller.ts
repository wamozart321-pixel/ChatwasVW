import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AsesorActual } from './asesor.decorator';
import { AuthGuard } from './auth.guard';
import { AuthService, type Asesor } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: { email?: string; clave?: string }) {
    if (!body?.email || !body?.clave) throw new BadRequestException('email y clave requeridos');
    return this.auth.login(body.email, body.clave);
  }

  /** El front lo usa al arrancar para saber si la sesión guardada sigue viva. */
  @Get('yo')
  @UseGuards(AuthGuard)
  yo(@AsesorActual() asesor: Asesor) {
    return asesor;
  }

  @Get('asesores')
  @UseGuards(AuthGuard)
  asesores() {
    return this.auth.listar();
  }
}
