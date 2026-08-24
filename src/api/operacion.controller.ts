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
import { AsesorActual } from '../auth/asesor.decorator';
import { AuthGuard } from '../auth/auth.guard';
import type { Asesor } from '../auth/auth.service';
import { OperacionService, type CategoriaCola } from '../operacion/operacion.service';

@Controller('api')
@UseGuards(AuthGuard)
export class OperacionController {
  constructor(private readonly operacion: OperacionService) {}

  // --- notas internas ------------------------------------------------------

  @Get('conversaciones/:id/notas')
  notas(@Param('id') id: string) {
    return this.operacion.notasDe(id);
  }

  @Post('conversaciones/:id/notas')
  agregarNota(
    @Param('id') id: string,
    @Body() body: { cuerpo: string },
    @AsesorActual() asesor: Asesor,
  ) {
    return this.operacion.agregarNota(id, body?.cuerpo ?? '', asesor);
  }

  @Delete('notas/:notaId')
  borrarNota(@Param('notaId') notaId: string, @AsesorActual() asesor: Asesor) {
    return this.operacion.borrarNota(notaId, asesor);
  }

  // --- etiquetas -----------------------------------------------------------

  @Get('etiquetas')
  etiquetas() {
    return this.operacion.listarEtiquetas();
  }

  @Post('etiquetas')
  crearEtiqueta(@Body() body: { nombre: string; color?: string }) {
    return this.operacion.crearEtiqueta(body?.nombre ?? '', body?.color ?? 'slate');
  }

  @Get('conversaciones/:id/etiquetas')
  etiquetasDe(@Param('id') id: string) {
    return this.operacion.etiquetasDe(id);
  }

  @Post('conversaciones/:id/etiquetas')
  etiquetar(
    @Param('id') id: string,
    @Body() body: { tagId: string },
    @AsesorActual() asesor: Asesor,
  ) {
    return this.operacion.etiquetar(id, body.tagId, asesor);
  }

  @Delete('conversaciones/:id/etiquetas/:tagId')
  desetiquetar(@Param('id') id: string, @Param('tagId') tagId: string) {
    return this.operacion.desetiquetar(id, tagId);
  }

  // --- métricas ------------------------------------------------------------

  @Get('metricas/rendimiento')
  rendimiento(@Query('dias') dias?: string) {
    const n = Number(dias);
    return this.operacion.rendimiento(Number.isFinite(n) && n > 0 && n <= 90 ? n : 7);
  }

  @Get('metricas/resumen')
  resumen() {
    return this.operacion.resumen();
  }

  /** Las conversaciones detrás de cada número del resumen. */
  @Get('metricas/cola/:categoria')
  detalleCola(@Param('categoria') categoria: string) {
    const validas: CategoriaCola[] = [
      'sin_asignar',
      'total',
      'pendientes',
      'sin_leer',
      'sin_responder',
      'espera',
    ];

    if (!validas.includes(categoria as CategoriaCola)) {
      throw new BadRequestException(`categoría inválida. Opciones: ${validas.join(', ')}`);
    }

    return this.operacion.detalleCola(categoria as CategoriaCola);
  }
}
