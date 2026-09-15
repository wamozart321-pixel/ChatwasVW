#!/usr/bin/env bash
#
# Deja las dependencias listas en una sesión de Claude Code en la nube.
#
# Lo corre el hook SessionStart de .claude/settings.json cada vez que una sesión
# arranca o se retoma. En la nube el repositorio llega recién clonado, sin
# node_modules, y sin ellas no compila ni corre una sola prueba.
#
# En este computador no hace nada y no imprime nada: las dependencias ya están, y
# lo que un hook de arranque imprime le llega a Claude como contexto, así que un
# "no hice nada" en cada sesión local sería ruido.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

LOG="${TMPDIR:-/tmp}/instalar-nube.log"
: > "$LOG"

instalar() {
  local donde="$1"
  # Retomar una sesión no reinstala: con node_modules presente se sigue de largo.
  [ -d "$donde/node_modules" ] && return 0

  if ! npm ci --prefix "$donde" --no-audit --no-fund >>"$LOG" 2>&1; then
    # Sin salir con error: un hook de arranque que falla no frena la sesión, y
    # así Claude ve qué pasó y puede reintentarlo en vez de encontrarse todo roto.
    echo "No se pudieron instalar las dependencias de $donde. Últimas líneas de $LOG:"
    tail -15 "$LOG"
    return 1
  fi
}

if instalar . && instalar web; then
  echo "Sesión en la nube: dependencias listas (servidor y web). No hay .env ni acceso a las bases ni a Meta; ver CLAUDE.md."
fi

exit 0
