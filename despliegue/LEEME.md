# Despliegue

Cómo pasar WhatsWV de la computadora del escritorio a un servidor donde los 7
asesores puedan trabajar.

## Qué queda montado

```
        Meta (WhatsApp Cloud API)
                  │  webhook HTTPS
                  ▼
        ┌───────────────────┐
        │  Caddy  :443      │  certificado que se renueva solo
        └─────────┬─────────┘
                  │  proxy a 127.0.0.1:3000
        ┌─────────▼─────────┐
        │  whatswv.service  │  Node 22, arranca solo, se reinicia solo
        │  (usuario whatswv)│
        └─────────┬─────────┘
                  │
     ┌────────────┴────────────┐
     ▼                         ▼
  Neon (Postgres)     /opt/whatswv/almacen
                      fotos y audios de clientes
```

El puerto 3000 no queda expuesto: a la app se llega únicamente por Caddy, con
HTTPS. El firewall deja pasar sólo SSH, 80 y 443.

## Primera vez

**1. Crear el servidor.** DigitalOcean, droplet básico de USD 6, Ubuntu 24.04,
región New York o Atlanta.

**2. Apuntar el dominio.** En el panel de tu dominio, un registro `A`:

| Tipo | Nombre    | Valor          |
|------|-----------|----------------|
| A    | `bandeja` | 107.170.72.128 |

Esperá a que resuelva antes de seguir; si no, Caddy no consigue el certificado:

```bash
nslookup bandeja.chatwasvw.com
```

**3. Instalar.** Desde tu máquina:

```bash
scp despliegue/instalar.sh root@107.170.72.128:/tmp/
ssh root@107.170.72.128 "bash /tmp/instalar.sh bandeja.chatwasvw.com"
```

**4. Configurar.** Copiá el `.env` al servidor y ajustá lo de producción
(abajo está qué cambia):

```bash
scp .env root@107.170.72.128:/opt/whatswv/.env
ssh root@107.170.72.128 "chown whatswv:whatswv /opt/whatswv/.env && chmod 600 /opt/whatswv/.env"
```

**5. Subir la app.**

```bash
bash despliegue/subir.sh root@107.170.72.128
```

**6. Registrar el webhook en Meta.** Ya no hace falta el túnel:

```bash
npm run webhook:registrar -- https://bandeja.chatwasvw.com
npm run diagnostico
```

## Actualizaciones

Una sola línea, y sirve para siempre:

```bash
bash despliegue/subir.sh root@107.170.72.128
```

Compila acá, sube el resultado, aplica las migraciones y reinicia. Si una
migración falla, corta antes de tocar la versión que está andando.

Para verificar sin cambiar nada —se puede en horario de atención—:

```bash
bash despliegue/subir.sh root@107.170.72.128 --probar
```

Compila, empaqueta y comprueba que el servidor contesta, que tiene su `.env` y que el
servicio está activo. No sube nada.

## Desplegar desde GitHub, sin este computador

El botón **Desplegar** corre el mismo `subir.sh` en una máquina de GitHub, así que se
puede desplegar desde el navegador o el celular aunque el computador del escritorio
esté apagado.

**Usarlo:** github.com → el repositorio → **Actions** → **Desplegar** → **Run workflow**,
y elegir el modo:

- **probar** (el que viene marcado): compila y verifica la conexión. No toca nada.
- **desplegar**: sube la versión y reinicia el servicio unos segundos. Fuera de
  horario.

Sólo despliega desde `main`, y dos despliegues a la vez se esperan en vez de pisarse.

### Dejarlo andando (una sola vez)

Usa una llave propia, **no** la de este computador: así se revoca sin tocar la otra,
y la llave del escritorio nunca sale de acá. Ya está creada en `~/.ssh/whatswv-github`.

**1. Autorizarla en el servidor.** Desde la terminal de este computador:

```bash
bash -c "cat ~/.ssh/whatswv-github.pub | ssh -i ~/.ssh/whatswv root@107.170.72.128 'cat >> /root/.ssh/authorized_keys'"
```

**2. Guardarla en GitHub.** Copiarla al portapapeles sin que se vea en pantalla:

```bash
bash -c "clip < ~/.ssh/whatswv-github"
```

En github.com → el repositorio → **Settings** → **Secrets and variables** →
**Actions** → **New repository secret**. Nombre `SSH_WHATSWV`, y en el valor, pegar.
GitHub la guarda cifrada y no la vuelve a mostrar nunca, ni a quien la cargó.

**3. Probar.** Actions → Desplegar → Run workflow con **probar**. Tiene que terminar en
verde con «prueba ok». Si falla en «Llave y huella del servidor», el secret no está o
tiene otro nombre; si falla al conectar, falta el paso 1.

### Qué protege y qué no

- **La llave** vive cifrada en los Secrets. Ni el flujo ni el log la muestran, y se
  borra del disco de la máquina de GitHub al terminar.
- **El servidor** se verifica contra su huella, fijada en
  `.github/workflows/desplegar.yml`. Si algo contesta en esa IP haciéndose pasar por
  él, la conexión se corta antes de mandarle nada.
- **Quién puede desplegar:** cualquiera con permiso de escritura en el repositorio.
  El repositorio es público, así que cualquiera puede *leer* el flujo, pero no
  correrlo ni ver el secret. Aun así conviene hacerlo privado (Settings → General):
  hoy se ven la IP, el dominio y cómo se despliega.

### Revocar la llave

Si se filtró, o para dejar de usar el botón:

```bash
ssh -i ~/.ssh/whatswv root@107.170.72.128 "sed -i '/github-actions-desplegar@ChatwasVW/d' /root/.ssh/authorized_keys"
```

Y borrar el secret `SSH_WHATSWV` en GitHub.

## Hacer cambios con Claude, sin este computador

El botón despliega, pero no cambia nada. Para pedirle un cambio a Claude con el
computador apagado, una sesión en la nube: [claude.ai/code](https://claude.ai/code), o la
app de Claude en el celular.

**La primera vez:** entrar a claude.ai/code, conectar GitHub dándole acceso al
repositorio `ChatwasVW`, y dejar el entorno **Default** (red *Trusted*, sin variables
ni script). No hace falta nada más: al arrancar, la sesión instala las dependencias
sola (`scripts/instalar-nube.sh`) y lee `CLAUDE.md`, que es donde está lo que tiene que
saber del negocio.

**No cargar secretos en el entorno** —ni el `.env`, ni la llave del servidor—: la
documentación de Claude avisa que cualquier comando de la sesión puede leer esas
variables. La sesión trabaja sin ellos.

**Cómo queda el circuito:**

1. Le pedís el cambio. Claude lo hace, lo verifica (compila, construye la bandeja,
   corre el smoke) y lo sube en **una rama con pull request**: desde la nube no puede
   escribir directo en `main`.
2. Revisás el pull request en GitHub y, si está bien, lo aprobás (*Merge*).
3. Fuera de horario, le pedís que despliegue, o apretás vos el botón. Claude lo
   dispara con `gh workflow run`, sin ver la llave.

Lo que desde la nube **no** se puede: tocar las bases, la API de Meta, o correr las
pruebas que necesitan servidor y base. Eso sigue siendo del escritorio.

### Si se reinstala el droplet

Cambia la huella del servidor y el botón se niega a conectar —que es lo que tiene que
hacer—. Hay que poner la nueva en `.github/workflows/desplegar.yml`, comprobando
que la que se ve desde afuera sea la misma que el servidor dice tener:

```bash
ssh-keyscan -t ed25519 107.170.72.128
ssh -i ~/.ssh/whatswv root@107.170.72.128 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
```

## Qué cambia en el `.env` de producción

| Variable | Local | Servidor |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `ALMACEN_DIR` | `./almacen` | `/opt/whatswv/almacen` |
| `JWT_SECRET` | cualquiera | uno largo y propio de producción |
| `DEV_API_KEY` | la que tengas | **borrala**: los endpoints `/dev/*` no van en producción |

Para generar un `JWT_SECRET` decente:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Cambiarlo cierra la sesión de todos los asesores. Es lo esperable la primera vez.

## Ver qué está pasando

```bash
ssh root@107.170.72.128

systemctl status whatswv         # ¿está corriendo?
journalctl -u whatswv -f         # log en vivo
journalctl -u whatswv -n 200     # las últimas 200 líneas
systemctl restart whatswv        # reiniciar
```

La base duerme cuando no hay actividad, y el log lo dice. Que aparezcan estas líneas
es lo normal, no un error:

```
10 min sin actividad: dejo de consultar la base y Neon la puede apagar
la base cerro la conexion del lock: ...; se toma de nuevo al volver
hay actividad: vuelvo a revisar la base
```

Para ver si de verdad duerme: en Neon, la rama de producción muestra el cómputo como
*Idle* de noche, y el uso de horas del mes deja de subir a razón de 24 por día.

De Caddy y los certificados:

```bash
journalctl -u caddy -n 50
```

## Los archivos de los clientes

Las fotos y audios viven en `/opt/whatswv/almacen`, en el disco del servidor. No
están en la base, así que **no entran en el backup de Neon**. Si el droplet se
pierde, se pierden.

Copia a tu máquina:

```bash
rsync -az root@107.170.72.128:/opt/whatswv/almacen/ ./respaldo-almacen/
```

Vale la pena dejarlo en una tarea programada. Cuando el volumen crezca, lo
razonable es moverlo a un bucket (Spaces de DigitalOcean o S3) en vez de seguir
llenando el disco de 25 GB.

## Cosas que se pueden romper

**El certificado no sale.** Casi siempre es el DNS: el dominio todavía no apunta
a la IP, o apunta a Cloudflare con el proxy naranja encendido. Ponelo en gris
(DNS only) mientras Caddy saca el certificado.

**Meta deja de mandar webhooks.** Meta desactiva el callback si falla muchas
veces seguidas. `npm run webhook:estado` te dice si sigue activo; se vuelve a
activar con `npm run webhook:registrar`.

**El servicio se reinicia en bucle.** `journalctl -u whatswv -n 50` lo dice
siempre: casi siempre falta una variable en el `.env` o la base no responde.
La app valida la configuración al arrancar y sale con el motivo escrito.

## La app de Windows

El instalador se sirve desde el mismo servidor:

```
https://bandeja.chatwasvw.com/instalar/WhatsWV-Setup.exe
```

Ese enlace no cambia nunca, aunque salgan versiones nuevas.

### Sacar una version nueva

```bash
cd escritorio
npm run publicar -- 0.2.0
```

Compila, sube el instalador, el `latest.yml` y el `.blockmap` a `/srv/descargas`.
Las apps ya instaladas lo detectan solas —revisan al abrir y cada 4 horas—,
descargan en segundo plano y **se actualizan cuando el asesor cierra la app**.
Nunca en medio de una conversación.

### Por que el actualizador no usa GitHub

Con un repositorio **privado** habria que meterle un token de GitHub a la app, y
ese token termina en la maquina de cada asesor. Con uno **publico** habria que
publicar todo el codigo solo para poder bajar un `.exe`. El servidor del negocio
ya sirve el instalador por HTTPS y no necesita ninguna cuenta de por medio.

El codigo igual vive en GitHub, en un repositorio privado: sirve como respaldo e
historial, no como via de distribucion. Son dos cosas distintas.

### Ojo con el `.exe` firmado

El instalador no esta firmado, asi que Windows muestra "Windows protegio su PC"
en la primera instalacion. Hay que darle **Mas informacion -> Ejecutar de todas
formas**. Las actualizaciones posteriores ya no preguntan.

## Dos bases: desarrollo y produccion

Al principio el desarrollo y el servidor compartian la misma base de Neon. Eso
dejo de ser aceptable en cuanto entraron usuarios reales: las suites de
integracion **escriben**, y una de sus funciones —`vaciarBandejaDe`— le suelta a
un asesor todas las conversaciones que tenga encima. Corriendo las pruebas, un
cliente que estaba siendo atendido volvia a la cola sin que nadie entendiera por
que, y cada corrida dejaba cientos de contactos falsos ensuciando las metricas.

Ahora son dos ramas de Neon:

| | Endpoint | Quien la usa |
|---|---|---|
| **Produccion** | `ep-sparkling-heart-...` | `/opt/whatswv/.env` en el servidor |
| **Desarrollo** | `ep-cold-pine-...` | el `.env` de tu maquina |

El `.env` local apunta a desarrollo. El del servidor no se toca desde aca: se
edita por SSH. Hay una copia del de produccion en `.env.respaldo-produccion`,
ignorada por git.

Las cuentas de demostracion (`@repuestos.com`) viven **solo en desarrollo**: son
material de las pruebas, no personas. En produccion estan de baja.

Y hay una traba: las suites se niegan a correr contra algo que no sea localhost
salvo que se diga a mano con `PRUEBAS_EN_PRODUCCION=si`.

### Correr las pruebas

```bash
npm run build
PORT=3100 npm start           # servidor local contra la rama de desarrollo

PORT=3100 npm run test:smoke
PORT=3100 npm run test:realtime
PORT=3100 npm run test:asignacion
PORT=3100 npm run test:operacion
PORT=3100 npm run test:bot
PORT=3100 ADMIN_CLAVE_PRUEBAS=... ASESOR_CLAVE_PRUEBAS=... npm run test:admin
```

### Refrescar desarrollo con datos de produccion

Cuando la rama se aleje demasiado, en el panel de Neon se borra y se vuelve a
crear desde `main`. Es instantaneo y no cuesta nada. Despues hay que reactivar
las cuentas de demostracion, que en produccion figuran de baja.
