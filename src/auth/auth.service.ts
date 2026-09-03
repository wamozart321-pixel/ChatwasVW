import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { sessions, users } from '../db/schema';
import { nombreDeDispositivo, tipoDeDispositivo } from './dispositivo';
import { verificar } from './password';

export interface Asesor {
  id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'supervisor' | 'asesor';
}

/** Lo que viaja firmado en el token. */
interface Credencial extends Asesor {
  /** Id de la sesion. Sin esto no se puede cerrar una sola: el token es eterno. */
  sid: string;
}

/**
 * Cada cuanto se anota que la sesion sigue viva.
 *
 * Escribir en cada pedido serian cientos de UPDATE por minuto para un dato que
 * solo se mira al listar las sesiones. Cinco minutos alcanza para saber cual se
 * uso hace poco y cual quedo olvidada.
 */
const REFRESCO_ACTIVIDAD_MS = 5 * 60 * 1000;

/** Que se le dice al asesor segun por que se le cerro la sesion. */
const MENSAJE_CIERRE: Record<string, string> = {
  otro_dispositivo: 'Entraste desde otro dispositivo del mismo tipo, así que esta sesión se cerró.',
  clave_cambiada: 'Se cambió la contraseña de tu cuenta. Entrá de nuevo.',
  salio: 'Cerraste la sesión.',
};

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, clave: string, userAgent?: string) {
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

    const tipo = tipoDeDispositivo(userAgent);

    // La de antes del mismo tipo se cierra: dos ranuras por asesor, el celular
    // y la computadora. El indice unico parcial de la tabla no dejaria dos
    // vivas del mismo tipo aunque este UPDATE fallara.
    await this.db
      .update(sessions)
      .set({ revocadaEn: sql`clock_timestamp()`, motivo: 'otro_dispositivo' })
      .where(
        and(
          eq(sessions.userId, usuario.id),
          eq(sessions.tipo, tipo),
          isNull(sessions.revocadaEn),
        ),
      );

    const [sesion] = await this.db
      .insert(sessions)
      .values({ userId: usuario.id, tipo, dispositivo: nombreDeDispositivo(userAgent) })
      .returning({ id: sessions.id });

    const credencial: Credencial = { ...asesor, sid: sesion.id };

    return { token: await this.jwt.signAsync(credencial), asesor };
  }

  /**
   * Cierra la sesion del token que se manda.
   *
   * El guard ya lo valido, asi que aca solo hay que sacarle el `sid`: es mas
   * simple que arrastrarlo por el request hasta el controlador.
   */
  async salirConToken(token: string) {
    const { sid } = await this.jwt.verifyAsync<Credencial>(token);
    return this.salir(sid);
  }

  /** Cierra la sesion con la que se esta pidiendo. */
  async salir(sid: string) {
    await this.db
      .update(sessions)
      .set({ revocadaEn: sql`clock_timestamp()`, motivo: 'salio' })
      .where(and(eq(sessions.id, sid), isNull(sessions.revocadaEn)));

    return { ok: true };
  }

  /**
   * Cierra TODAS las de un asesor.
   *
   * Lo usa el cambio de clave: sin esto, cambiarle la contraseña a alguien que
   * se va del negocio no lo desconecta — su token sigue valiendo hasta que se
   * vence, que puede ser medio dia despues.
   */
  async cerrarTodas(userId: string, motivo: string) {
    await this.db
      .update(sessions)
      .set({ revocadaEn: sql`clock_timestamp()`, motivo })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revocadaEn)));
  }

  /** Valida el token, la sesion y que el asesor siga activo. */
  async desdeToken(token: string): Promise<Asesor> {
    let datos: Credencial;
    try {
      datos = await this.jwt.verifyAsync<Credencial>(token);
    } catch {
      throw new UnauthorizedException('sesión inválida o vencida');
    }

    // Un token de antes de que existieran las sesiones. No se puede saber de
    // que aparato salio, asi que se pide entrar de nuevo: pasa una sola vez,
    // el dia que se despliega esto.
    if (!datos.sid) throw new UnauthorizedException('sesión inválida o vencida');

    // Todo junto: el asesor y su sesion. Aparte serian dos consultas por cada
    // pedido de la bandeja, que son muchos.
    const [fila] = await this.db
      .select({
        id: users.id,
        nombre: users.nombre,
        email: users.email,
        rol: users.rol,
        activo: users.activo,
        revocadaEn: sessions.revocadaEn,
        motivo: sessions.motivo,
        ultimaActividad: sessions.ultimaActividad,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, datos.sid))
      .limit(1);

    if (!fila) throw new UnauthorizedException('sesión inválida o vencida');
    if (!fila.activo) throw new UnauthorizedException('asesor inactivo');

    if (fila.revocadaEn) {
      // El motivo viaja al front para poder decir por que se cerro, en vez de
      // un «sesion invalida» que deja al asesor sin entender que paso.
      throw new UnauthorizedException({
        error: 'sesion_cerrada',
        motivo: fila.motivo ?? 'cerrada',
        mensaje: MENSAJE_CIERRE[fila.motivo ?? ''] ?? 'La sesión se cerró. Entrá de nuevo.',
      });
    }

    // Cada tanto, no en cada pedido.
    const desde = Date.now() - new Date(fila.ultimaActividad).getTime();
    if (desde > REFRESCO_ACTIVIDAD_MS) {
      await this.db
        .update(sessions)
        .set({ ultimaActividad: sql`clock_timestamp()` })
        .where(eq(sessions.id, datos.sid));
    }

    return { id: fila.id, nombre: fila.nombre, email: fila.email, rol: fila.rol };
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
