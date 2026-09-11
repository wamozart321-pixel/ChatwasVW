# Exportar los contactos y los chats de WhatsApp

Para migrar al número de la empresa sin perder quién es quién. Hace lo mismo que
las extensiones que cobran, y por el mismo camino.

## Instalar

### Pasarla a otro computador

```
npm run exportador:empaquetar
```

Deja `herramientas/salida/whatswv-exportar-1.0.0.zip`. Se copia, se descomprime
en un sitio donde se pueda quedar —si se borra la carpeta, la extensión deja de
funcionar— y se siguen los pasos del `INSTALAR.txt` que va adentro, que son los
mismos de abajo.

**No hay instalador de un clic.** Chrome y Opera bloquean instalar extensiones
desde un archivo desde 2014: sólo aceptan las de su tienda. Un `.crx` suelto no
se instala ni arrastrándolo. Las alternativas son publicarla en la Chrome Web
Store (5 dólares y revisión de Google, que para algo que lee WhatsApp puede
terminar en rechazo) o forzarla por política de Windows tocando el registro de
cada máquina. Para una migración que se hace una vez, cargarla a mano es lo
razonable.

### A mano

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

Arriba del panel hay tres opciones. Se leen al pulsar, así que se pueden cambiar
y volver a exportar.

- **Desde** — sólo los mensajes de esa fecha en adelante. Vacío trae todo. Para
  migrar rara vez hace falta más de un año, y acotarlo es lo que hace que esto
  pase de varios minutos a menos de uno.
- **Mensajes por chat** — *Todos* pide la conversación entera al celular;
  *Últimos 200* o *50* es mucho más rápido y suele alcanzar.
- **Sólo contactos guardados** — deja fuera a los desconocidos. En un número de
  trabajo la mitad de los chats son consultas de una sola vez.
- **Traer fotos, audios y documentos** — apagada por defecto. Al pulsar *Chats*
  pide una carpeta donde dejarlos y baja el archivo de cada mensaje. **Tarda
  bastante más**: cada archivo se le pide al celular de a uno, así que lo que en
  texto es un minuto puede ser media hora. Marcarla también hace que entren los
  chats de puras fotos, que sin ella quedaban en los omitidos.

Después:

- **Contactos (CSV)** → `whatswv-contactos.csv`, cosa de segundos.
- **Chats (JSON + CSV)** → `whatswv-chats.json` y `whatswv-chats.csv`, el mismo
  contenido. El importador lee el JSON; el CSV es para abrirlo y revisar qué
  trajo, una fila por mensaje —la última columna dice qué archivo le toca—.
  Tener el celular encendido y con internet: el panel va diciendo
  `pidiendo historial 34 de 103…`.
- Con los archivos marcados, además, la carpeta elegida queda con un archivo por
  mensaje, nombrado `telefono-segundo-n.ext`.

**Si se corta, se vuelve a pulsar y elige la misma carpeta.** En ella el panel va
dejando, chat por chat y a medida que avanza:

- `whatswv-chats.jsonl` — una línea por chat terminado. **Esto ya es importable
  tal cual**, así que una exportación cortada en el chat 400 no se pierde: entra
  completa hasta donde llegó.
- `whatswv-progreso.json` — qué chats ya salieron y con qué filtros.

Al volver a pulsar, esos chats se saltean sin volver a preguntarle al celular —que
es lo que tarda—, y sus mensajes se releen del `.jsonl` para que el archivo final
salga completo y no sólo con lo de la última vuelta. Si se cambian los filtros
—otra fecha, otro tope por chat— empieza de nuevo y avisa: las líneas viejas ya no
corresponden a lo que se está pidiendo.

Por eso, **de 300 chats para arriba pide la carpeta aunque no se marquen los
archivos**: ahí una corrida es de horas y perderla entera por un corte no es una
opción.

Dos archivos que el panel salta a propósito, y los cuenta al final:

- **El que no llega en 45 segundos.** Pedirle al celular una foto que ya no tiene
  puede no volver nunca, y sin ese tope una sola imagen congela la exportación
  entera. Vuelve a intentarse en la pasada siguiente.
- **El de más de 16 MB.** Es el tope de WhatsApp y el de la bandeja
  (`MEDIA_MAX_MB`): bajar un video de 40 MB es media hora de espera por algo que
  después no se puede ni reenviar.

Si el navegador no deja elegir carpeta, los archivos caen en Descargas de a uno y
Chrome pregunta una vez si permite varias descargas. Funciona, pero quedan
cientos de archivos sueltos: mejor la carpeta.

Al final de ese mismo CSV, después de un renglón en blanco, va la sección
**OMITIDOS**: los chats que no entraron y por qué.

```
OMITIDOS: 45 chats que no entraron
identificador,nombre,motivo
120363012345@g.us,,"no tiene telefono (grupo, canal o @lid)"
573001112222,Solo Fotos,"12 mensajes, ninguno de texto en el rango pedido"
573004445555,No Contesta,el celular no contesto: timeout
```

Salen menos chats de los que se ven en pantalla, y es normal: los grupos, los
canales, los estados y las conversaciones de puras fotos no tienen nada que
importar. Pero normal no es lo mismo que comprobado: al migrar el negocio hay
que bajar hasta esa sección y confirmar que ningún cliente se quedó por fuera.
De los tres motivos, el único que se arregla reintentando es el del celular.

El botón **Informe** es para cuando algo falla: copia al portapapeles qué
encontró —nombres de campos y cantidades, nunca contenido de mensajes—.

## Meterlos a la bandeja

```
npm run importar -- contactos ~/Downloads/whatswv-contactos.csv
npm run importar -- mensajes  ~/Downloads/archivos-wa
```

Pasándole **la carpeta** alcanza: busca adentro el `whatswv-chats.jsonl` (o el
`.json`) y toma los archivos de ahí mismo. El mismo teléfono en dos líneas —una
corrida que se cortó y se retomó— se junta en una sola conversación.

También sirven los archivos sueltos, y ahí la carpeta va aparte:

```
npm run importar -- mensajes ~/Downloads/whatswv-chats.json --archivos ~/Downloads/archivos-wa
```

Sin `--archivos` entra sólo el texto, y el importador avisa cuántos archivos se
está dejando afuera. Los que pasa los copia al almacén de la bandeja con la misma
forma que usa el servidor —`año/mes/uuid.ext`—, y el mensaje queda con su foto o su
documento como si hubiera llegado por WhatsApp.

Un mensaje que nombra un archivo que no está en la carpeta entra sin él (y se
cuenta al final): es lo que pasa si el celular se apagó a mitad de la
exportación. Reexportar y volver a importar lo completa; correrlo dos veces no
duplica nada ni vuelve a copiar los archivos.

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

- **Las fotos y los archivos viajan sólo si se marcan.** Sin la casilla es sólo
  texto, y de una foto con pie queda el pie. Con la casilla viajan la foto, el
  audio, el video y el documento, y el importador los mete al almacén.
- **Con `--produccion` hay un paso más.** La base es la del servidor, pero el
  disco es este: los archivos se copian a `respaldos/almacen-importado` y el
  importador imprime el `rsync` que los sube a `/opt/whatswv/almacen`. Sin ese
  paso la bandeja muestra los mensajes con la foto rota.
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
