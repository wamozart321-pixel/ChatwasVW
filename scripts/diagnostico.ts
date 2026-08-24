/**
 * Diagnostico completo de la conexion con Meta y la base.
 *
 *   npm run diagnostico
 *   npm run diagnostico -- <otro_waba_id>    inspecciona otra WABA
 *
 * Sirve para responder rapido "por que no llega/sale nada" sin abrir el panel.
 */
import { Pool } from 'pg';
import { configPostgres } from '../src/db/conexion';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const V = process.env.META_GRAPH_VERSION ?? 'v23.0';
const T = process.env.META_ACCESS_TOKEN ?? '';
const APP_ID = process.env.META_APP_ID ?? '';
const APP_SECRET = process.env.META_APP_SECRET ?? '';
const WABA = process.argv[2] ?? process.env.META_WABA_ID ?? '';
const PHONE = process.env.META_PHONE_NUMBER_ID ?? '';

const ok = (b: boolean) => (b ? 'OK  ' : 'MAL ');

async function graph(ruta: string, token = T) {
  const r = await fetch(`https://graph.facebook.com/${V}${ruta}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { ok: r.ok, status: r.status, j: (await r.json().catch(() => ({}))) as any };
}

async function main() {
  console.log('\n=== TOKEN ===');
  const me = await graph('/debug_token?input_token=' + T + '&access_token=' + APP_ID + '|' + APP_SECRET);
  const d = me.j?.data ?? {};
  console.log(`${ok(!!d.is_valid)} tipo ${d.type ?? '?'} · app "${d.application ?? '?'}" · expira ${d.expires_at === 0 ? 'nunca' : new Date((d.expires_at ?? 0) * 1000).toISOString()}`);
  for (const g of d.granular_scopes ?? []) {
    console.log(`     ${g.scope}: ${(g.target_ids ?? ['todas']).join(', ')}`);
  }

  console.log('\n=== NUMEROS DE LA WABA ' + WABA + ' ===');
  const p = await graph(`/${WABA}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status`);
  if (!p.ok) {
    console.log(`MAL  ${p.j?.error?.message ?? p.status}`);
  } else {
    for (const n of p.j.data ?? []) {
      const enUso = n.id === PHONE;
      console.log(`${ok(n.platform_type === 'CLOUD_API')} ${n.display_phone_number}  id=${n.id}${enUso ? '  <-- el del .env' : ''}`);
      console.log(`     nombre "${n.verified_name}" · plataforma ${n.platform_type} · calidad ${n.quality_rating} · verificacion ${n.code_verification_status}`);
    }
    if (!(p.j.data ?? []).length) console.log('     (la WABA no tiene numeros)');
  }

  console.log('\n=== REGISTRO EN CLOUD API ===');
  // Si el numero no esta registrado, cualquier envio falla con (#133010).
  const reg = await graph(`/${PHONE}?fields=platform_type,throughput,webhook_configuration`);
  if (!reg.ok) {
    console.log(`MAL  ${reg.j?.error?.message ?? reg.status}`);
  } else {
    console.log(`${ok(reg.j.platform_type === 'CLOUD_API')} plataforma ${reg.j.platform_type} · throughput ${reg.j.throughput?.level ?? '?'}`);
    console.log(`     webhook del numero: ${reg.j.webhook_configuration?.application ?? '(hereda el de la app)'}`);
  }

  console.log('\n=== WEBHOOK DE LA APP ===');
  const s = await graph(`/${APP_ID}/subscriptions`, `${APP_ID}|${APP_SECRET}`);
  const wa = s.j?.data?.find((x: any) => x.object === 'whatsapp_business_account');
  if (!wa) {
    console.log('MAL  sin suscripcion. Corre: npm run webhook:registrar -- <url>');
  } else {
    console.log(`${ok(!!wa.active)} ${wa.callback_url}`);
    console.log(`     campos: ${(wa.fields ?? []).map((f: any) => f.name).join(', ')}`);
  }

  const sub = await graph(`/${WABA}/subscribed_apps`);
  const apps = (sub.j?.data ?? []).map((a: any) => a.whatsapp_business_api_data?.name ?? '?');
  console.log(`${ok(apps.length > 0)} apps suscritas a la WABA: ${apps.join(', ') || 'ninguna'}`);

  console.log('\n=== BASE ===');
  const pool = new Pool(configPostgres(process.env.DATABASE_URL ?? '', 2));
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM contacts)                                     AS contactos,
        (SELECT count(*) FROM conversations)                                AS conversaciones,
        (SELECT count(*) FROM messages WHERE direccion = 'in')              AS entrantes,
        (SELECT count(*) FROM messages WHERE direccion = 'out')             AS salientes,
        (SELECT count(*) FROM messages WHERE status = 'failed')             AS fallidos,
        (SELECT count(*) FROM webhook_events WHERE processed_at IS NULL)    AS cola_pendiente,
        (SELECT count(*) FROM webhook_events WHERE last_error IS NOT NULL)  AS cola_con_error
    `);
    const r = rows[0];
    console.log(`OK   contactos ${r.contactos} · conversaciones ${r.conversaciones}`);
    console.log(`     mensajes: ${r.entrantes} entrantes, ${r.salientes} salientes (${r.fallidos} fallidos)`);
    console.log(`     cola de webhooks: ${r.cola_pendiente} pendientes, ${r.cola_con_error} con error`);
  } catch (e) {
    console.log(`MAL  ${(e as Error).message}`);
  } finally {
    await pool.end().catch(() => undefined);
  }

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
