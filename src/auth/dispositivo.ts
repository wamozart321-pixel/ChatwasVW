/**
 * De qué aparato viene una sesión, mirando el `User-Agent`.
 *
 * Sólo dos categorías, que son las dos ranuras que tiene un asesor: el celular
 * y la computadora. No interesa la marca ni la versión; interesa que entrar
 * desde el celular no le cierre la sesión de la computadora.
 */

export type TipoDispositivo = 'movil' | 'escritorio';

export function tipoDeDispositivo(userAgent: string | undefined): TipoDispositivo {
  const ua = userAgent ?? '';

  // La app de Windows es Electron, y su User-Agent tambien dice "Chrome": hay
  // que mirarla ANTES que cualquier otra cosa o cae donde no va.
  if (/Electron/i.test(ua)) return 'escritorio';

  // El .apk es un WebView de Android, asi que trae "Android" y "wv".
  if (/Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(ua)) return 'movil';

  return 'escritorio';
}

/**
 * Un nombre corto para que el asesor reconozca cuál es cuál.
 *
 * Se guarda recortado: un User-Agent entero son 200 caracteres de versiones de
 * motores de render que no le dicen nada a nadie.
 */
export function nombreDeDispositivo(userAgent: string | undefined): string {
  const ua = userAgent ?? '';

  if (/Electron/i.test(ua)) return 'App de Windows';
  if (/wv\)/i.test(ua) && /Android/i.test(ua)) return 'App de Android';
  if (/Android/i.test(ua)) return 'Navegador en Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone o iPad';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\//i.test(ua)) return 'Opera';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';

  return ua.slice(0, 60) || 'Desconocido';
}
