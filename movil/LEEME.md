# App de Android

WhatsWV como app en el celular del asesor, para atender desde la calle o el
mostrador sin depender del computador.

## Qué es y qué no es

La app **no trae la bandeja adentro**: abre la que sirve
`https://bandeja.chatwasvw.com`, igual que la de Windows.

```
   ┌─────────────────────────┐
   │  WhatsWV.apk            │   el envoltorio: icono, permisos,
   │  (WebView de Capacitor) │   cámara, pantalla completa
   └───────────┬─────────────┘
               │  HTTPS
               ▼
   bandeja.chatwasvw.com        acá vive la bandeja de verdad
```

Eso importa por una razón práctica: **actualizar el servidor actualiza a los
siete asesores**. El `.apk` solo hay que repartirlo de nuevo si cambia el
envoltorio —permisos, ícono, la dirección del servidor—, que casi nunca pasa.
Si la app trajera el frontend adentro, cada asesor quedaría con la versión del
día que instaló.

## Armar el .apk

```
cd movil
npm install
npm run empaquetar
```

Queda en `movil/salida/WhatsWV.apk`. Se les pasa por WhatsApp o se sube al
servidor junto al instalador de Windows.

Hace falta:

- **JDK 21** — `winget install EclipseAdoptium.Temurin.21.JDK`.
  Con el 17 la compilación falla: Capacitor 7 pide 21.
- **SDK de Android** — viene con Android Studio. El script lo busca en
  `C:\Android\Sdk` y en la ruta de siempre de Android Studio.

## La firma

La primera corrida crea `movil/firma/`, con el certificado que identifica a la
app. **Ese directorio hay que respaldarlo.**

Si se pierde, un celular que ya tenga WhatsWV instalado no acepta la
actualización: Android la ve como otra app distinta y obliga a desinstalar
primero, con lo que el asesor pierde la sesión y hay que volver a entrar.

No está en git a propósito: con esa firma cualquiera podría publicar una
actualización que los teléfonos aceptarían como nuestra.

## Instalar en el celular

Android bloquea por defecto lo que no viene de Play Store. La primera vez, al
abrir el archivo, pide permiso para instalar desde esa app (el navegador o
WhatsApp) — hay que dárselo una vez.

## La cámara

El botón 📷 del redactor ofrece Foto o Video y abre la cámara del teléfono
directo, sin pasar por el explorador de archivos. Funciona porque el `<input>`
lleva `capture`, que Capacitor traduce a la cámara nativa de Android; los
permisos ya están declarados en `AndroidManifest.xml`.

En un computador ese mismo botón abre el selector de archivos, que es lo único
que puede hacer ahí.

## Cambiar el servidor

Está en `capacitor.config.json`, en `server.url`. Después de tocarlo basta con
`npm run empaquetar`: el empaquetado corre `cap sync` solo.
