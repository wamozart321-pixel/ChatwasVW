# Exportar los contactos y los chats de WhatsApp

Para migrar al número de la empresa sin perder quién es quién. Hace lo mismo que
las extensiones que cobran, leyendo lo que ya está en el computador.

## Cómo se usa

1. Abrir **web.whatsapp.com** en Chrome y esperar a que carguen los chats.
2. Abrir la consola: **F12** → pestaña **Console**.
3. Abrir `exportar-whatsapp.js`, copiar **todo**, pegarlo ahí y dar Enter.
4. Aparece un panel arriba a la derecha con dos botones.

Bajan `whatswv-contactos.csv` y `whatswv-chats.json` a la carpeta de descargas.

## Cómo entran a la bandeja

```
npm run importar -- contactos ~/Downloads/whatswv-contactos.csv
npm run importar -- mensajes  ~/Downloads/whatswv-chats.json
```

Sin `--de-verdad` sólo dicen qué harían. Revisar primero y después repetir el
comando con `--de-verdad`. Correrlo dos veces no duplica nada.

Para tocar el servidor y no la base de desarrollo, agregar `--produccion`.

## Lo que hay que saber antes

- **Los contactos salen completos. Los mensajes, no.** WhatsApp Web sólo guarda
  lo que fue sincronizando con el celular; los chats viejos que nadie ha abierto
  no están. Para que baje más de un cliente concreto: abrir ese chat, subir un
  rato hasta donde interese, y recién ahí exportar.
- **Es sólo texto.** Las fotos y los audios no viajan; de una foto con pie de
  texto queda el texto.
- **Lo importado entra como historial, no como conversación viva.** Queda
  resuelto y con la ventana cerrada, porque la ventana de 24 h la abre un
  mensaje real del cliente y no una fila que pongamos nosotros. En cuanto el
  cliente escriba, la conversación se abre normal.
- **No manda nada a ningún lado.** Lee la base local del navegador y arma un
  archivo. No habla con los servidores de WhatsApp ni con los nuestros.
- Si el panel dice que no encuentra la base, el botón **Ver qué hay** imprime en
  la consola los nombres que sí existen. Con eso se ajusta el script.
