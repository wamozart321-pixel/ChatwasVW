import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { AsesorActual } from '../auth/asesor.decorator';
import { AuthGuard } from '../auth/auth.guard';
import type { Asesor } from '../auth/auth.service';
import { DB, type Database } from '../db/db.module';
import { messages } from '../db/schema';
import { AlmacenService } from '../media/almacen.service';
import { MediaService } from '../media/media.service';
import { OutboundService } from '../messages/outbound.service';
import { BandejaService } from './bandeja.service';

@Controller('api')
@UseGuards(AuthGuard)
export class MediaController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly almacen: AlmacenService,
    private readonly media: MediaService,
    private readonly bandeja: BandejaService,
    private readonly saliente: OutboundService,
  ) {}

  /**
   * Sirve un archivo del almacén.
   *
   * Va detrás del guard y se ubica por id de mensaje, no por ruta: son fotos y
   * documentos de clientes, no pueden quedar accesibles con sólo adivinar una URL.
   */
  @Get('media/:messageId')
  async archivo(
    @Param('messageId') messageId: string,
    @Query('descargar') descargar: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const [fila] = await this.db
      .select({
        mediaUrl: messages.mediaUrl,
        mediaMime: messages.mediaMime,
        mediaNombre: messages.mediaNombre,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!fila?.mediaUrl) throw new NotFoundException('el mensaje no tiene archivo');

    const flujo = this.almacen.leer(fila.mediaUrl);
    if (!flujo) throw new NotFoundException('el archivo ya no está en el almacén');

    const nombre = fila.mediaNombre ?? fila.mediaUrl.split('/').pop() ?? 'archivo';

    res.set({
      'Content-Type': fila.mediaMime ?? 'application/octet-stream',
      'Content-Disposition': `${descargar ? 'attachment' : 'inline'}; filename="${encodeURIComponent(nombre)}"`,
      // Privado: es contenido de un cliente, no debe quedar en caches compartidas.
      'Cache-Control': 'private, max-age=86400',
    });

    return new StreamableFile(flujo);
  }

  /** Sube un archivo y lo manda al cliente. */
  @Post('conversaciones/:id/media')
  @UseInterceptors(FileInterceptor('archivo'))
  async enviar(
    @Param('id') id: string,
    @UploadedFile() archivo: Express.Multer.File | undefined,
    @Query('caption') caption: string | undefined,
    @Query('respondeA') respondeA: string | undefined,
    @AsesorActual() asesor: Asesor,
  ) {
    if (!archivo) throw new BadRequestException('falta el archivo');

    // El tope lo pone `prepararSalida` y no este control: un video se admite
    // mas grande porque se recomprime antes de salir, y tenerlo escrito en dos
    // lados terminaba con el video rechazado aca antes de llegar a convertirse.

    const conv = await this.bandeja.detalle(id);
    const subido = await this.media.prepararSalida(archivo);

    return this.saliente.enviarMedia({
      a: conv.telefono,
      tipo: subido.tipo,
      mediaId: subido.mediaId,
      caption,
      media: {
        url: subido.ruta,
        // Los de `subido`, no los del archivo original: una nota de voz se
        // convierte a OGG antes de enviarse, y guardar el mime de entrada dejaba
        // el hilo diciendo "webm" sobre un archivo que ya era ogg.
        mime: subido.mime,
        nombre: subido.nombre,
        tamano: subido.tamano,
      },
      userId: asesor.id,
      respondeA: respondeA ?? null,
    });
  }
}
