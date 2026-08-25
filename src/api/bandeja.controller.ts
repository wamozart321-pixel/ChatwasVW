import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AsignacionService } from '../asignacion/asignacion.service';
import { env } from '../config/env';
import { AsesorActual } from '../auth/asesor.decorator';
import { coordenadasDe, esEnlaceCorto, resolverEnlaceCorto } from '../messages/ubicacion';
import { AuthGuard } from '../auth/auth.guard';
import type { Asesor } from '../auth/auth.service';
import { OutboundService } from '../messages/outbound.service';
import { BandejaService } from './bandeja.service';

@Controller('api')
@UseGuards(AuthGuard)
export class BandejaController {
  constructor(
    private readonly bandeja: BandejaService,
    private readonly saliente: OutboundService,
    private readonly asignacion: AsignacionService,
  ) {}

  @Get('conversaciones')
  listar(
    @AsesorActual() asesor: Asesor,
    @Query('estado') estado?: string,
    @Query('q') q?: string,
    @Query('asignado') asignado?: string,
    @Query('etiqueta') etiqueta?: string,
  ) {
    return this.bandeja.listar({
      estado,
      busqueda: q,
      asignado,
      etiqueta,
      asesorId: asesor.id,
    });
  }

  @Get('conversaciones/:id')
  detalle(@Param('id') id: string) {
    return this.bandeja.detalle(id);
  }

  @Get('conversaciones/:id/mensajes')
  hilo(@Param('id') id: string, @Query('antesDe') antesDe?: string) {
    return this.bandeja.hilo(id, antesDe);
  }

  /**
   * Enviar toma la conversación si estaba libre: en la práctica un asesor
   * responde y con eso queda claro que es suya, sin un clic extra.
   */
  @Post('conversaciones/:id/mensajes')
  async enviar(
    @Param('id') id: string,
    @Body() body: { texto: string },
    @AsesorActual() asesor: Asesor,
  ) {
    const conv = await this.bandeja.detalle(id);

    if (!conv.asignadoId) {
      await this.asignacion.tomar(id, asesor).catch(() => undefined);
    }

    return this.saliente.enviarTexto({
      a: conv.telefono,
      texto: body?.texto ?? '',
      userId: asesor.id,
    });
  }

  /**
   * Saca un mensaje de la bandeja. Ojo: no lo borra del telefono del cliente,
   * la Cloud API no lo permite.
   */
  @Delete('mensajes/:messageId')
  eliminarMensaje(@Param('messageId') messageId: string, @AsesorActual() asesor: Asesor) {
    return this.bandeja.eliminarMensaje(messageId, asesor);
  }

  @Post('conversaciones/:id/leida')
  leida(@Param('id') id: string) {
    return this.bandeja.marcarLeida(id);
  }

  @Post('conversaciones/:id/estado')
  estado(
    @Param('id') id: string,
    @Body() body: { estado: 'abierto' | 'pendiente' | 'resuelto' },
    @AsesorActual() asesor: Asesor,
  ) {
    return this.bandeja.cambiarEstado(id, body.estado, asesor.id);
  }

  // --- asignación ----------------------------------------------------------

  @Post('conversaciones/:id/tomar')
  tomar(@Param('id') id: string, @AsesorActual() asesor: Asesor) {
    return this.asignacion.tomar(id, asesor);
  }

  @Post('conversaciones/:id/soltar')
  soltar(@Param('id') id: string, @AsesorActual() asesor: Asesor) {
    return this.asignacion.soltar(id, asesor);
  }

  @Post('conversaciones/:id/asignar')
  asignar(
    @Param('id') id: string,
    @Body() body: { asesorId: string },
    @AsesorActual() asesor: Asesor,
  ) {
    return this.asignacion.asignar(id, body.asesorId, asesor);
  }

  @Get('equipo')
  equipo() {
    return this.asignacion.cargaDelEquipo();
  }

  /**
   * Config que el front necesita conocer.
   * Duplicar el tope de archivo en el cliente lleva a que un dia no coincidan y
   * el asesor descubra el limite recien cuando el envio falla.
   */
  @Get('config')
  config() {
    return {
      maxArchivoMB: env.MEDIA_MAX_MB,
      // Si el local no tiene coordenadas cargadas, el boton de "nuestra
      // ubicacion" no se dibuja. Se manda null y no se inventa nada.
      ubicacionNegocio:
        env.NEGOCIO_LAT !== undefined && env.NEGOCIO_LON !== undefined
          ? {
              latitud: env.NEGOCIO_LAT,
              longitud: env.NEGOCIO_LON,
              nombre: env.NEGOCIO_NOMBRE,
              direccion: env.NEGOCIO_DIRECCION ?? null,
            }
          : null,
    };
  }

  /**
   * Manda una ubicacion.
   *
   * Acepta coordenadas ya resueltas o el texto crudo que pego el asesor: en la
   * practica copia el enlace desde Google Maps, y los enlaces cortos hay que
   * resolverlos aca porque Google no manda cabeceras CORS y el navegador no
   * puede seguir la redireccion.
   */
  @Post('conversaciones/:id/ubicacion')
  async ubicacion(
    @Param('id') id: string,
    @Body()
    body: {
      latitud?: number;
      longitud?: number;
      texto?: string;
      nombre?: string;
      direccion?: string;
    },
    @AsesorActual() asesor: Asesor,
  ) {
    let latitud = body?.latitud;
    let longitud = body?.longitud;

    if (latitud === undefined || longitud === undefined) {
      const texto = body?.texto ?? '';
      const punto = esEnlaceCorto(texto)
        ? await resolverEnlaceCorto(texto.trim())
        : coordenadasDe(texto);

      if (!punto) {
        throw new BadRequestException(
          'No se reconocio ninguna ubicacion. Pega el enlace de Google Maps o las coordenadas.',
        );
      }

      latitud = punto.latitud;
      longitud = punto.longitud;
    }

    const conv = await this.bandeja.detalle(id);
    if (!conv.asignadoId) await this.asignacion.tomar(id, asesor).catch(() => undefined);

    return this.saliente.enviarUbicacion({
      a: conv.telefono,
      latitud,
      longitud,
      nombre: body?.nombre,
      direccion: body?.direccion,
      userId: asesor.id,
    });
  }
}
