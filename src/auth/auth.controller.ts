import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AsesorActual } from './asesor.decorator';
import { AuthGuard } from './auth.guard';
import { AuthService, type Asesor } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(
    @Body() body: { email?: string; clave?: string },
    @Headers('user-agent') userAgent?: string,
  ) {
    if (!body?.email || !body?.clave) throw new BadRequestException('email y clave requeridos');
    // El User-Agent decide en cual de las dos ranuras entra: celular o
    // computadora. Cada asesor puede tener una de cada una, no dos iguales.
    return this.auth.login(body.email, body.clave, userAgent);
  }

  /**
   * Cierra esta sesion en el servidor.
   *
   * Sin esto, salir solo borraba el token del navegador: la sesion seguia
   * contando como ocupada y el asesor no podia entrar desde otro aparato del
   * mismo tipo hasta que venciera.
   */
  @Post('salir')
  @UseGuards(AuthGuard)
  salir(@Headers('authorization') cabecera: string) {
    return this.auth.salirConToken(cabecera.slice(7));
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
