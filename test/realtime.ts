/**
 * Prueba end-to-end del tiempo real, contra el servidor levantado.
 *   npm run dev            (en otra terminal)
 *   npm run test:realtime
 *
 * Comprueba que un webhook entrante llegue empujado a los asesores conectados,
 * que la clave se exija en el socket, y que un asesor solo reciba el hilo que
 * tiene abierto. Es lo que hace que 7 personas vean el mismo estado.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { BASE, exigirEntornoSeguro } from './entorno';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}


let TOKEN = '';
const SECRETO = process.env.META_APP_SECRET ?? '';
const WABA = process.env.META_WABA_ID ?? '0';
const PHONE = process.env.META_PHONE_NUMBER_ID ?? '0';

let fallos = 0;

async function prueba(nombre: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${nombre}`);
  } catch (e) {
    fallos++;
    console.error(`  FALLO  ${nombre}`);
    console.error(`         ${(e as Error).message}`);
  }
}

function conectar(token: string): Socket {
  return io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
}

async function login(email: string, clave = process.env.CLAVE_PRUEBAS ?? 'cambiar1234'): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, clave }),
  });
  if (!r.ok) throw new Error(`login falló (${r.status}). ¿Corriste: npm run asesores -- demo ?`);
  return ((await r.json()) as any).token;
}

/** Espera un evento con limite de tiempo, para que un fallo no cuelgue la prueba. */
function esperar<T = any>(socket: Socket, evento: string, ms = 8000): Promise<T> {
  return new Promise((resolver, rechazar) => {
    const t = setTimeout(() => rechazar(new Error(`no llego '${evento}' en ${ms}ms`)), ms);
    socket.once(evento, (d: T) => {
      clearTimeout(t);
      resolver(d);
    });
  });
}

async function webhookEntrante(telefono: string, texto: string) {
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE },
              contacts: [{ profile: { name: 'Prueba Realtime' }, wa_id: telefono }],
              messages: [
                {
                  from: telefono,
                  id: `wamid.RT${Date.now().toString(36)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: texto },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const firma = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
  const r = await fetch(`${BASE}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma },
    body: cuerpo,
  });
  assert.equal(r.status, 200, 'el webhook no respondio 200');
}

const api = (ruta: string): Promise<any[]> =>
  fetch(`${BASE}/api${ruta}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then(
    (r) => r.json() as Promise<any[]>,
  );

async function main() {
  exigirEntornoSeguro();

  try {
    TOKEN = await login('andres@repuestos.com');
  } catch (e) {
    console.error(`\n${(e as Error).message}`);
    console.error(`(¿está el servidor en ${BASE}? Levantalo con: npm run dev)\n`);
    process.exit(1);
  }

  console.log('\nsocket\n');

  await prueba('rechaza la conexion sin token valido', async () => {
    const s = conectar('token.invalido');
    try {
      // Debe llegar 'no-autorizado' o cortarse la conexion. Cualquiera vale.
      await Promise.race([esperar(s, 'no-autorizado', 5000), esperar(s, 'disconnect', 5000)]);
    } finally {
      s.close();
    }
  });

  const tel = '5730099' + String(Math.floor(1000 + Math.random() * 9000));

  await prueba('un entrante llega empujado al hilo abierto', async () => {
    const s = conectar(TOKEN);
    try {
      await esperar(s, 'connect');

      // Primer mensaje: crea la conversacion para poder abrirla.
      await webhookEntrante(tel, 'primer mensaje');
      await esperar(s, 'conversacion:actualizada');

      const lista = await api('/conversaciones?estado=todas&asignado=todos&q=' + tel);
      assert.ok(lista.length > 0, 'la conversacion no aparecio en la bandeja');
      const conv = lista[0];

      s.emit('ver', conv.id);
      // Da un instante a que el servidor procese el join antes de emitir.
      await new Promise((r) => setTimeout(r, 300));

      await webhookEntrante(tel, 'segundo mensaje');
      const evento = await esperar<{ conversationId: string; mensaje: any }>(s, 'mensaje:nuevo');

      assert.equal(evento.conversationId, conv.id, 'llego el hilo equivocado');
      assert.equal(evento.mensaje.cuerpo, 'segundo mensaje');
      assert.equal(evento.mensaje.direccion, 'in');
    } finally {
      s.close();
    }
  });

  await prueba('no se filtran mensajes de hilos ajenos', async () => {
    const s = conectar(TOKEN);
    try {
      await esperar(s, 'connect');
      s.emit('ver', '00000000-0000-0000-0000-000000000000');
      await new Promise((r) => setTimeout(r, 300));

      let recibido = false;
      s.on('mensaje:nuevo', () => {
        recibido = true;
      });

      await webhookEntrante(tel, 'no deberia llegar');
      // La lista si debe refrescarse: eso lo ven todos.
      await esperar(s, 'conversacion:actualizada');
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(recibido, false, 'recibio un mensaje de una conversacion que no tiene abierta');
    } finally {
      s.close();
    }
  });

  await prueba('el webhook duplicado no genera evento duplicado', async () => {
    const s = conectar(TOKEN);
    try {
      await esperar(s, 'connect');

      const lista = await api('/conversaciones?estado=todas&asignado=todos&q=' + tel);
      const conv = lista[0];
      s.emit('ver', conv.id);
      await new Promise((r) => setTimeout(r, 300));

      // Mismo payload dos veces = mismo wa_message_id: el segundo debe absorberse.
      // El id es unico por corrida: si fuera fijo, la segunda ejecucion de la
      // prueba encontraria el mensaje ya guardado y no emitiria ningun evento.
      const idFijo = `wamid.DUP${Date.now().toString(36)}`;
      const cuerpo = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: PHONE },
                  contacts: [{ profile: { name: 'Prueba Realtime' }, wa_id: tel }],
                  messages: [
                    {
                      from: tel,
                      id: idFijo,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'mensaje repetido' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const firma = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
      const enviar = () =>
        fetch(`${BASE}/webhooks/whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma },
          body: cuerpo,
        });

      // Se cuentan solo los eventos de ESTE mensaje: el hilo es compartido con
      // las pruebas anteriores y un entrante de aquellas, emitido tarde, se
      // colaba en la cuenta y hacia fallar la prueba por algo que no mide.
      let cuenta = 0;
      s.on('mensaje:nuevo', (e: { mensaje?: { waMessageId?: string } }) => {
        if (e?.mensaje?.waMessageId === idFijo) cuenta++;
      });

      await enviar();
      await enviar();

      // Espera al evento en vez de a un plazo fijo: lo que tarda el worker
      // depende de la red (el bot le habla a Meta), y un sleep corto hacía
      // fallar la prueba por lenta, no por duplicada.
      const limite = Date.now() + 20_000;
      while (cuenta === 0 && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(cuenta > 0, true, 'no llegó ningún evento por el mensaje');

      // Margen para que aparezca el duplicado, si el segundo webhook no se absorbió.
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(cuenta, 1, `se emitieron ${cuenta} eventos para el mismo mensaje`);
    } finally {
      s.close();
    }
  });

  console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} PRUEBA(S) FALLARON\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
