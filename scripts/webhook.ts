/**
 * Registra o consulta el webhook de WhatsApp en Meta, sin pasar por el panel.
 *
 *   npm run webhook:estado
 *   npm run webhook:registrar -- https://algo.trycloudflare.com
 *
 * La URL de un tunel gratuito cambia en cada reinicio, y con ella hay que volver a
 * registrar el callback. Esto lo hace en un comando.
 */
try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const V = process.env.META_GRAPH_VERSION ?? 'v23.0';
const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const WABA_ID = process.env.META_WABA_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;
const VERIFY = process.env.META_WEBHOOK_VERIFY_TOKEN;

function exigir(nombre: string, valor: string | undefined): string {
  if (!valor) {
    console.error(`falta ${nombre} en el .env`);
    process.exit(1);
  }
  return valor;
}

/** Token de app: no requiere usuario, sirve para gestionar suscripciones. */
const tokenDeApp = () => `${exigir('META_APP_ID', APP_ID)}|${exigir('META_APP_SECRET', APP_SECRET)}`;

async function estado() {
  const r = await fetch(
    `https://graph.facebook.com/${V}/${APP_ID}/subscriptions?access_token=${tokenDeApp()}`,
  );
  const j = (await r.json()) as any;

  if (!r.ok) {
    console.error(`error ${r.status}: ${j?.error?.message ?? JSON.stringify(j)}`);
    process.exit(1);
  }

  const wa = j.data?.find((d: any) => d.object === 'whatsapp_business_account');
  if (!wa) {
    console.log('sin suscripcion a whatsapp_business_account. Corre webhook:registrar.');
    return;
  }

  console.log(`callback : ${wa.callback_url}`);
  console.log(`activo   : ${wa.active}`);
  console.log(`campos   : ${(wa.fields ?? []).map((f: any) => f.name).join(', ')}`);

  const r2 = await fetch(`https://graph.facebook.com/${V}/${WABA_ID}/subscribed_apps`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const j2 = (await r2.json()) as any;
  const apps = (j2.data ?? []).map((a: any) => a.whatsapp_business_api_data?.name ?? '?');
  console.log(`apps en la WABA: ${apps.length ? apps.join(', ') : 'ninguna'}`);
}

async function registrar(url: string) {
  if (!/^https:\/\//.test(url)) {
    console.error('la URL debe ser https (Meta rechaza http)');
    process.exit(1);
  }

  const callback = url.replace(/\/+$/, '') + '/webhooks/whatsapp';
  console.log(`registrando ${callback}`);
  console.log('(Meta va a llamar a esa URL ahora mismo para verificarla:');
  console.log(' el server y el tunel tienen que estar levantados)');

  // 1. callback + verify token a nivel de app
  const r = await fetch(`https://graph.facebook.com/${V}/${APP_ID}/subscriptions`, {
    method: 'POST',
    body: new URLSearchParams({
      object: 'whatsapp_business_account',
      callback_url: callback,
      verify_token: exigir('META_WEBHOOK_VERIFY_TOKEN', VERIFY),
      fields: 'messages',
      access_token: tokenDeApp(),
    }),
  });
  const j = (await r.json()) as any;
  if (!r.ok || !j.success) {
    console.error(`fallo el registro: ${j?.error?.message ?? JSON.stringify(j)}`);
    process.exit(1);
  }
  console.log('callback registrado y verificado');

  // 2. suscribir la app a esta WABA en particular
  const r2 = await fetch(`https://graph.facebook.com/${V}/${WABA_ID}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${exigir('META_ACCESS_TOKEN', TOKEN)}` },
  });
  const j2 = (await r2.json()) as any;
  if (!r2.ok || !j2.success) {
    console.error(`fallo la suscripcion a la WABA: ${j2?.error?.message ?? JSON.stringify(j2)}`);
    process.exit(1);
  }
  console.log('app suscrita a la WABA. Listo.');
}

const [comando, url] = process.argv.slice(2);

if (comando === 'registrar') {
  if (!url) {
    console.error('uso: npm run webhook:registrar -- https://tu-tunel.trycloudflare.com');
    process.exit(1);
  }
  void registrar(url);
} else {
  void estado();
}
