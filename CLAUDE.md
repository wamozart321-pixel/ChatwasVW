# WhatsWV — lo que hay que saber antes de tocar algo

Bandeja compartida de WhatsApp para **7 asesores** de Repuestos Volkswagen Jhon Pardo,
en producción y en uso diario. El README explica el sistema; esto es lo que no se
deduce del código y cuesta caro olvidar.

## Dónde estás

- **En la nube** (claude.ai/code): no hay `.env`, ni acceso a las bases (Neon), ni a
  Meta, ni llave del servidor. No pidas que se carguen como variables de entorno: el
  entorno las deja legibles para cualquier comando. Se trabaja sobre el código, se
  verifica con lo de abajo, y se despliega con el botón.
- **En el computador del escritorio** (Windows): tiene todo lo anterior. El repo usa
  `autocrlf`; los `.sh` y el flujo de GitHub tienen que quedar con LF.

## Verificar un cambio

```bash
npx tsc --noEmit -p tsconfig.test.json   # servidor, scripts y pruebas
npm --prefix web run build               # la bandeja
npm run test:smoke                       # Postgres embebido: no necesita base
```

`test:realtime`, `test:asignacion`, `test:operacion`, `test:bot`, `test:admin` y
`test:dormir` necesitan servidor y base de desarrollo: sólo en el escritorio.

## Desplegar

- **Nunca en horario de atención**: L-V 8:30-17:30, sábados 8:30-14:00 (Bogotá).
  Desplegar reinicia el servicio unos segundos.
- **Siempre con confirmación explícita del dueño en ese momento.** No programes un
  despliegue para que corra solo.
- Desde la nube: los cambios van en una rama con pull request; lo aprueba el dueño y
  recién en `main` se despliega con el botón:
  ```bash
  gh workflow run desplegar.yml -f modo=probar      # compila y verifica, no toca nada
  gh workflow run desplegar.yml -f modo=desplegar   # fuera de horario
  gh run list --workflow=desplegar.yml --limit 3
  ```
- Desde el escritorio: `bash despliegue/subir.sh root@107.170.72.128` (o `--probar`).
- Ver `despliegue/LEEME.md`.

## Reglas que ya costaron algo

- **La base tiene que poder dormir.** Neon cobra —o descuenta de un tope mensual que
  al pasarse suspende la base— por hora prendida. Todo lo periódico que consulte la
  base pregunta antes a `ActividadService.reciente()` (`src/db/actividad.service.ts`).
  Un `setInterval` que consulte sin eso vuelve a dejarla prendida 24 h.
- **Las pruebas y `npm run simular` nunca contra producción.** Escriben conversaciones
  falsas y sueltan las asignadas. Están trabadas (`scripts/es-produccion.ts`); no se
  saca la traba para "probar rápido".
- **La base de desarrollo es temporal**: se borra al migrar los clientes. Después, los
  cambios menores van directo a producción, con más razón por la regla anterior.
- **Lo importado del celular es historial real** (`wamid.IMPORTADO…` y contactos sin
  conversación). `limpiar-pruebas` lo conserva; cualquier limpieza nueva también.
- **Los mensajes rápidos no pasan por Meta** (`web/src/componentes/mensajes-rapidos.ts`):
  los textos los escribe el negocio.
- **Plantillas de Meta**: se mandan menos de 200 al mes y casi siempre escribe primero
  el cliente, así que el precio por plantilla no es criterio de diseño.

## Estilo

- Todo en español: código, comentarios, mensajes de commit.
- Los comentarios explican **por qué**, con el caso que lo motivó; no qué hace la línea.
- Commits: `área: qué cambió` en minúscula, y un cuerpo en prosa con el porqué y cómo
  se probó. Mirar `git log` antes del primero.
- Probar de verdad antes de decir que algo anda, y decir qué no se pudo probar.
