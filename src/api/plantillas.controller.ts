import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AsesorActual } from '../auth/asesor.decorator';
import { AuthGuard } from '../auth/auth.guard';
import type { Asesor } from '../auth/auth.service';
import { OutboundService } from '../messages/outbound.service';
import { PlantillasService } from '../plantillas/plantillas.service';
import { BandejaService } from './bandeja.service';

@Controller('api/plantillas')
@UseGuards(AuthGuard)
export class PlantillasController {
  constructor(
    private readonly plantillas: PlantillasService,
    private readonly bandeja: BandejaService,
    private readonly saliente: OutboundService,
  ) {}

  @Get()
  listar() {
    return this.plantillas.listar();
  }

  /** Trae de Meta lo que haya cambiado. Es rápido: la lista es corta. */
  @Post('sincronizar')
  sincronizar() {
    return this.plantillas.sincronizar();
  }

  /**
   * Envía una plantilla. Es la única vía cuando la ventana de 24 h ya venció,
   * así que no se valida la ventana acá a propósito.
   */
  @Post(':templateId/enviar')
  async enviar(
    @Param('templateId') templateId: string,
    @Body()
    body: { conversationId: string; encabezado?: string[]; cuerpo?: string[] },
    @AsesorActual() asesor: Asesor,
  ) {
    const conv = await this.bandeja.detalle(body.conversationId);
    const valores = { encabezado: body.encabezado, cuerpo: body.cuerpo };

    const { plantilla, componentes } = await this.plantillas.componentesPara(templateId, valores);

    return this.saliente.enviarPlantilla({
      a: conv.telefono,
      nombre: plantilla.nombre,
      idioma: plantilla.idioma,
      componentes,
      userId: asesor.id,
      textoPrevio: this.plantillas.vistaPrevia(plantilla, valores),
    });
  }
}
