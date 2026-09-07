/**
 * Saca los contactos y los chats de WhatsApp Web, sin extensión y sin pagar.
 *
 * Cómo se usa: abrir web.whatsapp.com con la sesión iniciada, esperar a que
 * cargue la lista de chats, abrir la consola del navegador (F12 -> Console),
 * pegar TODO este archivo y dar Enter. Aparece un panel arriba a la derecha.
 *
 * Lo que baja se le pasa al importador:
 *
 *   npm run importar -- contactos whatswv-contactos.csv
 *   npm run importar -- mensajes whatswv-chats.json
 *
 * ---
 *
 * De dónde salen los datos.
 *
 * WhatsApp Web guarda su copia local en IndexedDB, la base de datos del propio
 * navegador. Se lee de ahí y no de los módulos internos de la página, que es lo
 * que hacen las extensiones: esos módulos no tienen nombre estable —son código
 * empaquetado y minificado— y cada despliegue de WhatsApp los renumera, así que
 * una herramienta hecha así se rompe sola cada pocas semanas.
 *
 * Pero tampoco alcanza con confiar en los nombres de la base. WhatsApp reparte
 * sus datos en VARIAS bases y les cambia el nombre entre versiones: los
 * contactos pueden estar en una y los mensajes en otra. Por eso se recorren
 * todas y cada tienda se clasifica MIRANDO UN REGISTRO, no por cómo se llama.
 * Un mensaje se reconoce porque su identificador empieza por "true_" o "false_"
 * y trae fecha; un contacto, porque su identificador es un jid y trae nombre.
 *
 * Esto NO habla con los servidores de WhatsApp ni manda nada a ningún lado: lee
 * lo que ya está en este computador y arma un archivo. Son los datos del propio
 * negocio.
 *
 * Lo que sí tiene límite: WhatsApp Web no guarda todo el historial, guarda lo
 * que fue sincronizando con el celular. Los contactos salen completos; de los
 * mensajes sale lo que esté cargado. Para que baje más, hay que abrir el chat y
 * subir un rato antes de exportar.
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
   * El identificador de un mensaje es "<mio>_<jid del chat>_<id>": la primera
   * parte dice si salió de acá. Es la forma que WhatsApp usa desde siempre, y
   * sirve aunque la fila no traiga los campos `from` y `to`.
   */
  function deQuienEs(fila, clave) {
    const partes = idDe(fila, clave).split('_');
    if (partes.length < 3 || (partes[0] !== 'true' && partes[0] !== 'false')) return null;
    if (!partes[1].includes('@')) return null;
    return { mio: partes[0] === 'true', jid: partes[1] };
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
        tiendas.push({ db, base: name, tienda, clase: clasificar(muestra), muestra: muestra.length });
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
        'no encontre ninguna tienda de mensajes. Pulsa "Ver que hay" y pasame lo que salga en la consola',
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

    const chats = new Map();
    let leidos = 0;
    let ultimoAviso = 0;
    let descartados = 0;
    let ejemploDescartado = null;

    for (const t of fuentes.todosMensajes) {
      await recorrer(t.db, t.tienda, (fila, clave) => {
        leidos++;
        if (leidos - ultimoAviso >= 5000) {
          ultimoAviso = leidos;
          avisar(`${leidos.toLocaleString('es')} mensajes leidos…`);
        }

        const de = deQuienEs(fila, clave);
        const segundos = cuandoDe(fila);
        const texto = textoDe(fila);
        const telefono = de && telefonoDe(de.jid);

        if (!telefono || !segundos || !texto) {
          descartados++;
          // Se guarda uno para poder mirarlo en la consola: si sale todo
          // descartado, es la unica forma de saber que tienen adentro estas
          // filas sin adivinar.
          if (!ejemploDescartado) ejemploDescartado = { fila, clave };
          return;
        }

        if (!chats.has(telefono)) chats.set(telefono, []);
        chats.get(telefono).push({
          cuando: new Date(segundos * 1000).toISOString(),
          mio: de.mio,
          texto,
        });
      });
    }

    if (ejemploDescartado) {
      console.log('[whatswv] ejemplo de fila que no se pudo leer:', ejemploDescartado);
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
        (descartados ? ` (${descartados.toLocaleString('es')} sin texto o de grupo)` : ''),
    );

    bajar(
      'whatswv-chats.json',
      JSON.stringify({ exportado: new Date().toISOString(), chats: salida }, null, 1),
      'application/json',
    );

    return salida.length;
  }

  /**
   * Todo lo que hay, sin exportar nada.
   *
   * Está para cuando algo no cuadra: imprime cada base con cada tienda, cuántas
   * filas tiene y qué se creyó que era. Con eso se ajusta el script en vez de
   * quedar adivinando por qué salió vacío.
   */
  function diagnostico(tiendas, avisar) {
    console.log('[whatswv] esto es lo que hay:');
    console.table(
      tiendas.map((t) => ({
        base: t.base,
        tienda: t.tienda,
        clase: t.clase ?? '(no se reconocio)',
        muestra: t.muestra,
      })),
    );

    for (const t of tiendas) {
      if (t.clase || !t.muestra) continue;
      console.log(`[whatswv] ejemplo de ${t.base} / ${t.tienda}:`);
    }

    const resumen = tiendas
      .filter((t) => t.clase)
      .map((t) => `${t.tienda}=${t.clase}`)
      .join(', ');

    avisar(
      `${tiendas.length} tiendas en ${new Set(tiendas.map((t) => t.base)).size} bases. ` +
        (resumen || 'ninguna reconocida') +
        '. El detalle quedo en la consola.',
    );
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

  (async () => {
    const { avisar, boton } = panel();

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
    };

    boton('Contactos (CSV)', true, async (av) => {
      const n = await sacarContactos(fuentes, av);
      av(`Listo: ${n} contactos en whatswv-contactos.csv`);
    });

    boton('Chats (JSON)', true, async (av) => {
      const n = await sacarChats(fuentes, av);
      av(`Listo: ${n} chats en whatswv-chats.json`);
    });

    boton('Ver que hay', false, (av) => diagnostico(tiendas, av));

    const donde = (t) => (t ? `${t.base}/${t.tienda}` : 'NO ENCONTRADA');
    avisar(`Contactos: ${donde(fuentes.contacto)}. Mensajes: ${donde(fuentes.mensaje)}.`);
  })();
})();
