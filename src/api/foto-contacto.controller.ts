import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { AuthGuard } from '../auth/auth.guard';
import { DB, type Database } from '../db/db.module';
import { contacts, messages } from '../db/schema';
import { AlmacenService } from '../media/almacen.service';

const MIME_POR_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const extension = (ruta: string) => ruta.split('.').pop()?.toLowerCase() ?? '';

/**
 * La foto de un contacto, puesta por el equipo.
 *
 * NO es la foto de perfil de WhatsApp: esa no se puede leer. La Cloud API no la
 * expone, y la única vía que la tiene —una sesión de WhatsApp Web— necesita que
 * el número esté registrado en la app normal, cosa que deja de ser cierta en
 * cuanto se migra a la API. Los dos sistemas se excluyen, así que no es algo que
 * se pueda rodear con más trabajo.
 *
 * Para el cliente de siempre resuelve lo mismo: reconocerlo de un vistazo. Y
 * para el negocio incluso mejor, porque se le puede poner la foto del carro.
 */
@Controller('api')
@UseGuards(AuthGuard)
export class FotoContactoController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly almacen: AlmacenService,
  ) {}

  /** Tipos que un navegador dibuja sin más. */
  private esImagen(mime: string | null | undefined): boolean {
    return /^image\/(jpeg|png|webp|gif)$/i.test(mime ?? '');
  }

  private async guardarRuta(contactId: string, ruta: string | null) {
    const [fila] = await this.db
      .update(contacts)
      .set({ fotoUrl: ruta })
      .where(eq(contacts.id, contactId))
      .returning({ id: contacts.id, fotoUrl: contacts.fotoUrl });

    if (!fila) throw new NotFoundException('el contacto no existe');
    return { ok: true, tieneFoto: fila.fotoUrl != null };
  }

  @Post('contactos/:id/foto')
  @UseInterceptors(FileInterceptor('archivo'))
  async subir(@Param('id') id: string, @UploadedFile() archivo: Express.Multer.File | undefined) {
    if (!archivo) throw new BadRequestException('falta el archivo');
    if (!this.esImagen(archivo.mimetype)) {
      throw new BadRequestException('tiene que ser una imagen (jpg, png, webp o gif)');
    }

    // Cinco megas de sobra para una foto de perfil, y evita que alguien suba
    // una imagen de camara entera para mostrarla a 32 px.
    if (archivo.size > 5 * 1024 * 1024) {
      throw new BadRequestException('la foto no puede pasar de 5 MB');
    }

    const ruta = await this.almacen.guardar(
      archivo.buffer,
      archivo.mimetype,
      archivo.originalname,
    );

    return this.guardarRuta(id, ruta);
  }

  /**
   * Usa como foto una imagen que ya está en la conversación.
   *
   * Es la vía cómoda: el cliente manda una foto y se la pone de perfil sin
   * bajarla y volverla a subir. Apunta al MISMO archivo del almacén, no a una
   * copia — si el mensaje se elimina de la bandeja el archivo sigue en disco,
   * que es lo que hace que la foto no se rompa.
   */
  @Post('contactos/:id/foto-de-mensaje')
  async desdeMensaje(@Param('id') id: string, @Body() body: { messageId?: string }) {
    if (!body?.messageId) throw new BadRequestException('falta el mensaje');

    const [mensaje] = await this.db
      .select({ mediaUrl: messages.mediaUrl, mediaMime: messages.mediaMime })
      .from(messages)
      .where(eq(messages.id, body.messageId))
      .limit(1);

    if (!mensaje?.mediaUrl) throw new NotFoundException('ese mensaje no tiene imagen');
    if (!this.esImagen(mensaje.mediaMime)) {
      throw new BadRequestException('ese mensaje no es una imagen');
    }

    return this.guardarRuta(id, mensaje.mediaUrl);
  }

  @Delete('contactos/:id/foto')
  quitar(@Param('id') id: string) {
    return this.guardarRuta(id, null);
  }

  /**
   * Sirve la foto.
   *
   * Con token como el resto de los archivos: son fotos de clientes y no pueden
   * quedar accesibles con adivinar la URL.
   */
  @Get('contactos/:id/foto')
  @Header('Cache-Control', 'private, max-age=300')
  async ver(@Param('id') id: string, @Res() res: Response) {
    const [fila] = await this.db
      .select({ fotoUrl: contacts.fotoUrl })
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);

    if (!fila?.fotoUrl) throw new NotFoundException('el contacto no tiene foto');

    const flujo = this.almacen.leer(fila.fotoUrl);
    if (!flujo) throw new NotFoundException('la foto ya no está en el servidor');

    // El tipo sale de la extension con que quedo guardada, no fijo: un png
    // servido como jpeg lo dibujan casi todos los navegadores, pero un webp o
    // un gif animado no, y la foto saldria rota.
    res.setHeader('Content-Type', MIME_POR_EXTENSION[extension(fila.fotoUrl)] ?? 'image/jpeg');
    flujo.pipe(res);
  }
}
