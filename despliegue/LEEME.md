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
