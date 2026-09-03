import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { AsignacionService } from '../asignacion/asignacion.service';
import type { Asesor } from '../auth/auth.service';
import { hashear, verificar } from '../auth/password';
import { DB, type Database } from '../db/db.module';
import { users } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuthService } from '../auth/auth.service';

export type Rol = 'admin' | 'supervisor' | 'asesor';
const ROLES: Rol[] = ['admin', 'supervisor', 'asesor'];

/** Corta por lo sano: una clave que se adivina no protege nada. */
const MINIMO_CLAVE = 8;

@Injectable()
export class AdminService {
  private readonly log = new Logger(AdminService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly asignacion: AsignacionService,
    private readonly realtime: RealtimeGateway,
    private readonly auth: AuthService,
  ) {}

  /** Todos, incluidos los de baja: el panel tiene que poder reactivarlos. */
  async listar() {
    const filas = await this.db
      .select({
        id: users.id,
        nombre: users.nombre,
        email: users.email,
        rol: users.rol,
        activo: users.activo,
        ultimaConexion: users.ultimaConexion,
        creado: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.nombre));

    return filas.map((u) => ({
      ...u,
      conectado: this.realtime.estaConectado(u.id),
    }));
  }

  async crear(datos: { nombre?: string; email?: string; clave?: string; rol?: string }) {
    const nombre = (datos.nombre ?? '').trim();
    const email = (datos.email ?? '').trim().toLowerCase();
    const clave = datos.clave ?? '';
    const rol = (datos.rol ?? 'asesor') as Rol;

    if (nombre.length < 2) throw new BadRequestException('el nombre es obligatorio');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('el correo no tiene un formato válido');
    }
    if (clave.length < MINIMO_CLAVE) {
      throw new BadRequestException(`la clave necesita al menos ${MINIMO_CLAVE} caracteres`);
    }
    if (!ROLES.includes(rol)) throw new BadRequestException('rol inválido');

    const [existente] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Mensaje explícito en vez del error de la restricción única: quien está
    // en el panel necesita saber que ese correo ya está tomado, no leer un
    // error de Postgres.
    if (existente) throw new ConflictException('ya hay un usuario con ese correo');

    const [fila] = await this.db
      .insert(users)
      .values({ nombre, email, rol, passwordHash: await hashear(clave) })
      .returning({ id: users.id, nombre: users.nombre, email: users.email, rol: users.rol });

    this.log.log(`usuario creado: ${email} (${rol})`);
    return fila;
  }

  async cambiarClave(id: string, clave: string) {
    if ((clave ?? '').length < MINIMO_CLAVE) {
      throw new BadRequestException(`la clave necesita al menos ${MINIMO_CLAVE} caracteres`);
    }

    const [fila] = await this.db
      .update(users)
      .set({ passwordHash: await hashear(clave), updatedAt: sql`clock_timestamp()` })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email });

    if (!fila) throw new NotFoundException('usuario inexistente');

    // Se cierran sus sesiones. Antes no: el token ya emitido seguia valiendo
    // hasta vencerse, asi que cambiarle la clave a alguien que se va del
    // negocio lo dejaba adentro medio dia mas desde el telefono que ya tenia
    // abierto. Ahora la proxima peticion suya rebota.
    await this.auth.cerrarTodas(id, 'clave_cambiada');

    this.log.log(`clave cambiada para ${fila.email}; sus sesiones se cerraron`);
    return { ok: true };
  }

  async cambiarRol(id: string, rol: string, quien: Asesor) {
    if (!ROLES.includes(rol as Rol)) throw new BadRequestException('rol inválido');

    const actual = await this.buscar(id);

    if (actual.rol === 'admin' && rol !== 'admin') {
      // Si se va el último admin, nadie puede volver a entrar a este panel y
      // el sistema queda sin forma de crear usuarios salvo por terminal.
      await this.exigirOtroAdmin(id);
    }

    await this.db
      .update(users)
      .set({ rol: rol as Rol, updatedAt: sql`clock_timestamp()` })
      .where(eq(users.id, id));

    this.log.log(`${quien.email} cambió el rol de ${actual.email}: ${actual.rol} -> ${rol}`);
    return { ok: true };
  }

  /**
   * Da de baja o reactiva.
   *
   * La baja no borra: el historial de mensajes sigue diciendo quién respondió
   * qué, y borrar el usuario dejaría esas filas sin dueño.
   */
  async cambiarEstado(id: string, activo: boolean, quien: Asesor) {
    const actual = await this.buscar(id);

    if (!activo) {
      if (id === quien.id) {
        throw new ForbiddenException('no podés darte de baja a vos mismo');
      }
      if (actual.rol === 'admin') await this.exigirOtroAdmin(id);
    }

    await this.db
      .update(users)
      .set({ activo, updatedAt: sql`clock_timestamp()` })
      .where(eq(users.id, id));

    let devueltas = 0;
    if (!activo) {
      // Sus conversaciones vuelven a la cola. Si no, quedan a nombre de alguien
      // que ya no puede entrar: el cliente escribe y nadie lo ve.
      devueltas = await this.asignacion.liberarTodasDe(id);
    }

    this.log.log(`${quien.email} ${activo ? 'reactivó' : 'dio de baja'} a ${actual.email}`);
    return { ok: true, devueltasALaCola: devueltas };
  }

  /**
   * Que se pierde si se borra este usuario.
   *
   * Todas las referencias son ON DELETE SET NULL, asi que borrarlo no rompe
   * nada — pero deja anonimo su rastro: los mensajes que envio dejan de decir
   * quien fue, y las notas pierden su autor. Antes de borrar hay que ver el
   * numero, porque despues no se puede recuperar.
   */
  async queSePierde(id: string) {
    const usuario = await this.buscar(id);

    const { rows } = await this.db.execute<{
      mensajes: number;
      notas: number;
      conversaciones: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM messages WHERE sent_by_user_id = ${id})        AS mensajes,
        (SELECT count(*)::int FROM notes WHERE user_id = ${id})                   AS notas,
        (SELECT count(*)::int FROM conversations
          WHERE assigned_to = ${id} AND estado <> 'resuelto')                     AS conversaciones
    `);

    return { ...usuario, ...rows[0] };
  }

  /**
   * Borra un usuario de verdad, no lo da de baja.
   *
   * Pide la clave de quien lo hace. No es tramite: un panel abierto en una
   * maquina sin bloquear alcanza para que cualquiera borre al equipo entero, y
   * esto no se deshace. Volver a pedir la clave corta ese camino.
   *
   * Para alguien que se fue del negocio conviene MAS la baja: conserva el
   * historial de quien atendio a cada cliente. Borrar es para una cuenta creada
   * por error.
   */
  async borrar(id: string, clave: string, quien: Asesor) {
    if (id === quien.id) throw new ForbiddenException('no podés borrarte a vos mismo');

    const usuario = await this.buscar(id);
    if (usuario.rol === 'admin') await this.exigirOtroAdmin(id);

    const [yo] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, quien.id))
      .limit(1);

    if (!(await verificar(clave ?? '', yo?.passwordHash ?? null))) {
      this.log.warn(`${quien.email} intento borrar a ${usuario.email} con la clave equivocada`);
      throw new ForbiddenException('Tu contraseña no es correcta');
    }

    // Sus conversaciones vuelven a la cola antes de que desaparezca: si no,
    // quedan sin dueño y sin nadie que se entere.
    const devueltas = await this.asignacion.liberarTodasDe(id);

    await this.db.delete(users).where(eq(users.id, id));

    this.log.warn(`${quien.email} BORRO al usuario ${usuario.email}`);
    return { ok: true, devueltasALaCola: devueltas };
  }

  private async buscar(id: string) {
    const [fila] = await this.db
      .select({ id: users.id, email: users.email, rol: users.rol, activo: users.activo })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!fila) throw new NotFoundException('usuario inexistente');
    return fila;
  }

  /** Falla si `exceptoId` es el único admin activo que queda. */
  private async exigirOtroAdmin(exceptoId: string) {
    const [fila] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(sql`${users.rol} = 'admin' AND ${users.activo} AND ${users.id} <> ${exceptoId}`);

    if ((fila?.n ?? 0) === 0) {
      throw new ConflictException(
        'es el único administrador activo: nombrá otro antes de quitarle el rol o darlo de baja',
      );
    }
  }
}
