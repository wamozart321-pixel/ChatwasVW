#!/usr/bin/env bash
#
# Sube una versión nueva al servidor.
#
#   bash despliegue/subir.sh root@159.65.1.2
#   bash despliegue/subir.sh root@159.65.1.2 --probar   compila y verifica, no sube nada
#
# Tambien lo corre el boton "Desplegar" de GitHub Actions
# (.github/workflows/desplegar.yml), para poder desplegar sin este computador.
#
# Compila acá y sube lo ya construido. En el servidor no se compila nada: un
# droplet de 1 GB no tiene memoria para un build de TypeScript, y aunque la
# tuviera, compilar en producción significa que el servidor puede quedar con
# algo distinto a lo que probaste.
set -euo pipefail

DESTINO="${1:-}"
if [ -z "$DESTINO" ]; then
  echo "uso: bash despliegue/subir.sh root@LA_IP [--probar]" >&2
  exit 1
fi

PROBAR=false
[ "${2:-}" = "--probar" ] && PROBAR=true

# La llave y como se verifica el servidor.
#
# En el computador del escritorio, como siempre: su llave, y el servidor se acepta
# sin preguntar. GitHub Actions pasa las dos cosas por variables: una llave propia
# que sale de un Secret, y la huella del servidor fijada en el flujo. Ahi si se
# verifica, porque el paquete sale de una maquina que no es nuestra hacia lo que
# conteste en esa IP, y sin verificar se lo entregaria a cualquiera que se hiciera
# pasar por el servidor.
LLAVE="${SSH_LLAVE:-$HOME/.ssh/whatswv}"
if [ -n "${SSH_CONOCIDOS:-}" ]; then
  SSH_OPC=(-i "$LLAVE" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$SSH_CONOCIDOS")
else
  SSH_OPC=(-i "$LLAVE" -o StrictHostKeyChecking=no)
fi

DIRECTORIO=/opt/whatswv
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

echo "==> compilando"
npm run build:todo

if [ ! -f dist/main.js ] || [ ! -f dist/public/index.html ]; then
  echo "el build quedó incompleto: falta dist/main.js o dist/public/index.html" >&2
  exit 1
fi

echo "==> armando el paquete"
PAQUETE="${TMPDIR:-/tmp}/whatswv-$$.tar.gz"
# package-lock va sí o sí: `npm ci` en el servidor tiene que instalar
# exactamente las versiones que probaste, no las que hubiera hoy.
tar -czf "$PAQUETE" dist drizzle package.json package-lock.json

if $PROBAR; then
  # Todo lo que puede fallar antes de tocar el servidor —compilar, empaquetar, la
  # llave, la huella— sin cambiar nada alla. Es lo que se corre de dia, en horario
  # de atencion, para saber que el despliegue de la noche va a andar.
  echo "==> probando la conexion (no se sube nada)"
  ssh "${SSH_OPC[@]}" "$DESTINO" 'test -f /opt/whatswv/.env && echo "    .env del servidor: esta" && echo "    servicio: $(systemctl is-active whatswv)" && echo "    node: $(node --version)" && echo "    disco: $(df -h / | tail -1 | tr -s " " | cut -d" " -f5) usado"'
  TAMANO="$(du -h "$PAQUETE" | cut -f1)"
  rm -f "$PAQUETE"
  echo ""
  echo "prueba ok: compila, empaqueta ($TAMANO) y el servidor contesta. No se cambio nada."
  exit 0
fi

echo "==> subiendo ($(du -h "$PAQUETE" | cut -f1))"
scp "${SSH_OPC[@]}" -q "$PAQUETE" "$DESTINO:/tmp/whatswv.tar.gz"
rm -f "$PAQUETE"

echo "==> instalando en el servidor"
ssh "${SSH_OPC[@]}" "$DESTINO" bash -euo pipefail <<REMOTO
DIRECTORIO=$DIRECTORIO

if [ ! -f "\$DIRECTORIO/.env" ]; then
  echo "falta \$DIRECTORIO/.env en el servidor: copialo antes de desplegar" >&2
  exit 1
fi

# Se descomprime aparte y recién al final se cambia: si algo falla, el servicio
# viejo sigue andando en vez de quedar a medio reemplazar.
rm -rf /tmp/whatswv-nuevo
mkdir -p /tmp/whatswv-nuevo
tar -xzf /tmp/whatswv.tar.gz -C /tmp/whatswv-nuevo

cd /tmp/whatswv-nuevo
echo "    instalando dependencias"
npm ci --omit=dev --no-audit --no-fund >/dev/null

echo "    aplicando migraciones"
# Antes de mover nada: si una migración falla, la versión vieja sigue en pie.
#
# Se copia el .env en vez de hacerle source: tiene valores con espacios
# (NEGOCIO_NOMBRE=Repuestos Volkswagen Jhon Pardo) y bash intentaría ejecutar
# "Volkswagen" como comando. El migrador lo lee solo con loadEnvFile().
cp "\$DIRECTORIO/.env" /tmp/whatswv-nuevo/.env
node dist/db/migrate.js
rm -f /tmp/whatswv-nuevo/.env

echo "    reemplazando la versión"
systemctl stop whatswv || true
rm -rf "\$DIRECTORIO/dist" "\$DIRECTORIO/drizzle" "\$DIRECTORIO/node_modules"
mv /tmp/whatswv-nuevo/dist "\$DIRECTORIO/dist"
mv /tmp/whatswv-nuevo/drizzle "\$DIRECTORIO/drizzle"
mv /tmp/whatswv-nuevo/node_modules "\$DIRECTORIO/node_modules"
cp /tmp/whatswv-nuevo/package.json "\$DIRECTORIO/package.json"
chown -R whatswv:whatswv "\$DIRECTORIO"

systemctl start whatswv
rm -rf /tmp/whatswv-nuevo /tmp/whatswv.tar.gz
REMOTO

echo "==> comprobando"
sleep 3
if ssh "${SSH_OPC[@]}" "$DESTINO" 'systemctl is-active --quiet whatswv'; then
  echo ""
  echo "desplegado. Últimas líneas del log:"
  ssh "${SSH_OPC[@]}" "$DESTINO" 'journalctl -u whatswv -n 12 --no-pager -o cat'
else
  echo ""
  echo "EL SERVICIO NO ARRANCÓ. Qué dice el log:" >&2
  ssh "${SSH_OPC[@]}" "$DESTINO" 'journalctl -u whatswv -n 40 --no-pager -o cat' >&2
  exit 1
fi
