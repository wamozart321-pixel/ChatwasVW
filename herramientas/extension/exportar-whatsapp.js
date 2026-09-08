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

  async function sacarContactos(fuentes, avisar) {
    if (!fuentes.contacto) throw new Error('no encontre ninguna tienda de contactos');

    const porTelefono = new Map();

    for (const t of fuentes.todosContactos) {
      await recorrer(t.db, t.tienda, (fila, clave) => {
        const telefono = telefonoDe(idDe(fila, clave));
        if (!telefono) return;

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

  async function sacarChats(fuentes, avisar) {
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
    const waJsDio = await mensajesDeWaJs(avisar);
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

    // Segunda pasada: abrir los que traen el texto cifrado.
    const cerrados = crudos.filter((c) => !c.texto && c.opaco);
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

    // El mismo mensaje puede venir por las dos vias: se queda una sola copia.
    // La huella es telefono+segundo+quien+texto, que es lo mismo con que el
    // importador decide si ya lo tiene.
    const chats = new Map();
    const vistos = new Set();

    for (const c of crudos) {
      if (!c.texto) continue;

      const huella = `${c.telefono}|${c.segundos}|${c.mio}|${c.texto}`;
      if (vistos.has(huella)) continue;
      vistos.add(huella);

      if (!chats.has(c.telefono)) chats.set(c.telefono, []);
      chats.get(c.telefono).push({
        cuando: new Date(c.segundos * 1000).toISOString(),
        mio: c.mio,
        texto: c.texto,
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

    avisar(
      `${salida.length} chats de ${leidos.toLocaleString('es')} filas` +
        (abiertos ? `, ${abiertos.toLocaleString('es')} descifrados` : '') +
        (fallos ? ` (${fallos.toLocaleString('es')} no se pudieron abrir)` : ''),
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
    const filas = ['telefono,nombre,cuando,quien,texto'];
    for (const chat of salida) {
      for (const m of chat.mensajes) {
        filas.push(
          [
            celdaTelefono(chat.telefono),
            celda(chat.nombre ?? ''),
            celda(m.cuando),
            m.mio ? 'nosotros' : 'cliente',
            celda(m.texto),
          ].join(','),
        );
      }
    }
    const SALTO = String.fromCharCode(10);
    const MARCA_EXCEL = String.fromCharCode(0xfeff);
    bajar(
      'whatswv-chats.csv',
      MARCA_EXCEL + filas.join(SALTO) + SALTO,
      'text/csv;charset=utf-8',
    );

    // La lista de los que no entraron, para poder revisarla.
    const omitidos = waJsDio.omitidos ?? [];
    if (omitidos.length) {
      const filasOmitidas = ['identificador,nombre,motivo'];
      for (const o of omitidos) {
        filasOmitidas.push([celda(o.id), celda(o.nombre), celda(o.motivo)].join(','));
      }
      bajar(
        'whatswv-omitidos.csv',
        MARCA_EXCEL + filasOmitidas.join(SALTO) + SALTO,
        'text/csv;charset=utf-8',
      );
    }

    // Si no salio nada, el porque va en el panel: sin eso "0 chats" no dice si
    // fallo la busqueda, los telefonos o el celular.
    if (salida.length === 0) avisar(`0 chats. ${waJsDio.nota}`);

    return salida.length;
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
  async function mensajesDeWaJs(avisar) {
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
        mensajes = await wpp.chat.getMessages(chat.id, { count: -1 });
      } catch (e) {
        fallaron++;
        omitidos.push({ id: telefono, nombre: nombreChat, motivo: `el celular no contesto: ${e?.message ?? e}` });
        console.warn(`[whatswv] historial de ${telefono}:`, e?.message ?? e);
        continue;
      }

      let conTexto = 0;

      for (const m of mensajes) {
        const segundos = cuandoDe(m);
        const texto = textoDe(m);
        if (!segundos || !texto) continue;

        // El chat ya dice de quien es la conversacion; del mensaje solo hace
        // falta si salio de aca. Asi tambien sirven los mensajes cuyo
        // identificador viene con @lid.
        const de = deQuienEs(m);
        const mio = de ? de.mio : m?.id?.fromMe === true;

        conTexto++;
        salida.push({ telefono, mio, segundos, texto, opaco: null });
      }

      if (conTexto === 0) {
        omitidos.push({
          id: telefono,
          nombre: nombreChat,
          motivo: mensajes.length
            ? `${mensajes.length} mensajes pero ninguno de texto (fotos, audios)`
            : 'el celular no devolvio ningun mensaje',
        });
      }
    }

    const nota =
      `${chats.length} chats, ${conTelefono} con telefono` +
      (fallaron ? `, ${fallaron} sin respuesta del celular` : '') +
      (omitidos.length ? `, ${omitidos.length} omitidos` : '');

    console.log(`[whatswv] WA-JS: ${salida.length} mensajes. ${nota}`);
    return { mensajes: salida, nota, omitidos };
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

  /**
   * Dice si se puede llegar a los mensajes, y por dónde.
   *
   * Enumera los globales porque son la explicación: si no está ninguno, no es
   * que falte código, es que WhatsApp ya los borró y desde la consola se llega
   * tarde. Eso hay que verlo, no deducirlo.
   */
  function probarViaWhatsApp(avisar) {
    const estado = ['WPP', 'require', '__d', '__debug', 'importNamespace', 'ErrorGuard']
      .map((k) => `${k}:${typeof window[k]}`)
      .join('  ');
    const numerados = Object.keys(window).find((k) => /^webpackChunk/i.test(k));
    console.log('[whatswv] globales:', estado, '| trozos:', numerados ?? 'no');

    const wpp = waJs();
    if (wpp?.chat?.list) {
      const chats = modelosDe(wpp.whatsapp?.ChatStore).length;
      avisar(`WA-JS presente (${chats} chats). Usa "Chats (JSON)": pedira el historial al celular.`);
      return;
    }

    const modulos = modulosDeLaPagina().filter(Boolean);
    console.log('[whatswv] modulos alcanzados:', modulos.length);

    if (modulos.length === 0) {
      avisar(
        'No hay WA-JS ni se alcanza el codigo de WhatsApp: desde la consola se llega tarde. Mira la consola.',
      );
      return;
    }

    const mensajes = mensajesDeWhatsApp();
    if (mensajes.length === 0) {
      avisar(`Alcance ${modulos.length} modulos pero ninguna coleccion de mensajes. Mira la consola.`);
      return;
    }

    console.log('[whatswv] ejemplo:', mensajes[0]);
    avisar(`${mensajes.length} mensajes en claro desde WhatsApp. Ya puedes usar "Chats (JSON)".`);
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
   * Descifra unos pocos y cuenta paso por paso qué pasó, sin exportar nada.
   *
   * Deja todo en la consola: qué llaves hay y de qué tipo, qué trae cada
   * `msgRowOpaqueData`, y con qué combinación se abrió o por qué no. "0 de 3" a
   * secas no dice en qué paso se rompió, y sin eso el arreglo es a ciegas.
   */
  async function probarDescifrado(fuentes, avisar) {
    const llaves = await cargarLlaves(fuentes.tiendas);

    console.log('[whatswv] llaves encontradas:', llaves.size);
    for (const [id, { llave, de }] of llaves) {
      const tipo = llave?.constructor?.name ?? typeof llave;
      const extra =
        llave instanceof CryptoKey
          ? `algoritmo:${llave.algorithm?.name} largo:${llave.algorithm?.length} usos:${llave.usages}`
          : `claves:${Object.keys(llave ?? {}).slice(0, 8).join('|')}`;
      console.log(`  llave ${id} de ${de} — ${tipo} — ${extra}`);
    }

    if (llaves.size === 0) {
      avisar('No encontre ninguna llave. El detalle quedo en la consola.');
      return;
    }

    const muestras = [];
    for (const t of fuentes.todosMensajes) {
      if (muestras.length >= 3) break;
      await recorrer(
        t.db,
        t.tienda,
        (fila) => {
          if (muestras.length >= 3) return;
          if (fila?.msgRowOpaqueData) muestras.push(fila.msgRowOpaqueData);
        },
        300,
      );
    }

    if (muestras.length === 0) {
      avisar('Ningun mensaje trae msgRowOpaqueData. Pulsa "Copiar informe" y pasamelo.');
      return;
    }

    let bien = 0;

    for (const [i, op] of muestras.entries()) {
      console.log(`[whatswv] --- muestra ${i + 1}`);
      const claro = await abrirOpaco(op, llaves, (m) => console.log('    ' + m));

      if (!claro) continue;

      const texto = buscarTexto(claro);
      if (texto) {
        bien++;
        console.log(`    texto: ${JSON.stringify(texto.slice(0, 80))}`);
      } else {
        // Se abrio pero no se reconoce: ver los primeros bytes dice si es
        // protobuf, y donde queda el texto adentro.
        console.log('    se abrio pero no encontre texto. Contenido:', claro);
      }
    }

    avisar(`Descifrados ${bien} de ${muestras.length}. El detalle quedo en la consola.`);
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

  /**
   * Todo lo que hay, sin exportar nada.
   *
   * Cuenta las filas de verdad —no la muestra— y deja en la consola un registro
   * entero de cada tienda. Cuando la exportación sale vacía, ese registro es lo
   * único que dice qué forma tienen los datos en ESTA versión de WhatsApp; sin
   * él sólo queda adivinar.
   */
  async function diagnostico(tiendas, avisar) {
    for (const t of tiendas) {
      if (!t.db) continue;
      avisar(`contando ${t.base} / ${t.tienda}…`);
      t.filas = await recorrer(t.db, t.tienda, () => {});
    }

    console.table(
      tiendas.map((t) => ({
        base: t.base,
        tienda: t.tienda,
        filas: t.filas ?? 0,
        clase: t.clase ?? '(no se reconocio)',
      })),
    );

    for (const t of tiendas) {
      if (!t.ejemplo || !(t.filas ?? 0)) continue;
      console.log(`--- ${t.base} / ${t.tienda} (${t.filas} filas, ${t.clase ?? 'no reconocida'})`);
      console.log('    clave:', t.ejemplo.clave);
      console.log('    fila:', t.ejemplo.fila);
    }

    const total = tiendas.reduce((n, t) => n + (t.filas ?? 0), 0);
    avisar(
      `${total.toLocaleString('es')} filas en ${tiendas.length} tiendas. ` +
        'Usa "Copiar informe" para pasarlo.',
    );
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

  function panel() {
    document.getElementById(ID_PANEL)?.remove();

    const caja = document.createElement('div');
    caja.id = ID_PANEL;
    caja.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'width:300px', 'padding:14px', 'border-radius:12px',
      'background:#fff', 'color:#111', 'box-shadow:0 8px 32px rgba(0,0,0,.28)',
      'font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif',
    ].join(';');

    const titulo = document.createElement('div');
    titulo.style.cssText = `font-weight:700;color:${VERDE};margin-bottom:2px`;
    titulo.textContent = 'WhatsWV — exportar';

    const sub = document.createElement('div');
    sub.style.cssText = 'color:#666;font-size:11px;margin-bottom:12px';
    sub.textContent = 'lee la copia local de este navegador';

    const estado = document.createElement('div');
    estado.style.cssText =
      'margin-top:12px;padding:8px;border-radius:8px;background:#f4f4f5;color:#444;font-size:11px;min-height:32px';
    estado.textContent = 'Buscando…';

    const cerrar = document.createElement('button');
    cerrar.textContent = '×';
    cerrar.style.cssText =
      'position:absolute;top:8px;right:10px;border:0;background:none;font-size:20px;line-height:1;color:#999;cursor:pointer';
    cerrar.onclick = () => caja.remove();

    caja.append(titulo, sub, estado, cerrar);
    document.body.appendChild(caja);

    const avisar = (texto) => {
      estado.textContent = texto;
      console.log('[whatswv]', texto);
    };

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
          await alPulsar(avisar);
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

    if (tiendas.length === 0) {
      avisar(
        'No encontre ninguna base. Revisa que esto sea la pestana de web.whatsapp.com con la sesion abierta y los chats cargados.',
      );
      return;
    }

    const fuentes = {
      contacto: elegir(tiendas, 'contacto'),
      mensaje: elegir(tiendas, 'mensaje'),
      todosContactos: tiendas.filter((t) => t.clase === 'contacto'),
      todosMensajes: tiendas.filter((t) => t.clase === 'mensaje'),
      tiendas,
    };

    boton('Contactos (CSV)', true, async (av) => {
      const n = await sacarContactos(fuentes, av);
      av(`Listo: ${n} contactos en whatswv-contactos.csv`);
    });

    boton('Chats (JSON)', true, async (av) => {
      const n = await sacarChats(fuentes, av);
      av(`Listo: ${n} chats en whatswv-chats.json`);
    });

    boton('Probar via WhatsApp', false, (av) => probarViaWhatsApp(av));
    boton('Probar descifrado', false, (av) => probarDescifrado(fuentes, av));
    boton('Copiar informe', false, (av) => copiarInforme(tiendas, av));
    boton('Ver que hay', false, (av) => diagnostico(tiendas, av));

    const wpp = waJs();
    if (wpp?.chat?.list) {
      avisar(`Listo. WA-JS ve ${modelosDe(wpp.whatsapp?.ChatStore).length} chats.`);
    } else {
      const donde = (t) => (t ? `${t.base}/${t.tienda}` : 'NO ENCONTRADA');
      avisar(`Sin WA-JS. Contactos: ${donde(fuentes.contacto)}. Mensajes: ${donde(fuentes.mensaje)}.`);
    }
  })();
})();
