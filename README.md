# WhatsWV — bandeja compartida de WhatsApp

Backend para que **7 asesores atiendan un solo número de WhatsApp** sin pisarse.

Recibe mensajes de WhatsApp sin duplicarlos, los reparte entre los asesores sin que
dos contesten lo mismo, y todo en tiempo real. Los cuatro pasos están completos.

---

## Estado

| | |
|---|---|
| **Paso 1 — Conexión** | ✅ verificado con un mensaje real de WhatsApp |
| **Paso 2 — Bandeja (UI, WebSocket)** | ✅ |
| **Paso 3 — Multi-asesor (login, asignación atómica, ruteo pegajoso)** | ✅ |
| **Paso 4 — Operación (archivos, plantillas, notas, etiquetas, métricas)** | ✅ este código |

---

## Qué hace hoy

- Recibe webhooks de la WhatsApp Cloud API validando la firma `X-Hub-Signature-256`.
- Encola el payload crudo y responde `200` de inmediato (Meta corta a los 5 s).
- Un worker lo procesa aparte con `FOR UPDATE SKIP LOCKED`.
- Crea contactos y conversaciones sin duplicar, y lleva la **ventana de 24 h**.
- Guarda todos los tipos de mensaje (texto, media, ubicación, botones, listas…).
- Aplica los estados `sent → delivered → read` aunque lleguen desordenados.
- Envía texto y plantillas, registrando también los envíos fallidos.
- Bandeja de tres columnas: lista de chats con no leídos, hilo y ficha del contacto.
- Todo en vivo por WebSocket: lo que ve un asesor lo ven los siete al instante.
- El redactor se bloquea solo cuando vence la ventana de 24 h.
- Login por asesor, con roles admin / supervisor / asesor.
- Asignación atómica: dos asesores no pueden quedarse con la misma conversación.
- Ruteo pegajoso: el cliente vuelve con quien ya lo atendió.
- Reparto por menor carga de los clientes nuevos, entre los asesores conectados.
- Rescate: lo que asignó el sistema y nadie contestó vuelve solo a la cola.
- «Está escribiendo», presencia del equipo y panel de carga por asesor.
- Fotos, audios, videos y documentos: se reciben, se guardan y se envían.
- Vista previa antes de enviar un archivo, y visor a pantalla completa para verlo.
- Plantillas sincronizadas de Meta, con variables y vista previa antes de mandar.
- Mensajes rápidos: se abren con «/» en el redactor y entran al campo para retocarlos.
- Modo claro, oscuro o el que diga el sistema, recordado en cada dispositivo.
- Notas internas intercaladas en el hilo, que el cliente nunca ve.
- Etiquetas por conversación, visibles en la lista y usables como filtro.
- Métricas por asesor y estado de la cola en vivo, con desglose: cada número se
  abre y muestra qué clientes lo componen, ordenados por quién espera hace más.
  Incluye «sin responder», que atrapa las que alguien abrió y nunca contestó.
- Eliminar mensajes de la bandeja, con lápida y auditoría de quién los sacó.
- Creación de plantillas propias desde la terminal, sin pasar por el panel de Meta.

---

## Decisiones que importan

**Los archivos se bajan en el momento, no después.** La URL que da Meta para un
archivo vence a los ~5 minutos, así que la descarga corre en el worker apenas se
guarda el mensaje. Si falla, el mensaje igual queda con su `media_id` y se puede
reintentar: vale más el mensaje que el archivo.

**El almacén es local, en disco.** Para un equipo de 7 sobra, no agrega credenciales
que rotar, y respaldar es copiar una carpeta. El día que haya más de una instancia
hay que moverlo a S3/R2, porque cada proceso vería su propio disco.

**Los archivos se sirven detrás del login y por id de mensaje**, no por ruta. Son
fotos y documentos de clientes: no pueden quedar accesibles adivinando una URL. Por
eso el front los descarga con el token y los muestra como blob — un `<img src>`
directo no manda la cabecera de autorización.

**Adjuntar no envía: primero muestra.** El clip abre una vista previa con la imagen,
el nombre, el peso y un campo de epígrafe. Un archivo que ya salió por WhatsApp no
se puede corregir, y mandar la foto del auto equivocado cuesta una conversación
entera de aclaraciones.

**El tope de archivo lo dicta el servidor**, no el front. Duplicar el número en el
cliente lleva a que un día no coincidan y el asesor descubra el límite recién cuando
el envío falla.

**Eliminar saca de la bandeja, no del teléfono del cliente.** La Cloud API de
WhatsApp **no permite revocar un mensaje ya entregado** — no existe endpoint para
eso, ni acá ni en WATI ni en ninguna herramienta. Lo único que se puede hacer es
dejar de mostrarlo al equipo, y la interfaz lo dice con todas las letras:

- Si el mensaje **falló**, nunca salió: borrarlo es limpieza y el aviso lo aclara.
- Si **sí se entregó**, el cartel avisa que queda en el teléfono del cliente.

El borrado es lógico: el cuerpo queda en la base para auditoría y en el hilo aparece
«Mensaje eliminado por Fulano». Desaparecer la fila entera dejaría al equipo sin
saber que ahí hubo algo, que es justo lo que se necesita saber cuando alguien
pregunta qué pasó.

Un asesor puede eliminar los entrantes y los que mandó él; los salientes ajenos,
sólo supervisores y admins. La regla está escrita igual en el servidor y en el
front: si el front fuera más permisivo, el botón aparecería para terminar en un 403.

**Las notas internas van en su propia tabla**, no en `messages` con una bandera.
Así es imposible que una nota termine enviada al cliente por un `WHERE` mal escrito.

**La métrica que manda es la mediana de primera respuesta**, no el promedio: una
sola conversación olvidada un fin de semana desvirtúa el promedio de toda la semana
y el número deja de significar nada.

**El filtro por etiqueta usa EXISTS, no un JOIN.** Con un JOIN, una conversación
con tres etiquetas saldría tres veces en la lista. Es el bug clásico de este patrón
y la prueba lo cubre.

**Las cinco tarjetas cuentan conversaciones, no mensajes.** «Sin leer» contaba
mensajes sin leer y quedaba un «16» al lado de un «12» de chats: se lee como «16 de
12» y encima no cuadraba con su propio desglose. Hay una prueba que verifica que
cada contador coincida con la lista que despliega — si no coinciden, el panel miente.

**«Sin responder» no es «sin leer».** Son dos números distintos a propósito: un
asesor puede abrir el chat —lo que borra el contador de no leídos— y no contestar
nunca. Esas conversaciones desaparecen de «sin leer» pero el cliente sigue esperando,
y son las que se caen del radar justamente porque para el equipo ya parecen atendidas.
Un envío fallido tampoco cuenta como respuesta: nunca llegó.

Por lo mismo, «espera más vieja» se mide sobre las sin responder y no sobre las sin
leer: lo que le importa al cliente es que nadie le contestó.

**Los contadores de la cola se abren.** «Hay 9 sin asignar» no le sirve a nadie si
no se sabe cuáles: el desglose lista los clientes ordenados por quién espera hace
más —que es el orden en que conviene atenderlos— y cada fila abre el chat. Es lo que
el supervisor quiere hacer apenas ve el número, en vez de anotarlo y buscarlo después
en la bandeja.

**La asignación se resuelve en un solo UPDATE.** Es el corazón del paso 3:

```sql
UPDATE conversations SET assigned_to = $asesor
 WHERE id = $conv AND assigned_to IS NULL
RETURNING id;
```

Si devuelve cero filas, otro la tomó primero. Consultar y después escribir dejaría
una ventana de carrera; con la condición dentro de la sentencia, Postgres serializa
los intentos simultáneos y sólo uno gana. La prueba lanza dos peticiones en paralelo
y verifica que exactamente una reciba 200 y la otra 409.

**El reparto elige por menor carga, no por turnos.** Round-robin reparte parejo
en cantidad pero no en trabajo: quien tarda más acumula igual. Mirar la carga real
se auto-balancea, y el desempate aleatorio evita favorecer siempre al mismo cuando
varios están en cero.

Sólo entran los de rol `asesor` y sólo si están conectados. Supervisores y admins
pueden tomar a mano lo que quieran, pero no reciben reparto automático.

**Lo automático se rescata; lo manual no.** La columna `asignada_auto` distingue
las dos cosas. Si el sistema le dio una conversación a alguien que estaba conectado
pero se fue a almorzar, a los N minutos vuelve a la cola. Si alguien la tomó a mano,
es problema suyo y el sistema no se la quita.

**La presencia se deriva de las salas de socket.io, no de un mapa propio.** Un mapa
paralelo se desincroniza —basta que el socket se cierre mientras se valida el token—
y deja a alguien «conectado» para siempre, con el ruteo mandándole clientes a quien
ya se fue.

**Contraseñas con `scrypt` nativo, sin bcrypt.** Es un KDF correcto, viene en Node y
evita dependencias que compilar, que en Windows son un dolor.

**Front en Vite + React, no Next.js.** La bandeja va detrás de login y es tiempo
real: no necesita renderizado del servidor ni SEO, que es lo único que Next aportaría.
Se compila a `dist/public` y la sirve el mismo proceso de Nest: un solo despliegue.

**Sin Redis.** La cola vive en Postgres. Para 7 asesores sobra, es un servicio menos
que operar, y a diferencia de Redis te deja el payload crudo guardado: auditable y
reprocesable. Sigue sin hacer falta en el paso 3: la presencia y el «está
escribiendo» viven en memoria del proceso. Redis recién haría falta el día que corras
más de una instancia del servidor, para que los sockets se vean entre sí.

**Idempotencia por `wa_message_id`.** Meta reenvía el mismo webhook varias veces.
El índice `UNIQUE` + `ON CONFLICT DO NOTHING` absorbe el reintento. Es la razón por
la que el worker puede fallar a mitad de camino sin corromper nada.

**Una sola conversación viva por contacto.** Lo garantiza un índice único parcial:

```sql
CREATE UNIQUE INDEX ON conversations (contact_id) WHERE estado <> 'resuelto';
```

Sin esto, dos webhooks simultáneos del mismo cliente crean dos hilos y dos asesores
terminan contestando por separado.

**El modo oscuro no toca los componentes, les cambia el significado a los colores.**
La bandeja se escribió con los colores puestos a mano —`bg-white`, `text-slate-400`,
`border-slate-200`— repartidos por veinte componentes. Ponerle un `dark:` a cada uno eran
cientos de ediciones y la garantía de que alguna quedara a medias. Como Tailwind 4
compila `text-slate-400` a `color: var(--color-slate-400)`, alcanza con redefinir esas
variables dentro de `.oscuro` en [`estilos.css`](web/src/estilos.css): la interfaz entera
se da vuelta sin tocar un componente.

Tres casos no entran en esa regla y van por clase, cada uno comentado en el archivo:
`bg-white` y `text-white` son la misma variable (la superficie tiene que oscurecerse, el
texto sobre el verde de marca no); `bg-slate-900/50` es el velo de los modales y tiene
que seguir oscuro; y `bg-slate-800 text-white` es la píldora activa, que se da vuelta
entera para que «esto está seleccionado» siga leyéndose. Hay un detalle que se paga
caro si se olvida: las variantes son clases aparte, así que `focus:bg-white` necesita
su propia línea — sin ella el redactor se ponía blanco justo al hacerle foco.

Qué queda sin pisar es a propósito: los botones sólidos con letra blanca, los velos y
los acentos claros. Se puede auditar mirando que toda utilidad de color del código
esté cubierta por una variable o por una regla.

**Los estados sólo avanzan.** `status_rank` numérico: un `delivered` que llega tarde
no puede pisar un `read`. Pasa seguido en la práctica.

**Se ordena por `wa_timestamp` de Meta, nunca por `now()`.** Los webhooks llegan
desordenados; usar la hora local descoloca el hilo.

---

## Puesta en marcha

### 1. Base de datos

Sin Docker en la máquina, lo más rápido es **[Neon](https://neon.tech)** (plan gratuito):
crear proyecto y copiar la cadena de conexión.

Si preferís local y tenés Docker: `docker compose up -d` (incluido en el repo).

### 2. App de Meta

> El panel nuevo de Meta ("casos de uso") tiene un asistente guiado que suele rebotar
> a *Paso 1* sin mostrar nunca los identificadores. Si te pasa, no insistas: los pasos
> de abajo van por Business Settings y funcionan igual, además de darte el token
> permanente de una vez.

Anotá tu **App ID** — está en la URL: `developers.facebook.com/apps/<APP_ID>/...`

1. **WABA ID** → [business.facebook.com/settings/whatsapp-business-accounts](https://business.facebook.com/settings/whatsapp-business-accounts)

   Elegí la cuenta y copiá el `Identificador`. Ojo: las que dicen *"App de WhatsApp
   Business"* debajo del nombre son de la aplicación móvil y **no sirven** para la API.
   La que necesitás es una WABA de Cloud API (para desarrollo, la que el asistente
   crea como *Test WhatsApp Business Account*).

2. **Token permanente** → [business.facebook.com/settings/system-users](https://business.facebook.com/settings/system-users)

   - *Agregar* → nombre libre → rol **Administrador**
   - *Agregar activos*: pestaña **Apps** → tu app → **Control total**;
     pestaña **Cuentas de WhatsApp** → tu WABA → **Control total**
   - *Generar token nuevo* → app: la tuya · vencimiento: **Nunca** ·
     permisos: `whatsapp_business_messaging` y `whatsapp_business_management`

   Ese es `META_ACCESS_TOKEN`. **No se vuelve a mostrar**: si lo perdés, generá otro.

3. **App Secret** → `developers.facebook.com/apps/<APP_ID>/settings/basic/` →
   `Clave secreta de la app` → **Mostrar**. Es `META_APP_SECRET`.

4. **Phone Number ID** → con el token ya cargado, preguntáselo al Graph API en vez de
   buscarlo en el panel:

   ```bash
   curl -s "https://graph.facebook.com/v23.0/<WABA_ID>/phone_numbers?access_token=<TOKEN>"
   ```

   El campo `id` de la respuesta es `META_PHONE_NUMBER_ID` (un número largo, **no** el
   teléfono).

5. `META_WEBHOOK_VERIFY_TOKEN`: lo inventás vos, cualquier cadena larga.

6. **Destinatarios de prueba.** En modo desarrollo sólo se puede escribir a **hasta 5
   números verificados**. Agregá tu celular en la consola de la API (sección *"Para"*)
   y confirmá el código que llega por WhatsApp. Sin esto no recibís ni enviás nada, y
   el error de Meta no lo dice claro.

### 3. Configurar el proyecto

```bash
cp .env.example .env      # y completá los valores
npm install
npm run db:migrate
npm run dev
```

### 4. Exponer el webhook

Meta necesita una URL pública con HTTPS. En otra terminal:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Copiá la URL `https://algo.trycloudflare.com` que imprime.

### 5. Registrar el webhook en Meta

**WhatsApp → Configuration → Webhooks → Editar**:

| Campo | Valor |
|---|---|
| Callback URL | `https://algo.trycloudflare.com/webhooks/whatsapp` |
| Verify token | el mismo `META_WEBHOOK_VERIFY_TOKEN` de tu `.env` |

*Verificar y guardar*. En el log debe aparecer `webhook verificado por Meta`.

Después, en **Webhook fields**, suscribí **`messages`**. Sin esa suscripción no llega
absolutamente nada — es el error más común.

---

## Probar

Todos los `/dev` requieren la cabecera `x-dev-key: <DEV_API_KEY>`.

```bash
# ¿el token y el phone number id son correctos?
curl -H "x-dev-key: TU_CLAVE" http://localhost:3000/dev/salud

# escribile al número desde tu WhatsApp personal, y después:
curl -H "x-dev-key: TU_CLAVE" http://localhost:3000/dev/conversaciones

# responder (sólo funciona si el cliente escribió en las últimas 24 h)
curl -X POST http://localhost:3000/dev/enviar \
  -H "x-dev-key: TU_CLAVE" -H "Content-Type: application/json" \
  -d '{"a":"51999888777","texto":"hola desde la app"}'

# fuera de la ventana de 24 h, sólo plantilla
curl -X POST http://localhost:3000/dev/plantilla \
  -H "x-dev-key: TU_CLAVE" -H "Content-Type: application/json" \
  -d '{"a":"51999888777","nombre":"hello_world","idioma":"en_US"}'

# webhooks que reventaron 5 veces y ya no se reintentan
curl -H "x-dev-key: TU_CLAVE" http://localhost:3000/dev/webhooks-fallidos
```

### La bandeja

```bash
npm run build:todo    # backend primero, después el front (el orden importa:
npm start             # `nest build` borra dist/, y el front va dentro)
```

Abrí `http://localhost:3000` y entrá con el valor de `DEV_API_KEY`.

Para desarrollar con recarga en caliente, dos terminales:

```bash
npm run dev        # backend en :3000
npm run web:dev    # front en :5173, proxea /api y /socket.io al backend
```

### Asesores

No hay pantalla de registro a propósito: nadie debería poder crearse una cuenta solo
en una bandeja interna.

```bash
npm run asesores -- demo                    # crea los 7 con clave temporal
npm run asesores -- listar
npm run asesores -- crear "Ana Pérez" ana@repuestos.com claveSegura123 asesor
npm run asesores -- clave ana@repuestos.com otraClave456
npm run asesores -- baja ana@repuestos.com  # desactiva, no borra el historial
```

Roles: `asesor` atiende lo propio; `supervisor` y `admin` pueden además reasignar
conversaciones ajenas.

### Datos de prueba sin depender de Meta

```bash
npm run simular -- demo        # carga conversaciones de ejemplo
npm run simular -- limpiar     # las borra (respeta los mensajes reales)
npm run simular -- entrante 573001112233 "hola"
npm run simular -- media 573001112233     # una foto entrante
```

`media` es el único que **no** pasa por el webhook: un `media_id` inventado haría
fallar la descarga contra Meta. Sirve para ver cómo se comporta la interfaz con
imágenes, no para probar el camino de entrada.

No es un atajo: el payload entra firmado por `POST /webhooks/whatsapp` y recorre
firma → cola → worker → base, igual que uno real. Lo único que no toca es la red
de Meta.

### Diagnóstico

```bash
npm run diagnostico          # token, número, registro, webhook y base, de un vistazo
npm run webhook:estado
npm run webhook:registrar -- https://nueva-url.trycloudflare.com
```

El último hace falta cada vez que se reinicia el túnel, porque cambia la URL.

### Pruebas automáticas

```bash
npm run test:smoke        # no necesita nada levantado
npm run test:realtime     # necesita el server corriendo
npm run test:asignacion   # necesita el server y los asesores creados
npm run test:operacion    # archivos, plantillas, notas, etiquetas y métricas
```

`test:smoke` levanta un Postgres embebido (PGlite, sin Docker ni servidor), aplica
las migraciones reales y verifica lo que de verdad puede romperse: el índice único
parcial, la idempotencia, la ventana de 24 h, el orden de los estados, la cola y la
firma HMAC.

`test:realtime` comprueba contra el servidor real que un webhook entrante llegue
empujado al asesor, que el socket exija token, que nadie reciba mensajes de hilos
que no tiene abiertos, y que un webhook duplicado no genere evento duplicado.

`test:asignacion` cubre el paso 3: login y rechazos, la carrera de dos asesores por
la misma conversación, los permisos por rol, el ruteo pegajoso (y que no le asigne a
quien no está conectado), el reparto por menor carga, el rescate (y que no toque lo
tomado a mano ni lo ya contestado), el «está escribiendo», y que la presencia se
limpie — incluso si el socket se cierra durante la validación del token.

Necesita ser la **única** instancia corriendo contra esa base: si hay otra, se
reparten la cola de webhooks y los resultados se vuelven aleatorios.

---

## Estructura

```
src/
  config/env.ts               variables validadas con zod; falla al arrancar si falta algo
  db/schema.ts                el modelo de datos completo
  whatsapp/
    webhook.controller.ts     valida firma → encola → 200. Nada más.
    signature.ts              HMAC con comparación en tiempo constante
    graph.service.ts          cliente HTTP de Meta, sin lógica de negocio
    inbound.service.ts        traduce el payload a filas nuestras
  queue/
    webhook-queue.service.ts  encolar = un INSERT
    webhook.worker.ts         FOR UPDATE SKIP LOCKED + backoff exponencial
  conversations/              contactos, hilos, ventana de 24 h
  messages/                   persistencia, estados y envío
  api/bandeja.service.ts      consultas de la bandeja (el LATERAL evita N+1)
  asignacion/                 tomar, soltar, reasignar y ruteo pegajoso
  media/                      almacén en disco y descarga desde Meta
  plantillas/                 sincronización y armado de components
  operacion/                  notas, etiquetas y métricas
  auth/                       login, scrypt, JWT y guard
  realtime/                   gateway de WebSocket, presencia y escritura
  dev/                        endpoints de diagnóstico
web/
  src/App.tsx                 estado de la bandeja y suscripción al socket
  src/componentes/            lista, hilo, redactor, ficha de contacto
scripts/
  asesores.ts                 alta, baja y claves del equipo
  simular.ts                  webhooks firmados sin pasar por Meta
  diagnostico.ts              estado de la conexión de punta a punta
  webhook.ts                  registrar/consultar el webhook por API
```

---

## Detalles a tener presentes

**Versión del Graph API.** Está en `META_GRAPH_VERSION` (por defecto `v23.0`). Meta
publica una nueva cada pocos meses y retira las viejas a los ~2 años. Confirmá la
vigente en el [changelog](https://developers.facebook.com/docs/graph-api/changelog)
y actualizá esa variable.

**El número no puede estar en uso.** Si el teléfono ya tiene WhatsApp o WhatsApp
Business normal, hay que borrar esa cuenta antes de registrarlo en la API. No conviven.

**Ventana de 24 h.** Fuera de ella Meta rechaza el texto libre. `OutboundService` lo
corta antes de gastar la llamada y devuelve `422 ventana_cerrada`. La única salida es
una plantilla aprobada.

**Las URLs de media expiran en ~5 minutos.** `GraphService` ya trae `urlDeMedia()` y
`descargarMedia()`; la bajada a storage propio se conecta en el paso 4.

**El check azul no se manda solo.** Se envía cuando un asesor *abre* el chat, no al
recibir el mensaje. Se conecta en el paso 2 con `GraphService.marcarLeido()`.

**Si Meta desactiva tu webhook** es porque el endpoint falló repetido. Revisá
`/dev/webhooks-fallidos` y volvé a suscribir el campo `messages`.

**El número de prueba de Meta sí recibe mensajes entrantes** de cualquiera, pero
sólo puede *enviar* a una lista blanca de hasta 5 números verificados. Esa lista se
administra únicamente desde la consola del asistente de la app: no hay API.

**El tope por asesor** (`MAX_CONVERSACIONES_POR_ASESOR`, por defecto 15) sólo frena
el ruteo automático: nadie queda impedido de tomar una conversación a mano. Si la
cola no baja, mirá el panel «Equipo» — probablemente haya gente al tope o desconectada.

**No corras dos instancias contra la misma base.** La presencia vive en la memoria
del proceso, y el worker de webhooks toma trabajo de una cola compartida: la
instancia que procese un mensaje puede no ser la que tiene los sockets abiertos, y
va a creer que no hay nadie conectado para repartir. Para escalar horizontalmente
hace falta el adaptador de Redis de socket.io. Con 7 asesores, una instancia sobra.

**Interruptores del reparto** en el `.env`:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `AUTO_ASIGNAR` | `true` | `false` manda todo lo nuevo a la cola manual |
| `RESCATE_MINUTOS` | `5` | `0` desactiva el rescate |
| `MAX_CONVERSACIONES_POR_ASESOR` | `15` | tope para el reparto automático |

El ruteo pegajoso no se apaga con `AUTO_ASIGNAR`: devolver un cliente a quien ya lo
atendió es una decisión distinta de repartir uno nuevo.

**Los tokens de sesión duran 12 h** y viven en `localStorage`, así que se mandan como
`Authorization: Bearer` tanto en HTTP como en el WebSocket. Si cambia `JWT_SECRET`,
todos los asesores tienen que volver a entrar.

**`DEV_API_KEY` ya no protege la bandeja**, sólo los endpoints `/dev` de diagnóstico.
La bandeja usa el login por asesor.

**Las plantillas las aprueba Meta, pero se crean desde acá.** No hace falta pelear
con el panel:

```bash
npm run plantillas -- listar       # incluye las PENDING, con su estado
npm run plantillas -- sugeridas    # crea el juego base para el negocio
npm run plantillas -- crear mi-plantilla.json
npm run plantillas -- borrar <nombre>
```

La categoría define el precio: `UTILITY` es seguimiento de algo que el cliente ya
pidió y cuesta menos; `MARKETING` es promoción y cuesta más. Si el texto no encaja
con lo declarado, Meta la recategoriza sola — el script avisa cuando pasa.

La aprobación tarda de horas a un par de días, así que las que vayas a necesitar
conviene crearlas con tiempo. Sólo las `APPROVED` aparecen en el selector de la
bandeja; el botón «Sincronizar con Meta» del selector las trae.

Reglas de Meta que conviene tener a mano: el cuerpo no puede empezar ni terminar en
variable, ni llevar dos seguidas, y toda plantilla con variables necesita valores de
ejemplo para que puedan revisarla.

**Los mensajes rápidos no pasan por Meta.** Son texto libre que sale por la ventana
de 24 h, así que se editan en el código y listo: [`web/src/componentes/mensajes-rapidos.ts`](web/src/componentes/mensajes-rapidos.ts).
Cada uno es un `atajo` —lo que se teclea después de la barra— y un `texto`, que
puede llevar dos huecos: `{nombre}` (el nombre de pila del cliente) y `{asesor}`.

En la bandeja se abren tecleando `/` al principio del mensaje o con el botón ⚡. Se
filtran siguiendo lo que se escribe, se recorren con ↑↓ y se eligen con Enter. El
texto **cae en el redactor, no se envía solo**: casi siempre hay algo que ajustarle,
y un mensaje que ya salió por WhatsApp no se corrige.

No confundirlos con las plantillas: el mensaje rápido sirve mientras la ventana de
24 h esté abierta; pasada la ventana, sólo entra una plantilla aprobada.

**Lo que quedó de probar no se puede borrar, pero se esconde.** Meta rechaza el
DELETE de una plantilla con «Need permission on either WhatsApp Business Account or
owner/shared business» aunque el token tenga `whatsapp_business_management`: borrar
pide control total sobre la cuenta y la nuestra es compartida. Por eso el selector
filtra por nombre las que empiezan con `prueba` o terminan en `_tmp` — siguen en la
cuenta de Meta, pero nadie las manda por error. Para sacarlas de verdad hay que
entrar al WhatsApp Manager con la cuenta dueña del negocio.

Las plantillas con **archivo en el encabezado** (imagen, video o documento) todavía
no están soportadas: el selector las muestra pero avisa. Las de sólo texto, con o
sin variables, funcionan completas.

**El tope de archivo** es `MEDIA_MAX_MB` (16 por defecto, que es el máximo que
acepta WhatsApp). Los que superen ese tamaño no se descargan y queda avisado en el log.
