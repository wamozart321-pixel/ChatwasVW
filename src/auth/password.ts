import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derivar = promisify(scrypt) as (
  clave: string,
  salt: Buffer,
  largo: number,
) => Promise<Buffer>;

const LARGO = 64;

/** Devuelve 'salt:hash' en hex. scrypt es nativo: sin dependencias que compilar. */
export async function hashear(clave: string): Promise<string> {
  const salt = randomBytes(16);
  const derivada = await derivar(clave, salt, LARGO);
  return `${salt.toString('hex')}:${derivada.toString('hex')}`;
}

export async function verificar(clave: string, almacenado: string | null): Promise<boolean> {
  // Se hashea igual aunque no haya usuario, para que el tiempo de respuesta no
  // revele si el email existe.
  const valor = almacenado ?? `${'0'.repeat(32)}:${'0'.repeat(LARGO * 2)}`;

  const [saltHex, hashHex] = valor.split(':');
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const esperado = Buffer.from(hashHex, 'hex');
  if (esperado.length === 0) return false;

  const derivada = await derivar(clave, salt, esperado.length);
  const iguales = derivada.length === esperado.length && timingSafeEqual(derivada, esperado);

  return almacenado !== null && iguales;
}
