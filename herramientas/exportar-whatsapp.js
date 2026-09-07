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
 * una herramienta hecha así se rompe sola cada pocas semanas. Los nombres de la
 * base ("contact", "chat", "message") vienen del modelo de datos y llevan años
 * iguales.
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

  // --- lectura de la base ----------------------------------------------------

  /** Los nombres de tienda que buscamos, en el orden en que los preferimos. */
  const TIENDAS = {
    contacto: ['contact', 'contacts'],
    chat: ['chat', 'chats'],
    mensaje: ['message', 'messages'],
  };

  async function abrirBase() {
    const bases = await indexedDB.databases();

    for (const { name } of bases) {
      if (!name) continue;

      const db = await new Promise((ok, mal) => {
        const p = indexedDB.open(name);
        p.onsuccess = () => ok(p.result);
        p.onerror = () => mal(p.error);
        // Si la pagina esta usando la base con otra version, no forzamos nada.
        p.onblocked = () => mal(new Error('base ocupada'));
      }).catch(() => null);

      if (!db) continue;

      const tiene = (candidatos) => candidatos.find((c) => db.objectStoreNames.contains(c));
      const contacto = tiene(TIENDAS.contacto);
      const mensaje = tiene(TIENDAS.mensaje);

      if (contacto || mensaje) {
        return { db, contacto, mensaje, chat: tiene(TIENDAS.chat) };
      }

      db.close();
    }

    return null;
  }

  /**
   * Recorre una tienda entera con un cursor.
   *
   * Con cursor y no con getAll(): la tienda de mensajes de un numero de trabajo
   * puede tener cientos de miles de filas, y getAll() las arma todas en memoria
   * de golpe y cuelga la pestana.
   */
  function recorrer(db, tienda, porCada) {
    return new Promise((ok, mal) => {
      const t = db.transaction(tienda, 'readonly');
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
        cursor.continue();
      };

      p.onerror = () => mal(p.error);
      t.onerror = () => mal(t.error);
    });
  }

  // --- entender lo que hay adentro -------------------------------------------

  /** El identificador puede venir como texto o como objeto, segun la version. */
  function comoTexto(id) {
    if (typeof id === 'string') return id;
    if (id && typeof id === 'object') return id._serialized || id.id || '';
    return '';
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

  const NOMBRES = ['name', 'saved_name', 'verifiedName', 'pushname', 'notify', 'formattedName', 'shortName'];

  function nombreDe(fila) {
    for (const campo of NOMBRES) {
      const v = fila?.[campo];
      if (typeof v === 'string' && v.trim() && !/^\+?\d[\d\s()-]*$/.test(v.trim())) {
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
    const id = comoTexto(fila?.id) || comoTexto(clave);
    const partes = id.split('_');
    if (partes.length < 3) return null;
    return { mio: partes[0] === 'true', jid: partes[1] };
  }

  /** El texto de un mensaje: el cuerpo, o el pie de foto si es multimedia. */
  function textoDe(fila) {
    const t = fila?.body ?? fila?.caption ?? '';
    return typeof t === 'string' ? t.trim() : '';
  }

  // --- armar los archivos ----------------------------------------------------

  /** Una celda de CSV. Entre comillas si trae coma, comilla o salto de linea. */
  function celda(valor) {
    const t = String(valor ?? '');
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
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

  async function sacarContactos(base, avisar) {
    if (!base.contacto) throw new Error('esta version no tiene la tienda de contactos');

    const porTelefono = new Map();

    await recorrer(base.db, base.contacto, (fila, clave) => {
      const telefono = telefonoDe(comoTexto(fila?.id) || comoTexto(clave));
      if (!telefono) return;

      const nombre = nombreDe(fila);
      // Si el mismo numero aparece dos veces, gana el que traiga nombre.
      if (!porTelefono.has(telefono) || (nombre && !porTelefono.get(telefono))) {
        porTelefono.set(telefono, nombre);
      }
    });

    avisar(`${porTelefono.size} contactos`);

    const filas = [['telefono', 'nombre'].join(',')];
    for (const [telefono, nombre] of porTelefono) {
      filas.push(celda(telefono) + ',' + celda(nombre ?? ''));
    }

    // El BOM del principio es para que Excel abra el archivo como UTF-8; sin el
    // muestra "salÃ³n" donde dice "salón".
    bajar('whatswv-contactos.csv', '\ufeff' + filas.join('\n') + '\n', 'text/csv;charset=utf-8');
    return porTelefono.size;
  }

  async function sacarChats(base, avisar) {
    if (!base.mensaje) throw new Error('esta version no tiene la tienda de mensajes');

    // Los nombres salen de los contactos, que es donde estan bien; el chat solo
    // se usa de respaldo para los que no estan en la agenda.
    const nombres = new Map();

    if (base.contacto) {
      await recorrer(base.db, base.contacto, (fila, clave) => {
        const telefono = telefonoDe(comoTexto(fila?.id) || comoTexto(clave));
        const nombre = nombreDe(fila);
        if (telefono && nombre) nombres.set(telefono, nombre);
      });
    }

    if (base.chat) {
      await recorrer(base.db, base.chat, (fila, clave) => {
        const telefono = telefonoDe(comoTexto(fila?.id) || comoTexto(clave));
        const nombre = nombreDe(fila) || (typeof fila?.formattedTitle === 'string' ? fila.formattedTitle : null);
        if (telefono && nombre && !nombres.has(telefono)) nombres.set(telefono, nombre);
      });
    }

    const chats = new Map();
    let leidos = 0;
    let ultimoAviso = 0;

    await recorrer(base.db, base.mensaje, (fila, clave) => {
      leidos++;
      if (leidos - ultimoAviso >= 5000) {
        ultimoAviso = leidos;
        avisar(`${leidos.toLocaleString('es')} mensajes leidos…`);
      }

      const de = deQuienEs(fila, clave);
      if (!de) return;

      const telefono = telefonoDe(de.jid);
      if (!telefono) return;

      const texto = textoDe(fila);
      if (!texto) return;

      // `t` viene en segundos. Sin fecha no sirve: quedaria fuera de orden en el
      // hilo y el importador no podria calcularle un identificador estable.
      const segundos = Number(fila?.t ?? fila?.timestamp);
      if (!Number.isFinite(segundos) || segundos <= 0) return;

      if (!chats.has(telefono)) chats.set(telefono, []);
      chats.get(telefono).push({
        cuando: new Date(segundos * 1000).toISOString(),
        mio: de.mio,
        texto,
      });
    });

    const salida = [];
    for (const [telefono, mensajes] of chats) {
      mensajes.sort((a, b) => a.cuando.localeCompare(b.cuando));
      salida.push({ telefono, nombre: nombres.get(telefono) ?? null, mensajes });
    }

    // Primero los que mas conversacion tienen: si el archivo hay que revisarlo a
    // mano, lo que importa esta arriba.
    salida.sort((a, b) => b.mensajes.length - a.mensajes.length);

    avisar(`${salida.length} chats, ${leidos.toLocaleString('es')} mensajes revisados`);
    bajar(
      'whatswv-chats.json',
      JSON.stringify({ exportado: new Date().toISOString(), chats: salida }, null, 1),
      'application/json',
    );

    return salida.length;
  }

  /**
   * Qué encontró, sin exportar nada.
   *
   * Está para cuando algo no cuadra: si WhatsApp cambia los nombres de sus
   * tiendas, esto lo dice en una línea y se arregla el script, en vez de quedar
   * adivinando por qué salió vacío.
   */
  async function diagnostico(base, avisar) {
    const partes = [];
    for (const tienda of [base.contacto, base.chat, base.mensaje]) {
      if (!tienda) continue;
      let n = 0;
      await recorrer(base.db, tienda, () => n++);
      partes.push(`${tienda}: ${n.toLocaleString('es')}`);
    }
    avisar(`${base.db.name} — ${partes.join(' · ') || 'sin tiendas conocidas'}`);
    console.log('[whatswv] tiendas en', base.db.name, [...base.db.objectStoreNames]);
  }

  // --- el panel --------------------------------------------------------------

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
    estado.textContent = 'Buscando la base…';

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
        principal ? `background:${VERDE};color:#fff;border:0` : 'background:#fff;color:#444;border:1px solid #d4d4d8',
      ].join(';');

      b.onclick = async () => {
        const antes = b.textContent;
        // Se desactivan los dos: dos lecturas a la vez sobre la misma base se
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

  // --- arranque --------------------------------------------------------------

  (async () => {
    const { avisar, boton } = panel();

    let base;
    try {
      base = await abrirBase();
    } catch (e) {
      avisar('No se pudo abrir la base: ' + (e?.message ?? e));
      return;
    }

    if (!base) {
      avisar(
        'No encontre la base de WhatsApp. Revisa que esto sea la pestana de web.whatsapp.com con la sesion abierta y los chats cargados.',
      );
      return;
    }

    boton('Contactos (CSV)', true, async (av) => {
      const n = await sacarContactos(base, av);
      av(`Listo: ${n} contactos en whatswv-contactos.csv`);
    });

    boton('Chats (JSON)', true, async (av) => {
      const n = await sacarChats(base, av);
      av(`Listo: ${n} chats en whatswv-chats.json`);
    });

    boton('Ver que hay', false, (av) => diagnostico(base, av));

    avisar(`Base "${base.db.name}" lista. Elige que exportar.`);
  })();
})();
