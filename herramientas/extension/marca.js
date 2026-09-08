/**
 * Avisa al exportador que viene por la extensión y no pegado en la consola.
 *
 * La diferencia importa: por acá se arranca ANTES de que exista la página, así
 * que hay que esperar a que WhatsApp termine de cargar. Pegado en la consola
 * todo está listo desde el primer momento y esperar sería quedarse colgado.
 *
 * Va en un archivo aparte porque tiene que correr antes que WA-JS.
 */
window.__WHATSWV_EXTENSION = true;
