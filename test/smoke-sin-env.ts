/**
 * Valores de relleno para que `test:smoke` corra sin `.env`.
 *
 * El smoke no usa ninguna credencial: levanta un Postgres embebido y prueba
 * funciones puras. Pero importa módulos que, de rebote, cargan
 * `src/config/env.ts`, y esa configuración corta el proceso si falta una variable.
 * En una sesión de Claude Code en la nube no hay `.env`, así que sin esto la única
 * prueba que se puede correr ahí no arrancaba.
 *
 * Tiene que importarse PRIMERO en smoke.ts, antes que cualquier módulo del
 * servidor: los require corren en el orden de los import.
 *
 * Primero se lee el `.env` si existe, y recién después se rellena lo que falte:
 * en el escritorio queda todo como estaba. Nada de esto sirve para conectarse a
 * nada; la base apunta al puerto 1 para que, si algo lo intentara, falle en el
 * acto en lugar de colgarse.
 */
try {
  process.loadEnvFile();
} catch {
  /* sin .env: es el caso para el que existe este archivo */
}

const RELLENO: Record<string, string> = {
  DATABASE_URL: 'postgres://smoke:smoke@127.0.0.1:1/smoke',
  META_PHONE_NUMBER_ID: 'smoke',
  META_ACCESS_TOKEN: 'smoke',
  META_APP_SECRET: 'smoke',
  META_WEBHOOK_VERIFY_TOKEN: 'smoke',
  JWT_SECRET: 'smoke-relleno-sin-env-de-mas-de-32-caracteres',
};

for (const [clave, valor] of Object.entries(RELLENO)) {
  process.env[clave] ??= valor;
}
