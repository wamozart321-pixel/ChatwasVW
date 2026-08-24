import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { users } from '../db/schema';
import { verificar } from './password';

export interface Asesor {
  id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'supervisor' | 'asesor';
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, clave: string) {
    const [usuario] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);

    // Se verifica siempre, incluso sin usuario: verificar() hashea igual para
    // no filtrar por tiempo si el email existe o no.
    const valida = await verificar(clave, usuario?.passwordHash ?? null);

    if (!valida || !usuario?.activo) {
      this.log.warn(`login rechazado para ${email}`);
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    await this.db
      .update(users)
      .set({ ultimaConexion: sql`clock_timestamp()` })
      .where(eq(users.id, usuario.id));

    const asesor: Asesor = {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: usuario.rol,
    };

    return { token: await this.jwt.signAsync(asesor), asesor };
  }

  /** Valida el token y confirma que el asesor siga activo. */
  async desdeToken(token: string): Promise<Asesor> {
    let datos: Asesor;
    try {
      datos = await this.jwt.verifyAsync<Asesor>(token);
    } catch {
      throw new UnauthorizedException('sesión inválida o vencida');
    }

    const [usuario] = await this.db
      .select({ id: users.id, nombre: users.nombre, email: users.email, rol: users.rol, activo: users.activo })
      .from(users)
      .where(eq(users.id, datos.id))
      .limit(1);

    if (!usuario?.activo) throw new UnauthorizedException('asesor inactivo');

    return { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol };
  }

  listar() {
    return this.db
      .select({
        id: users.id,
        nombre: users.nombre,
        email: users.email,
        rol: users.rol,
        activo: users.activo,
      })
      .from(users)
      .where(eq(users.activo, true))
      .orderBy(users.nombre);
  }
}
