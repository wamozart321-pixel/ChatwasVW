#!/usr/bin/env bash
#
# Prepara un Ubuntu 24.04 recién creado para correr WhatsWV.
#
#   ssh root@LA_IP
#   bash instalar.sh bandeja.tudominio.com
#
# Se corre UNA VEZ, como root. Después de esto, cada actualización se hace con
# despliegue/subir.sh desde la máquina de desarrollo; no hace falta volver acá.
#
# Deja andando: usuario propio sin privilegios, Node 22, servicio que arranca
# solo al prender el servidor, HTTPS con certificado que se renueva solo y
# firewall cerrado salvo lo necesario.
set -euo pipefail

DOMINIO="${1:-}"
if [ -z "$DOMINIO" ]; then
  echo "uso: bash instalar.sh bandeja.tudominio.com" >&2
  exit 1
fi

USUARIO=whatswv
DIRECTORIO=/opt/whatswv

echo "==> instalando WhatsWV en $DOMINIO"

# --- swap ---------------------------------------------------------------------
# El droplet de 1 GB no tiene swap. Sin esto, cualquier pico de memoria mata el
# proceso y systemd lo reinicia en medio de una conversación.
if ! swapon --show | grep -q .; then
  echo "==> creando 2 GB de swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Con swap disponible, Linux por defecto la usa demasiado pronto y todo se
  # vuelve lento. 10 la deja como red de contención, que es para lo que está.
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-whatswv.conf
fi

# --- paquetes -----------------------------------------------------------------
echo "==> actualizando el sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
# ffmpeg va con el resto: las notas de voz se graban en webm porque Chromium
# no sabe grabar OGG, y WhatsApp solo las muestra como nota de voz si son OGG
# con Opus. La conversion es un cambio de envase, no una recodificacion.
apt-get install -y -qq curl ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https ffmpeg

# --- Node 22 LTS --------------------------------------------------------------
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  echo "==> instalando Node 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

# --- Caddy --------------------------------------------------------------------
# Caddy y no nginx: saca y renueva el certificado de Let's Encrypt solo, sin
# certbot ni cron ni un renglón de configuración extra. Un servidor menos que
# se cae en tres meses porque nadie renovó nada.
if ! command -v caddy >/dev/null; then
  echo "==> instalando Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# --- usuario y carpetas -------------------------------------------------------
if ! id "$USUARIO" >/dev/null 2>&1; then
  echo "==> creando el usuario $USUARIO"
  # Sin shell de login: si alguien entra por la app, no consigue una terminal.
  useradd --system --create-home --home-dir "$DIRECTORIO" --shell /usr/sbin/nologin "$USUARIO"
fi

mkdir -p "$DIRECTORIO"/{dist,drizzle,almacen}
chown -R "$USUARIO:$USUARIO" "$DIRECTORIO"

# El instalador de Windows va FUERA de la carpeta de la app: useradd deja el
# home en 0750 y Caddy no puede atravesarlo. Aflojarle los permisos seria
# exponer el .env, que esta ahi adentro con todas las credenciales.
mkdir -p /srv/descargas
chmod 755 /srv/descargas

# --- servicio -----------------------------------------------------------------
echo "==> instalando el servicio"
cat > /etc/systemd/system/whatswv.service <<UNIDAD
[Unit]
Description=WhatsWV - bandeja compartida de WhatsApp
Documentation=https://$DOMINIO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USUARIO
WorkingDirectory=$DIRECTORIO
Environment=NODE_ENV=production
EnvironmentFile=$DIRECTORIO/.env
ExecStart=/usr/bin/node dist/main.js

# Que vuelva solo. Un servidor de atención al cliente que queda caído porque
# hubo un error suelto a las 3 de la mañana no sirve.
Restart=always
RestartSec=3

# Blindaje: el proceso no necesita nada del sistema salvo su propia carpeta.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DIRECTORIO/almacen
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=whatswv

[Install]
WantedBy=multi-user.target
UNIDAD

systemctl daemon-reload
systemctl enable whatswv >/dev/null

# --- Caddy: HTTPS + proxy -----------------------------------------------------
echo "==> configurando HTTPS para $DOMINIO"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMINIO {
	# El instalador de Windows, para que cada asesor lo baje de una direccion
	# en vez de andar pasandoselo por USB o por WhatsApp.
	handle_path /instalar/* {
		root * /srv/descargas
		file_server
	}

	# El webhook de Meta y la bandeja van al mismo proceso.
	handle {
		reverse_proxy 127.0.0.1:3000
	}

	# Los archivos que manda un cliente pueden ser grandes; el tope real lo
	# pone la app con MEDIA_MAX_MB, esto solo evita que Caddy corte antes.
	request_body {
		max_size 100MB
	}

	# El instalador queda fuera: comprimir 100 MB de ejecutable no ahorra nada
	# y le come la CPU al unico nucleo del servidor.
	@comprimible not path /instalar/*
	encode @comprimible gzip

	log {
		output file /var/log/caddy/whatswv.log {
			roll_size 20mb
			roll_keep 5
		}
	}
}
CADDY

mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy
systemctl reload caddy || systemctl restart caddy

# --- firewall -----------------------------------------------------------------
echo "==> cerrando el firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# El 3000 queda solo para adentro: a la app se llega por Caddy, con HTTPS.
echo ""
echo "listo."
echo ""
echo "Falta el archivo de configuración. Copiá tu .env a $DIRECTORIO/.env y ponele:"
echo ""
echo "    chown $USUARIO:$USUARIO $DIRECTORIO/.env"
echo "    chmod 600 $DIRECTORIO/.env"
echo ""
echo "Después, desde tu máquina:  bash despliegue/subir.sh root@ESTE_SERVIDOR"
echo ""
