# Exportar los contactos y los chats de WhatsApp

Para migrar al número de la empresa sin perder quién es quién. Hace lo mismo que
las extensiones que cobran, y por el mismo camino.

## Instalar

Es una extensión sin empaquetar. En **Opera**: `opera://extensions`. En
**Chrome**: `chrome://extensions`.

1. Activar **Modo de desarrollador** (arriba a la derecha).
2. **Cargar extensión sin empaquetar** y elegir la carpeta
   `herramientas/extension`.
3. Abrir **web.whatsapp.com** y esperar a que carguen los chats.

Aparece un panel verde arriba a la derecha. Mientras WhatsApp arranca dice
`esperando a que WhatsApp cargue…`; cuando termina, `Listo. WA-JS ve N chats.`

No hay que volver a cargarla: queda instalada y el panel sale solo cada vez.

## Sacar los archivos

- **Contactos (CSV)** → `whatswv-contactos.csv`, es cosa de segundos.
- **Chats (JSON)** → `whatswv-chats.json`. **Tarda.** Le pide la conversación
  entera al celular, uno por uno; con cien chats son varios minutos. El panel va
  diciendo `pidiendo historial 34 de 103…`. Tener el celular encendido y con
  internet.

## Meterlos a la bandeja

```
npm run importar -- contactos ~/Downloads/whatswv-contactos.csv
npm run importar -- mensajes  ~/Downloads/whatswv-chats.json
```

Sin `--de-verdad` sólo dicen qué harían. Revisar y repetir el comando con
`--de-verdad`. Correrlo dos veces no duplica nada.

Para tocar el servidor y no la base de desarrollo, agregar `--produccion`.

## Por qué es una extensión y no un script para pegar en la consola

El texto de los mensajes no está a la vista. En disco WhatsApp lo guarda
cifrado; en memoria sí está en claro, pero para llegar ahí hay que hablarle a
sus módulos internos, y WhatsApp ya no deja `require` ni `__d` como variables
globales: las crea y las borra durante el arranque.

Hay que estar **antes**. Una extensión corre en `document_start` y las atrapa;
un script pegado en la consola llega cuando ya no queda nada que enganchar. No
es cuestión de más código, es cuestión de cuándo se corre.

Pegar `extension/exportar-whatsapp.js` en la consola sigue sirviendo **para los
contactos**, que están sin cifrar en la base local del navegador.

## Lo que hay que saber

- **Es sólo texto.** Las fotos y los audios no viajan; de una foto con pie de
  texto queda el texto.
- **Lo importado entra como historial, no como conversación viva.** Queda
  resuelto y con la ventana cerrada, porque la ventana de 24 h la abre un
  mensaje real del cliente y no una fila que pongamos nosotros. En cuanto el
  cliente escriba, la conversación se abre normal.
- **No manda nada a ningún lado.** Lee la base local, le pregunta al celular por
  el historial del propio negocio, y arma un archivo.
- **No abrir el CSV en Excel para revisarlo.** Un teléfono de doce dígitos lo lee
  como cantidad y muestra `5,73002E+11`; si se guarda ahí, los dígitos del final
  se pierden de verdad. El archivo ya sale escrito para que Excel lo respete,
  pero lo seguro es pasarlo directo al importador.
- Si algo no cuadra, **Copiar informe** deja en el portapapeles qué encontró
  —nombres de campos y cantidades, nunca contenido de mensajes—.

## Terceros

`extension/vendor/` trae **WA-JS** de WPPConnect (Apache-2.0), que es la
librería que hace la parte difícil. Su licencia está al lado, sin modificar.
