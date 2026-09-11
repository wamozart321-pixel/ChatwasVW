/**
 * Saca los contactos y el historial de WhatsApp Web para pasarlos a la bandeja.
 *
 * Se instala como extensión: ver `herramientas/LEEME.md`. También se puede
 * pegar en la consola del navegador, pero así sólo salen los contactos —abajo
 * está el porqué—.
 *
 * Lo que baja se le pasa al importador:
 *
 *   npm run importar -- contactos whatswv-contactos.csv
 *   npm run importar -- mensajes whatswv-chats.json
 *   npm run importar -- mensajes whatswv-chats.json --archivos <carpeta>
 *
 * Las fotos, los audios y los documentos son aparte y van apagados: cada archivo
 * se le pide al celular de a uno, asi que una exportacion de un minuto en texto
 * puede ser media hora con archivos. Con la casilla marcada, el panel pide una
 * carpeta y deja ahi un archivo por mensaje; el JSON guarda el nombre de cada uno
 * y el importador los copia al almacen de la bandeja.
 *
 * ---
 *
 * Por qué esto es una extensión y no un script pegado en la consola.
 *
 * El texto de los mensajes no está a la vista en ningún lado. En disco,
 * WhatsApp lo guarda cifrado dentro de `msgRowOpaqueData`. En memoria sí está
 * en claro, pero para llegar ahí hay que hablarle a los módulos internos de la
 * página, y WhatsApp ya no deja `require` ni `__d` como variables globales: los
 * define y los borra durante el arranque.
 *
 * O sea que hay que estar ANTES. Una extensión puede correr en `document_start`
 * y poner una trampa antes de que WhatsApp cree esas variables; un script
 * pegado en la consola llega cuando ya no queda nada que enganchar. Eso no se
 * arregla con más código, es cuestión de cuándo se corre.
 *
 * De eso se encarga WA-JS (`vendor/`), que es la librería que hace la parte
 * difícil y la que usan por dentro las extensiones que cobran por esto.
 *
 * Y ya estando adentro, se puede pedir más que el historial en pantalla:
 * `getMessages` con `count: -1` le PIDE la conversación entera al celular.
 *
 * ---
 *
 * Los contactos salen por otro lado y por eso funcionan igual desde la consola:
 * están sin cifrar en IndexedDB, la base del propio navegador. Se recorren
 * todas sus tiendas y cada una se clasifica MIRANDO UN REGISTRO, no por cómo se
 * llama: WhatsApp reparte sus datos en catorce bases y les cambia el nombre
 * entre versiones.
 *
 * Esto NO manda nada a ningún lado: lee lo que ya está en este computador, le
 * pregunta al celular por el historial del propio negocio, y arma un archivo.
 */
(() => {
  const ID_PANEL = 'whatswv-exportador';

  // --- entender un registro ---------------------------------------------------

  /** El identificador puede venir como texto o como objeto, segun la version. */
  function comoTexto(id) {
    if (typeof id === 'string') return id;
    if (id && typeof id === 'object') return id._serialized || id.id || '';
    return '';
  }

  /** El identificador de una fila, venga en el campo `id` o en la clave. */
  function idDe(fila, clave) {
    return comoTexto(fila?.id) || comoTexto(clave) || comoTexto(fila?.key);
  }

  /**
   * El telefono de un jid, o null si no es una persona.
   *
   * Quedan fuera los grupos (@g.us), los estados, los canales y los @lid, que
   * son los identificadores nuevos que WhatsApp usa para tapar el numero: de
   * esos no se puede sacar telefono, y meterlos daria contactos imposibles de
   * contactar.
   */
  function telefonoDe(jid) {
    if (!jid || !/@(c\.us|s\.whatsapp\.net)$/.test(jid)) return null;
    const digitos = jid.split('@')[0].replace(/\D/g, '');
    return digitos.length >= 8 ? digitos : null;
  }

  const NOMBRES = [
    'name',
    'saved_name',
    'verifiedName',
    'pushname',
    'notify',
    'formattedName',
    'formattedTitle',
    'shortName',
  ];

  function nombreDe(fila) {
    for (const campo of NOMBRES) {
      const v = fila?.[campo];
      // Un "nombre" que es el propio numero no es un nombre: asi deja WhatsApp
      // a los contactos que no estan en la agenda.
      if (typeof v === 'string' && v.trim() && !/^\+?[\d\s()-]+$/.test(v.trim())) {
        return v.trim();
      }
    }
    return null;
  }

  /**
   * De qué chat es un mensaje y quién lo mandó.
   *
   * Hay tres formas de saberlo y WhatsApp usa las tres según la versión, así
   * que se prueban todas. La primera versión de esto sólo miraba la primera y
   * daba cero mensajes sin decir por qué:
   *
   *   1. El identificador de texto "<mio>_<jid del chat>_<id>".
   *   2. El identificador como objeto, con `remote` y `fromMe` adentro. Ojo:
   *      ahí `id.id` es sólo la última parte, así que leerlo como texto da algo
   *      sin guiones bajos que no parece un mensaje.
   *   3. Los campos sueltos `from`/`to` con `fromMe`.
   */
  function deQuienEs(fila, clave) {
    // Como objeto.
    for (const candidato of [fila?.id, clave, fila?.key]) {
      if (candidato && typeof candidato === 'object' && candidato.remote) {
        return { mio: candidato.fromMe === true, jid: comoTexto(candidato.remote) };
      }
    }

    // Como texto, venga donde venga.
    for (const candidato of [fila?.id, clave, fila?.key]) {
      const partes = comoTexto(candidato).split('_');
      if (partes.length >= 3 && (partes[0] === 'true' || partes[0] === 'false')) {
        if (partes[1].includes('@')) return { mio: partes[0] === 'true', jid: partes[1] };
      }
    }

    // Campos sueltos.
    const mio = fila?.fromMe === true || fila?.key?.fromMe === true;
    const jid = comoTexto(fila?.remote ?? fila?.chatId ?? (mio ? fila?.to : fila?.from));
    if (jid.includes('@')) return { mio, jid };

    return null;
  }

  /** Cuándo se mandó, en segundos. WhatsApp lo guarda en `t`. */
  function cuandoDe(fila) {
    const s = Number(fila?.t ?? fila?.timestamp ?? fila?.messageTimestamp);
    return Number.isFinite(s) && s > 0 ? s : null;
  }

  /** El texto de un mensaje: el cuerpo, o el pie de foto si es multimedia. */
  function textoDe(fila) {
    const t = fila?.body ?? fila?.caption ?? fila?.text ?? '';
    return typeof t === 'string' ? t.trim() : '';
  }

  /**
   * Que clase de archivo trae un mensaje, o null si es solo texto.
   *
   * WhatsApp llama "ptt" a la nota de voz —push to talk—, que para la bandeja es
   * un audio como cualquier otro. Lo demas pasa con el mismo nombre.
   */
  const CLASES = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    ptt: 'audio',
    document: 'document',
    sticker: 'sticker',
  };

  function claseDe(fila) {
    const t = String(fila?.type ?? '').toLowerCase();
    return CLASES[t] ?? null;
  }

  /**
   * La extension del archivo, a partir del mime.
   *
   * Las mismas que entiende el almacen de la bandeja. Si el mime no esta en la
   * tabla se prueba con el nombre original —los documentos lo traen— y si
   * tampoco, queda .bin: el importador mira el mime, no la extension, asi que
   * un .bin entra igual. Es para que la carpeta se pueda mirar.
   */
  const EXTENSIONES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };

  function extensionDe(mime, nombre) {
    const limpio = String(mime ?? '').split(';')[0].trim().toLowerCase();
    if (EXTENSIONES[limpio]) return EXTENSIONES[limpio];

    const delNombre = String(nombre ?? '').split('.').pop();
    if (delNombre && delNombre.length <= 5 && /^[a-z0-9]+$/i.test(delNombre)) {
      return delNombre.toLowerCase();
    }
    return 'bin';
  }

  // --- recorrer las bases -----------------------------------------------------

  function abrir(nombre) {
    return new Promise((ok) => {
      let listo = false;
      const p = indexedDB.open(nombre);
      p.onsuccess = () => {
        listo = true;
        ok(p.result);
      };
      p.onerror = () => ok(null);
      // Si otra pestana tiene la base abierta con otra version, `open` se queda
      // esperando para siempre y el panel nunca responderia.
      p.onblocked = () => ok(null);
      setTimeout(() => listo || ok(null), 4000);
    });
  }

  /**
   * Recorre una tienda con un cursor.
   *
   * Con cursor y no con getAll(): la tienda de mensajes de un numero de trabajo
   * puede tener cientos de miles de filas, y getAll() las arma todas en memoria
   * de golpe y cuelga la pestana. `tope` corta antes, para las muestras.
   */
  function recorrer(db, tienda, porCada, tope) {
    return new Promise((ok) => {
      let t;
      try {
        t = db.transaction(tienda, 'readonly');
      } catch {
        return ok(0);
      }

      const p = t.objectStore(tienda).openCursor();
      let n = 0;

      p.onsuccess = () => {
        const cursor = p.result;
        if (!cursor) return ok(n);
        n++;
        try {
          porCada(cursor.value, cursor.key);
        } catch {
          /* una fila rara no puede tumbar la exportacion entera */
        }
        if (tope && n >= tope) return ok(n);
        cursor.continue();
      };

      p.onerror = () => ok(n);
      t.onerror = () => ok(n);
    });
  }

  async function muestraDe(db, tienda, cuantos) {
    const filas = [];
    await recorrer(db, tienda, (fila, clave) => filas.push({ fila, clave }), cuantos);
    return filas;
  }

  /**
   * Qué guarda una tienda, mirando lo que hay adentro.
   *
   * Por el contenido y no por el nombre: WhatsApp reparte los datos en varias
   * bases y les cambia el nombre entre versiones. La primera version de esto se
   * quedaba con la primera base que tuviera contactos y no seguia buscando la de
   * mensajes, asi que el archivo de chats salia vacio sin decir por que.
   */
  function clasificar(muestra) {
    let contactos = 0;
    let mensajes = 0;

    for (const { fila, clave } of muestra) {
      if (deQuienEs(fila, clave) && cuandoDe(fila) !== null) {
        mensajes++;
      } else if (idDe(fila, clave).includes('@')) {
        contactos++;
      }
    }

    if (mensajes > 0) return 'mensaje';
    if (contactos > 0) return 'contacto';
    return null;
  }

  /**
   * Todas las tiendas de todas las bases, ya clasificadas.
   *
   * Las bases quedan abiertas: cerrarlas aca obligaria a volver a abrirlas para
   * exportar, y entre una cosa y otra la pagina puede subir la version y dejar
   * el `open` esperando.
   */
  async function inventario() {
    const bases = (await indexedDB.databases().catch(() => [])) ?? [];
    const tiendas = [];

    for (const { name } of bases) {
      if (!name) continue;
      const db = await abrir(name);
      if (!db) {
        tiendas.push({ base: name, tienda: '(no se pudo abrir)', clase: null, muestra: 0 });
        continue;
      }

      for (const tienda of [...db.objectStoreNames]) {
        const muestra = await muestraDe(db, tienda, 40);
        tiendas.push({
          db,
          base: name,
          tienda,
          clase: clasificar(muestra),
          muestra: muestra.length,
          ejemplo: muestra[0] ?? null,
        });
      }
    }

    return tiendas;
  }

  /** La tienda de cada clase: la que traiga registros de esa clase. */
  function elegir(tiendas, clase) {
    return tiendas.find((t) => t.clase === clase && t.muestra > 0) ?? null;
  }

  // --- armar los archivos -----------------------------------------------------

  /** Una celda de CSV. Entre comillas si trae coma, comilla o salto de linea. */
  function celda(valor) {
    const t = String(valor ?? '');
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  /**
   * El telefono, escrito para que Excel no lo arruine.
   *
   * Un numero de doce digitos lo lee como cantidad y lo muestra 5,73002E+11: al
   * guardar, los digitos del final se pierden de verdad y el telefono queda
   * inservible. La formula ="..." es la manera de decirle que eso es texto.
   * El importador quita todo lo que no sea digito, asi que le da igual.
   */
  function celdaTelefono(telefono) {
    return '="' + telefono + '"';
  }

  function bajar(nombre, contenido, tipo) {
    const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /**
   * Deja un archivo en la carpeta que eligio el asesor.
   *
   * Con carpeta se escribe directo al disco y de a uno: un ZIP en memoria con un
   * ano de fotos son cientos de megas en RAM y el navegador se cae justo al
   * final, despues de veinte minutos de trabajo.
   *
   * Sin carpeta —navegador viejo— cae en Descargas como una bajada mas. Funciona,
   * pero Chrome pregunta una vez si permite varias descargas y quedan cientos de
   * archivos sueltos ahi: por eso la carpeta es el camino bueno.
   */
  async function escribirArchivo(carpeta, nombre, blob) {
    if (!carpeta) {
      bajar(nombre, blob, blob.type || 'application/octet-stream');
      return;
    }

    const handle = await carpeta.getFileHandle(nombre, { create: true });
    const escritor = await handle.createWritable();
    await escritor.write(blob);
    await escritor.close();
  }

  /** Lo que se espera por un archivo antes de darlo por perdido. */
  const TOPE_ESPERA = 45_000;

  /** Mas grande que esto no se pide: ver POR QUE abajo. */
  const TOPE_BYTES = 16 * 1024 * 1024;

  /**
   * Espera algo con tope de tiempo.
   *
   * `downloadMedia` le pide al celular la media que este computador no tiene, y
   * eso puede no volver NUNCA: el celular sin datos, en otra red, o WhatsApp que
   * ya no guarda ese archivo. Sin tope, una sola foto congela la exportacion
   * entera — y con cinco mil chats eso es perder horas de trabajo por un archivo
   * que al final no importaba.
   *
   * El archivo que no llega se cuenta y se sigue. Reexportar despues lo reintenta,
   * porque los nombres son calculados y lo que ya salio no se vuelve a bajar.
   */
  function conTope(promesa, ms, que) {
    let reloj;
    const tope = new Promise((_, falla) => {
      reloj = setTimeout(
        () => falla(new Error('no llego en ' + Math.round(ms / 1000) + ' s (' + que + ')')),
        ms,
      );
    });

    return Promise.race([promesa, tope]).finally(() => clearTimeout(reloj));
  }

  /** El peso del archivo de un mensaje, si el modelo lo dice. */
  function tamanoDe(fila) {
    const n = Number(fila?.size ?? fila?.mediaData?.fullFileSize ?? fila?.filehash?.size ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * El peso del archivo que ya este en la carpeta, o 0 si no esta.
   *
   * Esto es lo que hace que reintentar sirva. Los nombres son calculados, asi que
   * al volver a correr la exportacion despues de un corte —una foto que no llego,
   * WhatsApp Web desconectado, el computador dormido— lo que ya se bajo no se
   * vuelve a pedir: la segunda pasada arranca donde quedo la primera, y a cinco
   * mil chats esa es la diferencia entre retomar y empezar de cero.
   */
  async function pesoSiYaEsta(carpeta, nombre) {
    if (!carpeta || !nombre) return 0;

    try {
      const handle = await carpeta.getFileHandle(nombre);
      const archivo = await handle.getFile();
      return archivo.size > 0 ? archivo.size : 0;
    } catch {
      // No esta, o la carpeta ya no deja mirar: se baja igual.
      return 0;
    }
  }

  /**
   * Pide la carpeta donde dejar los archivos.
   *
   * Tiene que correr con el gesto del usuario todavia fresco —el clic del boton—,
   * asi que se llama antes de cualquier espera. Si el asesor cancela, se exporta
   * el texto y nada mas: caer en cientos de descargas sueltas porque cerro un
   * dialogo no es lo que pidio.
   */
  async function pedirCarpeta(avisar) {
    if (!window.showDirectoryPicker) {
      avisar('Este navegador no deja elegir carpeta: los archivos van a Descargas.');
      return { carpeta: null, archivos: true };
    }

    try {
      const carpeta = await window.showDirectoryPicker({
        id: 'whatswv-archivos',
        mode: 'readwrite',
      });
      return { carpeta, archivos: true };
    } catch {
      avisar('Sin carpeta: exporto solo el texto.');
      return { carpeta: null, archivos: false };
    }
  }

  async function sacarContactos(fuentes, avisar, opciones) {
    if (!fuentes.contacto) throw new Error('no encontre ninguna tienda de contactos');

    const porTelefono = new Map();

    for (const t of fuentes.todosContactos) {
      await recorrer(t.db, t.tienda, (fila, clave) => {
        const telefono = telefonoDe(idDe(fila, clave));
        if (!telefono) return;
        if (opciones.soloGuardados && fila?.isAddressBookContact !== true) return;

        const nombre = nombreDe(fila);
        // Si el mismo numero aparece en dos tiendas, gana el que traiga nombre.
        if (!porTelefono.has(telefono) || (nombre && !porTelefono.get(telefono))) {
          porTelefono.set(telefono, nombre);
        }
      });
    }

    const conNombre = [...porTelefono.values()].filter(Boolean).length;
    avisar(`${porTelefono.size} contactos (${conNombre} con nombre)`);

    const filas = ['telefono,nombre'];
    for (const [telefono, nombre] of porTelefono) {
      filas.push(celdaTelefono(telefono) + ',' + celda(nombre ?? ''));
    }

    // El caracter invisible del principio es para que Excel abra el archivo como
    // UTF-8; sin el muestra "salÃ³n" donde dice "salón".
    bajar('whatswv-contactos.csv', '\ufeff' + filas.join('\n') + '\n', 'text/csv;charset=utf-8');
    return porTelefono.size;
  }

  /** Los teléfonos que están en la agenda del teléfono. */
  async function telefonosDeLaAgenda(fuentes) {
    const agenda = new Set();

    for (const t of fuentes.todosContactos) {
      await recorrer(t.db, t.tienda, (fila, clave) => {
        if (fila?.isAddressBookContact !== true && fila?.isMyContact !== true) return;
        const telefono = telefonoDe(idDe(fila, clave)) ?? telefonoSuelto(fila?.phoneNumber);
        if (telefono) agenda.add(telefono);
      });
    }

    for (const c of modelosDe(waJs()?.whatsapp?.ContactStore)) {
      if (c?.isMyContact !== true && c?.isAddressBookContact !== true) continue;
      const telefono = telefonoDe(comoTexto(c.id)) ?? telefonoSuelto(comoTexto(c.phoneNumber));
      if (telefono) agenda.add(telefono);
    }

    return agenda;
  }

  async function sacarChats(fuentes, avisar, opciones) {
    if (!fuentes.mensaje) {
      throw new Error(
        'no encontre ninguna tienda de mensajes. Pulsa "Copiar informe" y pasame lo que salga',
      );
    }

    // Los nombres salen de los contactos, que es donde estan bien.
    const nombres = new Map();
    for (const t of fuentes.todosContactos) {
      await recorrer(t.db, t.tienda, (fila, clave) => {
        const telefono = telefonoDe(idDe(fila, clave));
        const nombre = nombreDe(fila);
        if (telefono && nombre && !nombres.has(telefono)) nombres.set(telefono, nombre);
      });
    }

    /*
     * Primera pasada: juntar las filas.
     *
     * En dos pasadas y no en una porque descifrar es asincrono y el recorrido
     * del cursor no lo es: si se espera dentro del recorrido, la transaccion de
     * IndexedDB se cierra sola y el resto de las filas se pierde.
     */
    const crudos = [];
    let leidos = 0;
    let ultimoAviso = 0;

    for (const t of fuentes.todosMensajes) {
      await recorrer(t.db, t.tienda, (fila, clave) => {
        leidos++;
        if (leidos - ultimoAviso >= 5000) {
          ultimoAviso = leidos;
          avisar(`${leidos.toLocaleString('es')} filas leidas…`);
        }

        const de = deQuienEs(fila, clave);
        const segundos = cuandoDe(fila);
        if (!de || !segundos) return;

        const telefono = telefonoDe(de.jid);
        if (!telefono) return;

        crudos.push({
          telefono,
          mio: de.mio,
          segundos,
          texto: textoDe(fila),
          opaco: fila?.msgRowOpaqueData ?? null,
        });
      });
    }

    /*
     * Lo que WhatsApp tenga en memoria, que ya viene en claro.
     *
     * Se suma en vez de reemplazar: en memoria esta lo que el usuario abrio en
     * esta sesion, y en disco esta todo lo sincronizado. Ninguna de las dos
     * tiene lo que tiene la otra. Los repetidos se quitan mas abajo.
     */
    // Lo mejor primero: WA-JS le pide el historial al celular.
    const waJsDio = await mensajesDeWaJs(avisar, opciones);
    if (waJsDio.mensajes.length) {
      avisar(`${waJsDio.mensajes.length.toLocaleString('es')} mensajes desde WA-JS`);
      crudos.push(...waJsDio.mensajes);
      for (const [telefono, nombre] of nombresDeWaJs()) {
        if (!nombres.has(telefono)) nombres.set(telefono, nombre);
      }
    }

    // Y lo que haya en memoria por el enganche propio, si es que alcanzo.
    const enClaro = mensajesDeWhatsApp();
    if (enClaro.length) {
      avisar(`${enClaro.length.toLocaleString('es')} mensajes en claro desde WhatsApp`);
      crudos.push(...enClaro);
    }

    /*
     * Segunda pasada: abrir los que traen el texto cifrado.
     *
     * Sólo si WA-JS no dio nada. Cuando dio, ya trae el historial COMPLETO
     * pedido al celular, que incluye todo lo que hay en disco; ponerse a
     * descifrar miles de filas ahí es trabajo tirado, y se nota.
     */
    const cerrados = waJsDio.mensajes.length ? [] : crudos.filter((c) => !c.texto && c.opaco);
    let abiertos = 0;
    let fallos = 0;
    let primerFallo = null;

    if (cerrados.length) {
      const llaves = await cargarLlaves(fuentes.tiendas);
      avisar(`descifrando ${cerrados.length.toLocaleString('es')} mensajes…`);

      for (let i = 0; i < cerrados.length; i++) {
        if (i % 500 === 0) {
          avisar(`descifrando ${i.toLocaleString('es')} de ${cerrados.length.toLocaleString('es')}…`);
        }

        try {
          const texto = buscarTexto(await abrirOpaco(cerrados[i].opaco, llaves));
          if (texto) {
            cerrados[i].texto = texto;
            abiertos++;
          } else {
            fallos++;
          }
        } catch (e) {
          fallos++;
          if (!primerFallo) primerFallo = e;
        }
      }

      if (primerFallo) console.error('[whatswv] primer fallo al descifrar:', primerFallo);
      console.log(`[whatswv] descifrados ${abiertos}, fallidos ${fallos}`);
    }

    /*
     * Los filtros valen para todo lo juntado, venga de donde venga.
     *
     * WA-JS ya los aplica al pedir, para no preguntarle al celular de mas, pero
     * la copia en disco no pasa por ahi: sin esto, un chat descartado por estar
     * fuera de la agenda volvia a entrar por el otro lado, y el archivo no
     * correspondia con lo que decia el panel.
     */
    const agenda = opciones.soloGuardados ? await telefonosDeLaAgenda(fuentes) : null;

    const filtrados = crudos.filter((c) => {
      if (opciones.desde && c.segundos < opciones.desde) return false;
      if (agenda && !agenda.has(c.telefono)) return false;
      return true;
    });

    // El mismo mensaje puede venir por las dos vias: se queda una sola copia.
    // La huella es telefono+segundo+quien+texto, que es lo mismo con que el
    // importador decide si ya lo tiene.
    const chats = new Map();
    const vistos = new Set();

    for (const c of filtrados) {
      // Un mensaje sin texto entra si trae archivo: la foto es el mensaje, y el
      // texto —cuando hay— es su pie.
      if (!c.texto && !c.archivo) continue;

      const huella = `${c.telefono}|${c.segundos}|${c.mio}|${c.texto}|${c.archivo?.nombre ?? ''}`;
      if (vistos.has(huella)) continue;
      vistos.add(huella);

      if (!chats.has(c.telefono)) chats.set(c.telefono, []);
      chats.get(c.telefono).push({
        cuando: new Date(c.segundos * 1000).toISOString(),
        mio: c.mio,
        texto: c.texto,
        // Solo cuando hay: un `archivo: null` en cada mensaje engorda el JSON
        // y no dice nada.
        ...(c.archivo ? { archivo: c.archivo } : {}),
      });
    }

    const salida = [];
    for (const [telefono, mensajes] of chats) {
      mensajes.sort((a, b) => a.cuando.localeCompare(b.cuando));
      salida.push({ telefono, nombre: nombres.get(telefono) ?? null, mensajes });
    }

    // Primero los que mas conversacion tienen: si el archivo hay que revisarlo a
    // mano, lo que importa esta arriba.
    salida.sort((a, b) => b.mensajes.length - a.mensajes.length);

    const conArchivo = filtrados.filter((c) => c.archivo).length;

    avisar(
      `${salida.length} chats de ${leidos.toLocaleString('es')} filas` +
        (abiertos ? `, ${abiertos.toLocaleString('es')} descifrados` : '') +
        (fallos ? ` (${fallos.toLocaleString('es')} no se pudieron abrir)` : '') +
        (conArchivo ? `, ${conArchivo} con archivo` : ''),
    );

    bajar(
      'whatswv-chats.json',
      JSON.stringify({ exportado: new Date().toISOString(), chats: salida }, null, 1),
      'application/json',
    );

    /*
     * El mismo contenido en CSV, para poder mirarlo.
     *
     * El importador lee el JSON, que no tiene ambiguedades; esto es para abrirlo
     * y revisar que trajo antes de meterlo a la bandeja. Una fila por mensaje.
     */
    const filas = ['telefono,nombre,cuando,quien,texto,archivo'];
    for (const chat of salida) {
      for (const m of chat.mensajes) {
        filas.push(
          [
            celdaTelefono(chat.telefono),
            celda(chat.nombre ?? ''),
            celda(m.cuando),
            m.mio ? 'nosotros' : 'cliente',
            celda(m.texto),
            celda(m.archivo?.nombre ?? ''),
          ].join(','),
        );
      }
    }
    /*
     * Los que no entraron, al final del mismo archivo.
     *
     * En un archivo aparte era una descarga mas que se queda sin abrir. Acá va
     * pegado a lo que sí entró, que es donde uno se hace la pregunta: salieron
     * 58 de 103, ¿y los otros? La respuesta está dos renglones más abajo.
     *
     * Se rellena hasta cinco columnas para que la hoja de cálculo no parta la
     * tabla en dos al ver renglones de distinto ancho.
     */
    const omitidos = waJsDio.omitidos ?? [];

    if (omitidos.length) {
      filas.push('', `OMITIDOS: ${omitidos.length} chats que no entraron,,,,,`);
      filas.push('identificador,nombre,motivo,,,');
      for (const o of omitidos) {
        filas.push([celda(o.id), celda(o.nombre), celda(o.motivo), '', '', ''].join(','));
      }
    }

    const SALTO = String.fromCharCode(10);
    const MARCA_EXCEL = String.fromCharCode(0xfeff);
    bajar(
      'whatswv-chats.csv',
      MARCA_EXCEL + filas.join(SALTO) + SALTO,
      'text/csv;charset=utf-8',
    );

    // Si no salio nada, el porque va en el panel: sin eso "0 chats" no dice si
    // fallo la busqueda, los telefonos o el celular.
    if (salida.length === 0) avisar(`0 chats. ${waJsDio.nota}`);

    return {
      chats: salida.length,
      archivos: waJsDio.bajados ?? 0,
      sinBajar: waJsDio.sinBajar ?? 0,
      grandes: waJsDio.grandes ?? 0,
    };
  }


  // --- pedirle los mensajes a WhatsApp ----------------------------------------

  /*
   * La otra vía, cuando el descifrado de la copia en disco no da.
   *
   * En vez de abrir la caja, se le piden los mensajes al propio código de
   * WhatsApp: la aplicación ya tiene la llave y descifra cada mensaje para
   * dibujarlo en pantalla, así que sus modelos en memoria están en claro.
   *
   * Es lo que hacen las extensiones, y es frágil a propósito de WhatsApp: el
   * código va empaquetado y minificado, y cada despliegue renumera los módulos.
   * Por eso NO se busca un módulo por su número ni por su nombre, sino que se
   * recorren todos y se reconoce la colección por lo que tiene adentro. Un
   * número de módulo dura semanas; que la colección de mensajes contenga
   * mensajes dura mientras WhatsApp sea WhatsApp.
   */

  /*
   * La vía buena: WA-JS, si está en la página.
   *
   * `window.WPP` es WA-JS (WPPConnect), una librería libre que habla con los
   * módulos internos de WhatsApp. La pone cualquier extensión de estas que esté
   * instalada, porque se inyecta al ARRANCAR la página.
   *
   * Y ahí está el porqué de que enganchar los módulos a mano no funcione desde
   * la consola: WhatsApp ya no deja `require` ni `__d` como variables globales.
   * WA-JS los atrapa poniendo una trampa ANTES de que la página los cree y los
   * borre. Un script pegado en la consola llega tarde; a esa altura ya no hay
   * nada que enganchar. No es algo que se arregle con más código.
   *
   * A cambio, esta vía es la mejor de todas: `getMessages` con `count: -1` no
   * devuelve lo que haya en caché, sino que le PIDE el historial al celular.
   */

  /** WA-JS, si alguna extensión ya lo dejó en la página. */
  function waJs() {
    const wpp = window.WPP ?? window.wpp;
    return wpp && typeof wpp === 'object' ? wpp : null;
  }

  /** Un teléfono suelto, sin jid: "+57 300 123 4567" o "573001234567". */
  function telefonoSuelto(valor) {
    const digitos = String(valor ?? '').replace(/\D/g, '');
    return digitos.length >= 8 ? digitos : null;
  }

  /**
   * El teléfono de un chat, buscándolo por donde haga falta.
   *
   * No alcanza con el identificador del chat. WhatsApp está pasando los chats a
   * `@lid`, un identificador que TAPA el número a propósito: de ahí no sale
   * ningún teléfono. El número sigue estando, pero en el contacto.
   *
   * Ésta era una de las razones de que salieran cero chats teniendo ciento tres
   * a la vista.
   */
  function telefonoDelChat(chat, wpp) {
    const directo = telefonoDe(comoTexto(chat?.id));
    if (directo) return directo;

    const contactos = [
      chat?.contact,
      chat?.contact?.contact,
      wpp?.whatsapp?.ContactStore?.get?.(chat?.id),
    ];

    for (const c of contactos) {
      if (!c) continue;
      const porJid = telefonoDe(comoTexto(c.id));
      if (porJid) return porJid;

      const porNumero = telefonoSuelto(comoTexto(c.phoneNumber) || c.phoneNumber);
      if (porNumero) return porNumero;
    }

    return null;
  }

  /** Si el contacto está en la agenda del teléfono. */
  function esGuardado(chat, wpp) {
    for (const c of [chat?.contact, wpp?.whatsapp?.ContactStore?.get?.(chat?.id), chat]) {
      if (!c) continue;
      if (c.isMyContact === true || c.isAddressBookContact === true) return true;
    }
    return false;
  }

  /**
   * Los mensajes por WA-JS, pidiéndole a cada chat su historial.
   *
   * Uno por uno y no todo de golpe: cada `getMessages` es una consulta al
   * celular y lanzarlas todas juntas hace que WhatsApp corte. Por eso también
   * va avisando: con cien chats esto tarda, y sin avance parece colgado.
   *
   * Se cuenta qué pasó con cada chat. Un "0 mensajes" a secas no distingue
   * entre no haber encontrado los chats, no poder sacarles el teléfono, o que
   * el celular no contestara — y son tres arreglos distintos.
   */
  async function mensajesDeWaJs(avisar, opciones) {
    const wpp = waJs();
    if (!wpp?.chat?.list) return { mensajes: [], nota: 'WA-JS no esta en la pagina' };

    let chats = [];
    try {
      // Sin `onlyUsers`: ese filtro mira `isUser`, que con los identificadores
      // nuevos viene en falso y dejaba la lista vacia. Los grupos se caen solos
      // mas abajo, al no poder sacarles telefono.
      chats = await wpp.chat.list();
    } catch (e) {
      console.error('[whatswv] WPP.chat.list fallo:', e);
    }

    // Si `list()` no devuelve nada, se va derecho a la coleccion.
    if (chats.length === 0) {
      chats = modelosDe(wpp.whatsapp?.ChatStore);
      console.log('[whatswv] chat.list vacio; uso ChatStore:', chats.length);
    }

    const salida = [];
    let conTelefono = 0;
    let fallaron = 0;
    let bajados = 0;
    let sinBajar = 0;
    let grandes = 0;
    let reusados = 0;
    let bytes = 0;

    /*
     * Los que no entran, anotados con el motivo.
     *
     * Salen menos chats de los que se ven en pantalla y eso es normal —grupos,
     * canales, estados, conversaciones de puras fotos—, pero "normal" no es lo
     * mismo que "comprobado". Al migrar un negocio hay que poder mirar la lista
     * y confirmar que ningun cliente se quedo por fuera.
     */
    const omitidos = [];

    for (const [i, chat] of chats.entries()) {
      const id = comoTexto(chat?.id) || '(sin id)';
      // Tambien del contacto: con los chats en @lid el nombre suele estar ahi
      // y no en el chat, y una lista de omitidos sin nombres no sirve para
      // reconocer a quien falta, que es justo para lo que esta.
      const nombreChat =
        nombreDe(chat) ??
        nombreDe(chat?.contact) ??
        nombreDe(wpp?.whatsapp?.ContactStore?.get?.(chat?.id)) ??
        '';
      const telefono = telefonoDelChat(chat, wpp);

      // Sin los desconocidos: en un numero de trabajo la mitad de los chats son
      // consultas de una sola vez que no vale la pena traer.
      if (telefono && opciones.soloGuardados && !esGuardado(chat, wpp)) {
        omitidos.push({ id: telefono, nombre: nombreChat, motivo: 'no esta en la agenda' });
        continue;
      }

      if (!telefono) {
        // De un @lid o un grupo no se puede sacar numero; de un canal tampoco.
        omitidos.push({ id, nombre: nombreChat, motivo: 'no tiene telefono (grupo, canal o @lid)' });
        continue;
      }

      conTelefono++;
      avisar(`pidiendo historial ${i + 1} de ${chats.length} (+${telefono})…`);

      let mensajes = [];
      try {
        // -1 es "todo": con multidispositivo WA-JS lo convierte en sin limite y
        // baja el historial del celular, no solo lo que ya estaba cargado.
        mensajes = await wpp.chat.getMessages(chat.id, { count: opciones.porChat });
      } catch (e) {
        fallaron++;
        omitidos.push({ id: telefono, nombre: nombreChat, motivo: `el celular no contesto: ${e?.message ?? e}` });
        console.warn(`[whatswv] historial de ${telefono}:`, e?.message ?? e);
        continue;
      }

      let conTexto = 0;

      for (const [j, m] of mensajes.entries()) {
        const segundos = cuandoDe(m);
        const texto = textoDe(m);
        const clase = claseDe(m);

        // Antes se pedia texto si o si, y una conversacion de puras fotos se
        // perdia entera. Ahora entra si tiene texto O si trae archivo.
        if (!segundos || (!texto && !clase)) continue;
        if (opciones.desde && segundos < opciones.desde) continue;

        // El chat ya dice de quien es la conversacion; del mensaje solo hace
        // falta si salio de aca. Asi tambien sirven los mensajes cuyo
        // identificador viene con @lid.
        const de = deQuienEs(m);
        const mio = de ? de.mio : m?.id?.fromMe === true;

        /*
         * El archivo, si se pidieron.
         *
         * downloadMedia se lo pide al celular cuando no esta en esta maquina, asi
         * que tarda y puede fallar por mil razones —el celular apagado, media que
         * WhatsApp ya no tiene—. Falla de a uno: el mensaje entra igual con su
         * pie de foto, y al final el panel dice cuantos quedaron sin archivo.
         */
        let archivo = null;
        const tamano = tamanoDe(m);

        /*
         * POR QUE se saltan los pesados.
         *
         * Un video de 40 MB no entra en la bandeja —el tope es MEDIA_MAX_MB, 16 por
         * defecto, que es el maximo que acepta WhatsApp— asi que bajarlo es media
         * hora de espera para un archivo que despues no se puede ni reenviar. Se
         * cuenta y queda dicho al final.
         */
        if (clase && opciones.archivos && tamano > TOPE_BYTES) {
          grandes++;
          console.warn(
            '[whatswv] salto ' + clase + ' de ' + Math.round(tamano / 1048576) + ' MB de ' + telefono,
          );
        } else if (clase && opciones.archivos) {
          /*
           * El nombre se puede calcular antes de bajar nada: el modelo ya dice el
           * mime. Sirve para preguntarle a la carpeta si ese archivo ya esta, y
           * saltarse la descarga. Si el modelo no trae mime se baja y se nombra
           * despues, como siempre.
           */
          const mimeDicho = String(m?.mimetype ?? '').split(';')[0].trim();
          const nombreDicho = mimeDicho
            ? telefono + '-' + segundos + '-' + j + '.' + extensionDe(mimeDicho, m?.filename)
            : null;

          const yaEsta = await pesoSiYaEsta(opciones.carpeta, nombreDicho);

          if (yaEsta) {
            // Entra al JSON igual que si se hubiera bajado ahora: si no, el
            // importador no sabria que ese mensaje tiene archivo.
            archivo = {
              nombre: nombreDicho,
              clase,
              mime: mimeDicho || null,
              bytes: yaEsta,
              original: m?.filename ?? null,
            };
            reusados++;
          } else {
            // El aviso va ANTES de pedirlo, y con el numero de archivo: si se queda
            // esperando, el panel dice exactamente en que se quedo. Con el aviso
            // cada diez parecia colgado justo cuando estaba trabajando.
            avisar(
              'chat ' + (i + 1) + ' de ' + chats.length + ' · archivo ' + (bajados + sinBajar + 1) +
                (sinBajar ? ' (' + sinBajar + ' sin bajar)' : ''),
            );

            try {
              const blob = await conTope(
                wpp.chat.downloadMedia(comoTexto(m.id) || m.id),
                TOPE_ESPERA,
                clase + ' de +' + telefono,
              );

              const mime = (blob?.type || m?.mimetype || '').split(';')[0];
              // Nombre calculado, no al azar: reexportar sobre la misma carpeta
              // reescribe el mismo archivo en vez de dejar copias.
              const nombre = telefono + '-' + segundos + '-' + j + '.' + extensionDe(mime, m?.filename);

              await escribirArchivo(opciones.carpeta, nombre, blob);

              archivo = {
                nombre,
                clase,
                mime: mime || null,
                bytes: blob.size ?? null,
                original: m?.filename ?? null,
              };
              bajados++;
              bytes += blob.size ?? 0;
            } catch (e) {
              sinBajar++;
              console.warn('[whatswv] archivo de ' + telefono + ':', e?.message ?? e);
            }
          }
        }

        // Sin texto y sin archivo no hay nada que importar: un mensaje vacio en
        // el hilo es peor que no tenerlo.
        if (!texto && !archivo) continue;

        conTexto++;
        salida.push({ telefono, mio, segundos, texto, opaco: null, clase, archivo });
      }

      if (conTexto === 0) {
        omitidos.push({
          id: telefono,
          nombre: nombreChat,
          motivo: mensajes.length
            ? `${mensajes.length} mensajes, ninguno de texto en el rango pedido`
            : 'el celular no devolvio ningun mensaje',
        });
      }
    }

    const nota =
      `${chats.length} chats, ${conTelefono} con telefono` +
      (fallaron ? `, ${fallaron} sin respuesta del celular` : '') +
      (omitidos.length ? `, ${omitidos.length} omitidos` : '') +
      (bajados ? `, ${bajados} archivos (${Math.round(bytes / 1048576)} MB)` : '') +
      (reusados ? `, ${reusados} archivos ya estaban` : '') +
      (sinBajar ? `, ${sinBajar} archivos no llegaron` : '') +
      (grandes ? `, ${grandes} archivos pasados de 16 MB` : '');

    console.log(`[whatswv] WA-JS: ${salida.length} mensajes. ${nota}`);
    return { mensajes: salida, nota, omitidos, bajados, sinBajar, grandes, reusados, bytes };
  }

  /** Los nombres que tenga WA-JS, que son los mismos que se ven en pantalla. */
  function nombresDeWaJs() {
    const wpp = waJs();
    const mapa = new Map();
    const tienda = wpp?.whatsapp?.ContactStore ?? wpp?.whatsapp?.ChatStore;

    for (const c of modelosDe(tienda)) {
      const telefono = telefonoDe(comoTexto(c?.id));
      const nombre = nombreDe(c);
      if (telefono && nombre && !mapa.has(telefono)) mapa.set(telefono, nombre);
    }

    return mapa;
  }

  /**
   * Los módulos de la página, sea cual sea el cargador.
   *
   * WhatsApp usa dos y hay que atender los dos. El de webpack tiene los módulos
   * numerados; el otro —el que usa hoy— los tiene con NOMBRE, y ahí están todos
   * los `WAWeb…`. Con nombre es mucho más firme: un número cambia en cada
   * despliegue, pero el módulo de mensajes se sigue llamando igual.
   */
  function modulosDeLaPagina() {
    // Con nombre. Va primero porque es el que usa WhatsApp ahora.
    if (typeof window.__debug === 'function' && typeof window.importNamespace === 'function') {
      let mapa = null;
      try {
        // __debug es una FUNCION, no un objeto: hay que llamarla. Leerlo como
        // objeto daba undefined y esta via quedaba muerta sin decir nada.
        mapa = window.__debug().modulesMap;
      } catch {
        /* si cambio, quedan las otras vias */
      }

      if (mapa && typeof mapa === 'object') {
        // WhatsApp envuelve sus modulos en un guardian que traga los errores y
        // devuelve vacio; esto lo aparta mientras se piden.
        try {
          window.ErrorGuard?.skipGuardGlobal?.(true);
        } catch {
          /* si no esta, se pide igual */
        }

        const salida = [];
        for (const nombre of Object.keys(mapa)) {
          // Solo los suyos. Pedir los demas es lento y no aporta nada.
          if (!/^(?:use)?WA/.test(nombre)) continue;
          try {
            salida.push(window.importNamespace(nombre));
          } catch {
            /* un modulo que no carga no puede parar la busqueda */
          }
        }

        if (salida.length) return salida;
      }
    }

    // Numerados. Se empuja un trozo falso y en la devolución llega la función
    // de pedir módulos, que es la única forma de alcanzarla desde afuera.
    const clave = Object.keys(window).find((k) => /^webpackChunk/i.test(k));
    if (clave && Array.isArray(window[clave])) {
      let pedir = null;
      try {
        window[clave].push([['whatswv' + Date.now()], {}, (r) => { pedir = r; }]);
      } catch {
        /* si el formato del trozo cambio, se sigue con lo que haya */
      }

      if (pedir?.m) {
        return Object.keys(pedir.m).map((id) => {
          try {
            return pedir(id);
          } catch {
            return null;
          }
        });
      }
    }

    // La forma vieja del mapa, por si alguna version lo deja como objeto.
    const mapa = window.__debug?.modulesMap;
    if (mapa && typeof mapa === 'object') {
      return Object.values(mapa).map((m) => {
        try {
          return m?.publicModule?.exports ?? m?.exports ?? null;
        } catch {
          return null;
        }
      });
    }

    return [];
  }

  /** Los modelos de una colección, se llame como se llame el método. */
  function modelosDe(coleccion) {
    try {
      if (typeof coleccion?.getModelsArray === 'function') return coleccion.getModelsArray();
      if (Array.isArray(coleccion?._models)) return coleccion._models;
      if (Array.isArray(coleccion?.models)) return coleccion.models;
    } catch {
      /* una coleccion a medio cargar no puede tumbar la busqueda */
    }
    return [];
  }

  /**
   * La colección de mensajes de WhatsApp, buscada por su contenido.
   *
   * Se mira un modelo: si tiene fecha y se le puede sacar de qué chat es, es la
   * colección de mensajes. Da igual cómo se llame el módulo o la propiedad.
   */
  function coleccionDeMensajes() {
    let mejor = null;

    for (const modulo of modulosDeLaPagina()) {
      if (!modulo || typeof modulo !== 'object') continue;

      for (const nombre of Object.keys(modulo)) {
        let valor;
        try {
          valor = modulo[nombre];
        } catch {
          continue;
        }

        if (!valor || typeof valor !== 'object') continue;

        const modelos = modelosDe(valor);
        if (modelos.length === 0) continue;

        const primero = modelos[0];
        if (!deQuienEs(primero) || cuandoDe(primero) === null) continue;

        // La mas grande: WhatsApp tiene varias colecciones de mensajes (la del
        // chat abierto, la de estados) y la buena es la que lo tiene todo.
        if (!mejor || modelos.length > mejor.modelos.length) {
          mejor = { nombre, modelos };
        }
      }
    }

    return mejor;
  }

  /** Los mensajes que tenga WhatsApp en memoria, ya en claro. */
  function mensajesDeWhatsApp() {
    const coleccion = coleccionDeMensajes();
    if (!coleccion) return [];

    console.log(`[whatswv] coleccion "${coleccion.nombre}" con ${coleccion.modelos.length} mensajes`);
    const salida = [];

    for (const m of coleccion.modelos) {
      const de = deQuienEs(m);
      const segundos = cuandoDe(m);
      if (!de || !segundos) continue;

      const telefono = telefonoDe(de.jid);
      if (!telefono) continue;

      const texto = textoDe(m);
      if (!texto) continue;

      salida.push({ telefono, mio: de.mio, segundos, texto, opaco: null });
    }

    return salida;
  }

  // --- abrir la caja ----------------------------------------------------------

  /*
   * El texto de los mensajes no está en el registro: está en
   * `msgRowOpaqueData`, cifrado, con la forma {_data, iv, _keyId, _scheme}.
   * Por eso una lectura directa da cero mensajes aunque las filas estén ahí.
   *
   * La llave está en la misma máquina, en la base `wawc_db_enc`. Es cifrado en
   * reposo: protege contra husmear el disco, no contra código corriendo dentro
   * de la página, que es donde corre esto. Se descifra con la API del propio
   * navegador y la llave nunca sale de él.
   */

  /** Los bytes de algo, venga como sea. */
  function aBytes(v) {
    if (!v) return null;
    if (v instanceof Uint8Array) return v;
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v)) return new Uint8Array(v);
    // Un objeto con claves 0,1,2… es un buffer que perdió su tipo al copiarse.
    if (typeof v === 'object') {
      const claves = Object.keys(v);
      if (claves.length && claves.every((k) => /^\d+$/.test(k))) {
        return new Uint8Array(claves.map((k) => v[k]));
      }
    }
    if (typeof v === 'string') {
      try {
        return Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Las llaves de la caja, por id. */
  async function cargarLlaves(tiendas) {
    const mapa = new Map();

    for (const t of tiendas) {
      if (!t.db) continue;

      // Solo la caja del propio almacenamiento. `signal-storage` queda fuera a
      // proposito: son las llaves del protocolo de mensajeria, cientos de
      // registros con keyId 1, 2, 3… que pisan la llave real del mismo id. Esa
      // colision era la razon de que no abriera nada.
      if (/signal/i.test(t.base)) continue;
      if (!/enc/i.test(t.base) && !/^keys?$/i.test(t.tienda)) continue;

      await recorrer(t.db, t.tienda, (fila) => {
        if (!fila || typeof fila !== 'object') return;
        const llave = fila.key ?? fila.value;
        if (llave === undefined || llave === null) return;
        mapa.set(String(fila.id ?? fila.keyId ?? mapa.size), { llave, de: `${t.base}/${t.tienda}` });
      });
    }

    return mapa;
  }

  /** Lo descifrado, como objeto si es JSON; si no, lo que se pueda ver. */
  function interpretar(buffer) {
    const bytes = new Uint8Array(buffer);
    const texto = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    try {
      return JSON.parse(texto);
    } catch {
      // No es JSON: probablemente protobuf. Se devuelve igual porque el texto
      // de un mensaje aparece legible entre los bytes, y con eso ya se puede
      // sacar algo aunque no se entienda el resto.
      return { crudo: texto, bytes };
    }
  }

  /**
   * Abre un `msgRowOpaqueData` probando lo que haya.
   *
   * Se prueban las llaves y los dos algoritmos en vez de asumir uno: es un
   * espacio de cuatro o seis combinaciones, y dar por hecho AES-GCM cuando era
   * otra cosa deja "0 de 3" sin decir por que. `registrar` cuenta que paso, que
   * es lo unico que sirve cuando falla.
   */
  async function abrirOpaco(op, llaves, registrar = () => {}) {
    const datos = aBytes(op?._data);
    const iv = aBytes(op?.iv);

    registrar(
      `datos:${datos ? datos.length + 'B' : 'NO'} iv:${iv ? iv.length + 'B' : 'NO'} ` +
        `scheme:${op?._scheme} keyId:${op?._keyId} campos:${Object.keys(op ?? {}).join('|')}`,
    );

    if (!datos || !iv) return null;

    // La del keyId primero; despues las demas, por si el id no corresponde.
    const orden = [...llaves.entries()].sort(([a], [b]) =>
      a === String(op._keyId) ? -1 : b === String(op._keyId) ? 1 : 0,
    );

    let ultimo = null;

    for (const [id, { llave: bruta, de }] of orden) {
      for (const algo of ['AES-GCM', 'AES-CBC']) {
        try {
          let llave = bruta;

          if (llave instanceof CryptoKey) {
            // Una CryptoKey solo sirve para su propio algoritmo.
            if (llave.algorithm?.name !== algo) continue;
            if (!llave.usages?.includes('decrypt')) {
              registrar(`llave ${id} (${de}) no permite descifrar: ${llave.usages}`);
              continue;
            }
          } else {
            const bytes = aBytes(bruta);
            if (!bytes) continue;
            llave = await crypto.subtle.importKey('raw', bytes, algo, false, ['decrypt']);
          }

          const claro = await crypto.subtle.decrypt({ name: algo, iv }, llave, datos);
          registrar(`abierto con la llave ${id} (${de}) y ${algo}`);
          return interpretar(claro);
        } catch (e) {
          ultimo = `${algo} con llave ${id}: ${e?.name ?? e}`;
        }
      }
    }

    registrar(`ninguna combinacion sirvio. Ultimo intento: ${ultimo}`);
    return null;
  }

  const CAMPOS_TEXTO = ['body', 'caption', 'text', 'conversation'];

  /**
   * Busca el texto dentro de lo descifrado.
   *
   * A tientas y por todo el objeto: no se sabe con qué forma sale, y lo que
   * importa es encontrar el mensaje, no reproducir la estructura de WhatsApp.
   */
  function buscarTexto(valor, nivel = 0) {
    if (typeof valor === 'string') return valor.trim();
    if (!valor || typeof valor !== 'object' || nivel > 4) return '';

    for (const campo of CAMPOS_TEXTO) {
      const v = valor[campo];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }

    for (const v of Object.values(valor)) {
      const encontrado = buscarTexto(v, nivel + 1);
      if (encontrado) return encontrado;
    }

    return '';
  }

  /**
   * Un informe de texto de todo lo que hay, para poder pegarlo en un mensaje.
   *
   * Van los NOMBRES de los campos, nunca el contenido: hace falta saber qué
   * forma tienen los datos, no qué dicen. Así se puede pasar el informe sin
   * mandar conversaciones de clientes a ningún lado.
   *
   * Existe porque copiar 142 líneas de la consola a mano no es razonable, y sin
   * ese dato ajustar el script es adivinar.
   */
  function informe(tiendas) {
    const lineas = [];
    lineas.push(`WhatsWV — ${tiendas.length} tiendas en ${new Set(tiendas.map((t) => t.base)).size} bases`);
    lineas.push(`navegador: ${navigator.userAgent}`);

    /*
     * Los globales van en el informe, no sueltos en otro boton.
     *
     * Son lo que decide si los chats se pueden sacar o no, y tenerlos en otro
     * lado hacia que el informe llegara sin ellos y hubiera que pedirlos otra
     * vez. Un informe que no contesta la pregunta principal no sirve.
     */
    const wpp = waJs();
    lineas.push(
      'globales: ' +
        ['WPP', 'require', '__d', '__debug', 'importNamespace', 'ErrorGuard']
          .map((k) => `${k}:${typeof window[k]}`)
          .join('  '),
    );
    lineas.push(
      'trozos: ' + (Object.keys(window).find((k) => /^webpackChunk/i.test(k)) ?? 'no'),
    );
    lineas.push(
      'WA-JS: ' +
        (wpp?.chat?.list
          ? `si, ${modelosDe(wpp.whatsapp?.ChatStore).length} chats`
          : wpp
            ? 'el objeto esta pero sin chat.list'
            : 'no'),
    );
    lineas.push('');

    const conDatos = tiendas.filter((t) => (t.filas ?? t.muestra) > 0);
    conDatos.sort((a, b) => (b.filas ?? b.muestra) - (a.filas ?? a.muestra));

    for (const t of conDatos) {
      const campos = Object.keys(t.ejemplo?.fila ?? {});
      const tipoClave = t.ejemplo ? typeof t.ejemplo.clave : '?';
      lineas.push(
        `${t.base} / ${t.tienda}  ${t.filas ?? '?'} filas  [${t.clase ?? '-'}]  clave:${tipoClave}`,
      );
      lineas.push(`    campos: ${campos.join(', ') || '(sin campos)'}`);

      // Los campos anidados importan: si el identificador o la fecha viven un
      // nivel adentro, desde afuera la fila parece no tener nada util.
      for (const campo of campos) {
        const v = t.ejemplo.fila[campo];

        // Lo binario primero: un buffer tambien es un objeto, y listar sus
        // claves da "{0, 1, 2, ...}", que ademas de inutil tapa el informe.
        // Si la carga viene binaria es la respuesta a por que no sale texto.
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Blob) {
          lineas.push(`      ${campo}: binario (${v.byteLength ?? v.size ?? '?'} bytes)`);
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          const dentro = Object.keys(v).slice(0, 12).join(', ');
          if (dentro) lineas.push(`      ${campo}: {${dentro}}`);
        }
      }
    }

    const vacias = tiendas.length - conDatos.length;
    if (vacias) lineas.push('', `(${vacias} tiendas vacias, omitidas)`);

    return lineas.join(String.fromCharCode(10));
  }

  async function copiarInforme(tiendas, avisar) {
    // Se cuenta antes si no se ha contado: el informe sin numeros no dice cual
    // es la tienda que importa.
    if (tiendas.some((t) => t.db && t.filas === undefined)) {
      for (const t of tiendas) {
        if (!t.db) continue;
        avisar(`contando ${t.base} / ${t.tienda}…`);
        t.filas = await recorrer(t.db, t.tienda, () => {});
      }
    }

    const texto = informe(tiendas);
    console.log(texto);

    try {
      await navigator.clipboard.writeText(texto);
      avisar('Informe copiado. Pegalo en el chat. (Solo nombres de campos.)');
    } catch {
      // Sin permiso de portapapeles queda el archivo, que sirve igual.
      bajar('whatswv-informe.txt', texto, 'text/plain;charset=utf-8');
      avisar('No pude usar el portapapeles: bajo whatswv-informe.txt');
    }
  }

  // --- el panel ---------------------------------------------------------------

  const VERDE = '#1F9D55';

  const ESTILO_CAMPO =
    'width:100%;box-sizing:border-box;margin-bottom:8px;padding:6px 8px;' +
    'border:1px solid #d4d4d8;border-radius:6px;font:inherit;background:#fff;color:#111';

  function panel() {
    document.getElementById(ID_PANEL)?.remove();

    const caja = document.createElement('div');
    caja.id = ID_PANEL;
    caja.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'width:290px', 'padding:14px', 'border-radius:12px',
      'background:#fff', 'color:#111', 'box-shadow:0 8px 32px rgba(0,0,0,.28)',
      'font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif',
    ].join(';');

    const titulo = document.createElement('div');
    titulo.style.cssText = `font-weight:700;color:${VERDE};margin-bottom:10px`;
    titulo.textContent = 'WhatsWV — exportar';

    const cerrar = document.createElement('button');
    cerrar.textContent = '×';
    cerrar.style.cssText =
      'position:absolute;top:8px;right:10px;border:0;background:none;font-size:20px;line-height:1;color:#999;cursor:pointer';
    cerrar.onclick = () => caja.remove();

    caja.append(titulo, cerrar);

    const rotulo = (texto) => {
      const l = document.createElement('div');
      l.style.cssText = 'color:#666;font-size:11px;margin-bottom:3px';
      l.textContent = texto;
      caja.appendChild(l);
    };

    /*
     * Desde qué fecha.
     *
     * Para migrar no hace falta traer cinco años de conversaciones: lo que
     * sirve es lo reciente, y acotar la fecha es lo que hace que esto pase de
     * varios minutos a menos de uno.
     */
    rotulo('Desde (vacío = todo)');
    const desde = document.createElement('input');
    desde.type = 'date';
    desde.style.cssText = ESTILO_CAMPO;
    caja.appendChild(desde);

    rotulo('Mensajes por chat');
    const porChat = document.createElement('select');
    porChat.style.cssText = ESTILO_CAMPO;
    for (const [valor, texto] of [
      ['-1', 'Todos (tarda)'],
      ['200', 'Últimos 200'],
      ['50', 'Últimos 50'],
    ]) {
      const o = document.createElement('option');
      o.value = valor;
      o.textContent = texto;
      porChat.appendChild(o);
    }
    caja.appendChild(porChat);

    const linea = document.createElement('label');
    linea.style.cssText =
      'display:flex;gap:6px;align-items:center;margin-bottom:10px;color:#444;cursor:pointer';
    const guardados = document.createElement('input');
    guardados.type = 'checkbox';
    linea.append(guardados, document.createTextNode('Sólo contactos guardados'));
    caja.appendChild(linea);

    /*
     * Los archivos van aparte y apagados por defecto.
     *
     * Bajar un ano de fotos le pide al celular cada archivo de a uno: lo que
     * tarda un minuto en texto puede tardar media hora con fotos. El que la
     * necesita la marca; el que solo quiere los contactos y el texto no paga esa
     * espera sin haberla pedido.
     */
    const lineaArchivos = document.createElement('label');
    lineaArchivos.style.cssText =
      'display:flex;gap:6px;align-items:center;margin-bottom:4px;color:#444;cursor:pointer';
    const conArchivos = document.createElement('input');
    conArchivos.type = 'checkbox';
    lineaArchivos.append(conArchivos, document.createTextNode('Traer fotos, audios y documentos'));
    caja.appendChild(lineaArchivos);

    const nota = document.createElement('div');
    nota.style.cssText = 'color:#888;font-size:10px;line-height:1.35;margin:0 0 10px 22px';
    nota.textContent = 'Pide una carpeta donde dejarlos. Tarda bastante más: cada archivo se le pide al celular.';
    caja.appendChild(nota);

    const estado = document.createElement('div');
    estado.style.cssText =
      'margin-top:10px;padding:8px;border-radius:8px;background:#f4f4f5;color:#444;font-size:11px;min-height:32px';
    estado.textContent = 'Buscando…';
    caja.appendChild(estado);

    document.body.appendChild(caja);

    const avisar = (texto) => {
      estado.textContent = texto;
      console.log('[whatswv]', texto);
    };

    /** Lo elegido en el panel, al momento de pulsar. */
    const opciones = () => ({
      // A segundos, que es como WhatsApp guarda las fechas. Se toma el
      // principio del dia en hora local, que es lo que uno espera al escribir
      // una fecha a mano.
      desde: desde.value ? Math.floor(new Date(desde.value + 'T00:00:00').getTime() / 1000) : null,
      porChat: Number(porChat.value),
      soloGuardados: guardados.checked,
      archivos: conArchivos.checked,
      // La llena el boton de chats al elegir carpeta, porque el selector necesita
      // el clic todavia fresco y aca ya no lo esta.
      carpeta: null,
    });

    const boton = (texto, principal, alPulsar) => {
      const b = document.createElement('button');
      b.textContent = texto;
      b.style.cssText = [
        'display:block', 'width:100%', 'margin-bottom:6px', 'padding:9px',
        'border-radius:8px', 'cursor:pointer', 'font:inherit', 'font-weight:600',
        principal
          ? `background:${VERDE};color:#fff;border:0`
          : 'background:#fff;color:#444;border:1px solid #d4d4d8',
      ].join(';');

      b.onclick = async () => {
        const antes = b.textContent;
        // Se desactivan todos: dos lecturas a la vez sobre la misma base se
        // pisan los avisos y no se entiende cual va.
        for (const otro of caja.querySelectorAll('button')) otro.disabled = true;
        b.textContent = 'Trabajando…';

        try {
          await alPulsar(avisar, opciones());
        } catch (e) {
          avisar('Error: ' + (e?.message ?? e));
          console.error('[whatswv]', e);
        } finally {
          b.textContent = antes;
          for (const otro of caja.querySelectorAll('button')) otro.disabled = false;
        }
      };

      caja.insertBefore(b, estado);
      return b;
    };

    return { avisar, boton };
  }

  // --- arranque ---------------------------------------------------------------

  /**
   * Espera a que exista la página.
   *
   * Por la extensión esto corre en `document_start`, o sea antes de que haya
   * `body`, y el panel no se podría colgar de ningún lado.
   */
  function documentoListo() {
    if (document.body) return Promise.resolve();
    return new Promise((ok) => {
      document.addEventListener('DOMContentLoaded', () => ok(), { once: true });
    });
  }

  /**
   * Espera a que WA-JS termine de arrancar.
   *
   * `onFullReady` es lo que dice que WhatsApp ya cargó del todo y se le puede
   * preguntar por los chats. Se le pone un tope: si algo sale mal es mejor un
   * panel que avisa que uno que se queda esperando para siempre.
   */
  function waJsListo(avisar, tope = 120_000) {
    return new Promise((ok) => {
      const desde = Date.now();

      const mirar = () => {
        const wpp = waJs();

        if (wpp?.isFullReady || (wpp?.chat?.list && wpp?.isReady)) return ok(true);
        if (Date.now() - desde > tope) return ok(false);

        const segundos = Math.round((Date.now() - desde) / 1000);
        avisar(`esperando a que WhatsApp cargue… (${segundos}s)`);
        setTimeout(mirar, 500);
      };

      const wpp = waJs();
      if (wpp?.webpack?.onFullReady) {
        try {
          wpp.webpack.onFullReady(() => ok(true));
        } catch {
          /* si no esta, queda el sondeo */
        }
      }

      mirar();
    });
  }

  (async () => {
    await documentoListo();

    const { avisar, boton } = panel();

    // Por la extension hay que esperar; pegado en la consola ya esta todo.
    if (window.__WHATSWV_EXTENSION) {
      const listo = await waJsListo(avisar);
      if (!listo) {
        avisar('WhatsApp no termino de cargar. Recarga la pagina y espera a ver los chats.');
      }
    }

    const tiendas = await inventario();
    const fuentes = {
      contacto: elegir(tiendas, 'contacto'),
      mensaje: elegir(tiendas, 'mensaje'),
      todosContactos: tiendas.filter((t) => t.clase === 'contacto'),
      todosMensajes: tiendas.filter((t) => t.clase === 'mensaje'),
      tiendas,
    };

    boton('Contactos (CSV)', true, async (av, op) => {
      const n = await sacarContactos(fuentes, av, op);
      av(`Listo: ${n} contactos en whatswv-contactos.csv`);
    });

    boton('Chats (JSON + CSV)', true, async (av, op) => {
      /*
       * La carpeta se pide PRIMERO, antes de cualquier espera.
       *
       * El navegador solo abre el selector de carpeta con el gesto del usuario
       * todavia fresco; despues del primer await ya lo considera vencido y
       * rechaza el dialogo.
       */
      if (op.archivos) {
        const elegida = await pedirCarpeta(av);
        op.carpeta = elegida.carpeta;
        op.archivos = elegida.archivos;
      }

      const r = await sacarChats(fuentes, av, op);

      av(
        `Listo: ${r.chats} chats` +
          (r.archivos ? `, ${r.archivos} archivos` : '') +
          (r.sinBajar ? `, ${r.sinBajar} no llegaron` : '') +
          (r.grandes ? `, ${r.grandes} pasados de 16 MB` : '') +
          '. Al final del CSV estan los chats que no entraron.',
      );
    });

    /*
     * El informe se queda, las sondas no.
     *
     * Las sondas eran para averiguar cómo guarda WhatsApp sus datos, y eso ya
     * se sabe. El informe es otra cosa: es lo que hay que mandar el día que
     * WhatsApp cambie algo y esto deje de funcionar.
     */
    boton('Informe (si algo falla)', false, (av) => copiarInforme(tiendas, av));

    const wpp = waJs();

    if (wpp?.chat?.list) {
      avisar(`Listo. WA-JS ve ${modelosDe(wpp.whatsapp?.ChatStore).length} chats.`);
    } else if (fuentes.contacto) {
      // Sin WA-JS los contactos salen igual: estan sin cifrar en la base local.
      avisar('Sin WA-JS: solo se pueden sacar los contactos. Revisa que la extension este activa.');
    } else {
      avisar('No encontre los datos de WhatsApp. Recarga la pagina con los chats a la vista.');
    }
  })();
})();
