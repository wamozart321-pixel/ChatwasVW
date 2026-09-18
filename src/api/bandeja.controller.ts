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
import { ConversationsService, aE164 } from '../conversations/conversations.service';
import { GeocodificarService } from '../messages/geocodificar.service';
import { coordenadasDe, esEnlaceCorto, resolverEnlaceCorto } from '../messages/ubicacion';
import { AuthGuard } from '../auth/auth.guard';
import type { Asesor } from '../auth/auth.service';
import { OutboundService } from '../messages/outbound.service';
import { SupervisorGuard } from '../auth/supervisor.guard';
import { ReenvioService } from '../messages/reenvio.service';
import { BandejaService } from './bandeja.service';

@Controller('api')
@UseGuards(AuthGuard)
export class BandejaController {
  constructor(
    private readonly bandeja: BandejaService,
    private readonly saliente: OutboundService,
    private readonly asignacion: AsignacionService,
    private readonly geo: GeocodificarService,
    private readonly conversaciones: ConversationsService,
    private readonly reenvio: ReenvioService,
  ) {}

  @Get('conversaciones')
  listar(
    @AsesorActual() asesor: Asesor,
    @Query('estado') estado?: string,
    @Query('q') q?: string,
    @Query('asignado') asignado?: string,
    @Query('etiqueta') etiqueta?: string,
    @Query('incluir') incluir?: string,
  ) {
    return this.bandeja.listar({
      estado,
      busqueda: q,
      asignado,
      etiqueta,
      asesorId: asesor.id,
      incluir,
    });
  }

  @Get('conversaciones/:id')
  detalle(@Param('id') id: string) {
    return this.bandeja.detalle(id);
  }

  @Get('conversaciones/:id/mensajes')
  hilo(
    @Param('id') id: string,
    @Query('antesDe') antesDe?: string,
    @Query('antesId') antesId?: string,
  ) {
    return this.bandeja.hilo(id, antesDe, antesId);
  }

  /**
   * Enviar toma la conversación si estaba libre: en la práctica un asesor
   * responde y con eso queda claro que es suya, sin un clic extra.
   */
  @Post('conversaciones/:id/mensajes')
  async enviar(
    @Param('id') id: string,
    @Body() body: { texto: string; respondeA?: string },
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
      respondeA: body?.respondeA ?? null,
    });
  }

  /**
   * Manda el mismo mensaje a otra conversacion.
   *
   * No es el «reenviado» de WhatsApp —la Cloud API no lo tiene—: es un mensaje
   * nuevo con el mismo contenido, marcado de nuestro lado para que en el hilo
   * se entienda de donde salio.
   */
  @Post('mensajes/:messageId/reenviar')
  reenviar(
    @Param('messageId') messageId: string,
    @Body() body: { conversationId: string },
    @AsesorActual() asesor: Asesor,
  ) {
    if (!body?.conversationId) throw new BadRequestException('falta la conversacion de destino');
    return this.reenvio.reenviar(messageId, body.conversationId, asesor.id);
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

  /** Darle un cliente puntual a un asesor. Ver AsignacionService.asignarCliente. */
  @Post('asignacion/cliente')
  @UseGuards(SupervisorGuard)
  asignarCliente(
    @Body() body: { conversationId: string; asesorId: string },
    @AsesorActual() asesor: Asesor,
  ) {
    return this.asignacion.asignarCliente(body.conversationId, body.asesorId, asesor);
  }

  /** Repartir la cola de a varios. Ver AsignacionService.asignarDeLaCola. */
  @Post('asignacion/lote')
  @UseGuards(SupervisorGuard)
  asignarDeLaCola(
    @Body() body: { asesorId: string; cantidad: number },
    @AsesorActual() asesor: Asesor,
  ) {
    return this.asignacion.asignarDeLaCola(body.asesorId, Number(body.cantidad), asesor);
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
   * Que conversaciones tiene un asesor encima.
   *
   * Solo supervisores y admin: el numero de cada uno lo puede ver cualquiera
   * —hace falta para saber a quien pasarle un chat—, pero abrir la lista de
   * otro es supervisar su trabajo, y eso le toca a quien supervisa.
   */
  @Get('equipo/:asesorId/conversaciones')
  @UseGuards(SupervisorGuard)
  conversacionesDe(@Param('asesorId') asesorId: string) {
    return this.asignacion.conversacionesDe(asesorId);
  }

  /**
   * Config que el front necesita conocer.
   * Duplicar el tope de archivo en el cliente lleva a que un dia no coincidan y
   * el asesor descubra el limite recien cuando el envio falla.
   */
  /** Cuantas hay en cada estado, para los contadores de los filtros. */
  @Get('conteo-estados')
  conteoEstados(
    @AsesorActual() asesor: Asesor,
    @Query('asignado') asignado?: string,
    @Query('q') q?: string,
    @Query('etiqueta') etiqueta?: string,
  ) {
    return this.bandeja.conteoPorEstado({ asesor, asignado, q, etiqueta });
  }

  @Get('config')
  config() {
    return {
      maxArchivoMB: env.MEDIA_MAX_MB,
      // Un video se acepta mas grande porque se recomprime antes de salir.
      maxVideoMB: env.MEDIA_VIDEO_MAX_MB,
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

  /** Busca una direccion para el mapa del redactor. */
  @Get('direcciones')
  direcciones(@Query('q') q?: string) {
    return this.geo.buscar(q ?? '');
  }

  /**
   * De coordenadas a direccion.
   *
   * Es lo que confirma que el punto marcado en el mapa es el correcto: mover
   * un pin sin ver que calle es lleva a mandar la cuadra equivocada.
   */
  @Get('direccion-de')
  async direccionDe(@Query('lat') lat?: string, @Query('lon') lon?: string) {
    const latitud = Number(lat);
    const longitud = Number(lon);

    if (!Number.isFinite(latitud) || !Number.isFinite(longitud)) {
      throw new BadRequestException('coordenadas invalidas');
    }

    return { direccion: await this.geo.direccionDe(latitud, longitud) };
  }

  /**
   * Abre un chat con un numero que todavia no escribio.
   *
   * Ojo con lo que se puede hacer despues: si el cliente nunca escribio, la
   * ventana de 24 h esta cerrada y WhatsApp NO permite texto libre. Lo unico
   * que sale es una plantilla aprobada. Por eso se devuelve `ventanaAbierta`:
   * la bandeja lo usa para mostrar el camino correcto en vez de dejar que el
   * asesor escriba un mensaje que va a ser rechazado.
   */
  @Post('conversaciones')
  async abrirChat(@Body() body: { telefono?: string; nombre?: string }) {
    const telefono = aE164(body?.telefono ?? '', env.PREFIJO_PAIS);

    if (telefono.length < 10 || telefono.length > 15) {
      throw new BadRequestException(
        'El numero no parece valido. Escribilo con indicativo, o los 10 digitos del celular.',
      );
    }

    const contacto = await this.conversaciones.asegurarContacto(
      telefono,
      body?.nombre?.trim() || undefined,
    );
    const conversacion = await this.conversaciones.asegurarConversacion(contacto.id);

    return {
      id: conversacion.id,
      telefono,
      ventanaAbierta: this.conversaciones.ventanaAbierta(conversacion.windowExpiresAt),
    };
  }

  /**
   * Resuelve un enlace de Maps a coordenadas, sin mandar nada.
   *
   * El mapa del redactor lo usa para mover el pin a donde apunta el enlace: el
   * asesor ve el punto antes de enviarlo, en vez de mandar a ciegas.
   */
  @Post('resolver-ubicacion')
  async resolverUbicacion(@Body() body: { texto?: string }) {
    const texto = (body?.texto ?? '').trim();
    const punto = esEnlaceCorto(texto)
      ? await resolverEnlaceCorto(texto)
      : coordenadasDe(texto);

    if (!punto) {
      throw new BadRequestException('No se reconocio ninguna ubicacion en ese texto.');
    }

    return punto;
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
