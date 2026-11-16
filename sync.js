'use strict';

/* =====================================================================
   Sincronización entre dispositivos a través de un repositorio PRIVADO de GitHub.
   - datos.json: libros, citas y categorías (sin fotos), más los borrados.
   - imagenes/<huella>.jpg: cada foto (citas y portadas hechas por ti), una vez.
   Al sincronizar se combinan los dos lados: de cada libro o cita gana la versión
   modificada más tarde, y lo borrado en un sitio se borra en el otro.
   ===================================================================== */

const Sync = (() => {
  const CLAVE = 'sync';
  let ocupado = false;
  let otraVez = false;
  let temporizador = null;
  let estado = { tipo: 'apagado', texto: '' };

  // ---------- Configuración ----------
  function conf() {
    try {
      const c = JSON.parse(ajuste.leer(CLAVE) || 'null');
      return c?.repo && c?.token ? c : null;
    } catch { return null; }
  }
  const guardarConf = c => ajuste.guardar(CLAVE, c ? JSON.stringify(c) : '');
  const limpiarRepo = t => String(t || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');

  // ---------- Utilidades ----------
  function bytesABase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const textoABase64 = t => bytesABase64(new TextEncoder().encode(t));
  const base64ATexto = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0)));
  async function huella(texto) {
    const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(texto));
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  /** JSON con las claves ordenadas, para comparar sin falsos cambios. */
  function estable(v) {
    if (Array.isArray(v)) return '[' + v.map(estable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + estable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v ?? null);
  }
  const fecha = o => String(o?.modificado || '');

  // ---------- GitHub ----------
  class ErrorGH extends Error {
    constructor(estadoHttp, mensaje) { super(mensaje); this.estadoHttp = estadoHttp; }
  }
  async function pedir(c, ruta, { metodo = 'GET', cuerpo = null, crudo = false } = {}) {
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${c.repo}${ruta}`, {
        method: metodo,
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer ' + c.token,
          Accept: crudo ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    } catch {
      throw new ErrorGH(0, 'No hay conexión con GitHub.');
    }
    return r;
  }
  function explicar(r) {
    if (r.status === 401) return new ErrorGH(401, 'La clave de GitHub no es válida o ha caducado. Crea una nueva y vuelve a conectar.');
    if (r.status === 403) return new ErrorGH(403, 'GitHub no deja escribir con esa clave. Revisa que tenga permiso «Contents: Read and write» en el repositorio de datos.');
    if (r.status === 404) return new ErrorGH(404, 'No encuentro el repositorio de datos. Revisa el nombre (usuario/repositorio) y que la clave tenga acceso a él.');
    return new ErrorGH(r.status, 'GitHub ha respondido con un error (' + r.status + '). Lo intento más tarde.');
  }

  async function comprobarRepo(c) {
    const r = await pedir(c, '');
    if (!r.ok) throw explicar(r);
    const info = await r.json();
    if (info.permissions && info.permissions.push === false) {
      throw new ErrorGH(403, 'La clave puede leer el repositorio pero no escribir en él. Dale permiso «Contents: Read and write».');
    }
    return info;
  }

  async function leerDatos(c) {
    const r = await pedir(c, '/contents/datos.json');
    if (r.status === 404) {
      await comprobarRepo(c); // distingue "aún no hay datos" de "repositorio mal escrito"
      return { datos: null, sha: null };
    }
    if (!r.ok) throw explicar(r);
    const meta = await r.json();
    let texto;
    if (meta.content && meta.encoding === 'base64') {
      texto = base64ATexto(meta.content);
    } else {
      const r2 = await pedir(c, '/contents/datos.json', { crudo: true });
      if (!r2.ok) throw explicar(r2);
      texto = await r2.text();
    }
    return { datos: JSON.parse(texto), sha: meta.sha };
  }

  async function escribirDatos(c, datos, sha) {
    const r = await pedir(c, '/contents/datos.json', {
      metodo: 'PUT',
      cuerpo: { message: 'Mis Libros: sincronización', content: textoABase64(JSON.stringify(datos)), ...(sha ? { sha } : {}) },
    });
    if (r.status === 409 || r.status === 422) return false; // otro dispositivo escribió antes: se repite
    if (!r.ok) throw explicar(r);
    return true;
  }

  async function subirImagen(c, h, dataURL) {
    const r = await pedir(c, `/contents/imagenes/${h}.jpg`, {
      metodo: 'PUT',
      cuerpo: { message: 'Mis Libros: foto', content: String(dataURL).split(',')[1] },
    });
    if (r.ok || r.status === 422) return true; // 422: ya estaba subida
    throw explicar(r);
  }

  async function bajarImagen(c, h) {
    const r = await pedir(c, `/contents/imagenes/${h}.jpg`, { crudo: true });
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const tipo = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : 'image/jpeg';
    return `data:${tipo};base64,${bytesABase64(bytes)}`;
  }

  // ---------- Fotos: se guardan aparte y se nombran por su huella ----------
  const CAMPO_FOTO = { libros: 'portada', citas: 'imagen' };

  /** Copia para subir: las fotos (data:) se cambian por "img:<huella>". */
  async function haciaRemoto(coleccion, o, c, imagenesRemotas) {
    const campo = CAMPO_FOTO[coleccion];
    if (!campo) return { ...o };
    const copia = { ...o };
    const valor = o[campo];
    const campoH = campo + 'H';
    const campoL = campo + 'Largo';
    if (String(valor || '').startsWith('data:')) {
      if (!o[campoH] || o[campoL] !== valor.length) {
        o[campoH] = await huella(valor);
        o[campoL] = valor.length;
        await BD.ponerCrudo(coleccion, o);
      }
      if (!imagenesRemotas.has(o[campoH])) {
        await subirImagen(c, o[campoH], valor);
        imagenesRemotas.add(o[campoH]);
      }
      copia[campo] = 'img:' + o[campoH];
    } else if (!valor && o[campoH]) {
      copia[campo] = 'img:' + o[campoH]; // la foto aún no se había podido bajar
    }
    delete copia[campoL];
    return copia;
  }

  /** Copia para guardar aquí: "img:<huella>" se cambia por la foto descargada. */
  async function desdeRemoto(coleccion, o, c) {
    const campo = CAMPO_FOTO[coleccion];
    const copia = { ...o };
    if (campo && String(o[campo] || '').startsWith('img:')) {
      const h = o[campo].slice(4);
      const local = coleccion === 'libros' ? libroPorId(o.id) : E.citas.find(x => x.id === o.id);
      const yaLaTengo = local && local[campo + 'H'] === h && String(local[campo] || '').startsWith('data:');
      copia[campo] = yaLaTengo ? local[campo] : (await bajarImagen(c, h)) || '';
      copia[campo + 'H'] = h;
      if (copia[campo]) copia[campo + 'Largo'] = copia[campo].length;
    }
    return copia;
  }

  // ---------- Combinar ----------
  async function sincronizar(manual = false) {
    const c = conf();
    if (!c) return;
    if (ocupado) { otraVez = true; return; }
    if (sinConexion()) { ponerEstado('pausa', 'Sin conexión: se sincronizará al volver la cobertura.'); return; }
    ocupado = true;
    clearTimeout(temporizador);
    ponerEstado('trabajando', 'Sincronizando…');
    let huboCambiosAqui = false;
    try {
      for (let intento = 0; intento < 4; intento++) {
        const { datos: remoto, sha } = await leerDatos(c);
        const r = remoto || {};

        // Borrados de los dos lados
        const borradosLocales = await BD.todos('borrados');
        const borrados = { ...(r.borrados || {}) };
        for (const b of borradosLocales) if (!borrados[b.id] || borrados[b.id] < b.fecha) borrados[b.id] = b.fecha;

        const final = { libros: [], citas: [], categorias: [] };
        const traer = { libros: [], citas: [], categorias: [] };
        const quitar = { libros: [], citas: [] };
        for (const col of ['libros', 'citas', 'categorias']) {
          const clave = col === 'categorias' ? 'orden' : 'id';
          const locales = new Map(E[col].map(o => [o[clave], o]));
          const remotos = new Map((r[col] || []).map(o => [o[clave], o]));
          for (const k of new Set([...locales.keys(), ...remotos.keys()])) {
            const L = locales.get(k);
            const R = remotos.get(k);
            const b = col === 'categorias' ? null : borrados[k];
            if (b && b >= fecha(L) && b >= fecha(R)) {
              if (L) quitar[col].push(L);
              continue;
            }
            if (L && (!R || fecha(L) >= fecha(R))) final[col].push({ col, o: L, local: true });
            else { final[col].push({ col, o: R, local: false }); traer[col].push(R); }
          }
        }

        // 1) Traer lo que es más nuevo en el otro dispositivo
        for (const col of ['libros', 'citas']) {
          for (const L of quitar[col]) {
            await BD.borrarCrudo(col, L.id);
            E[col] = E[col].filter(x => x.id !== L.id);
            if (col === 'libros' && E.sel === L.id) E.sel = null;
            huboCambiosAqui = true;
          }
        }
        for (const col of ['libros', 'citas', 'categorias']) {
          for (const R of traer[col]) {
            const o = await desdeRemoto(col, R, c);
            await BD.ponerCrudo(col, o);
            const clave = col === 'categorias' ? 'orden' : 'id';
            const i = E[col].findIndex(x => x[clave] === o[clave]);
            if (i >= 0) Object.assign(E[col][i], o); else E[col].push(o);
            huboCambiosAqui = true;
          }
        }
        for (const [id, f] of Object.entries(borrados)) await BD.ponerCrudo('borrados', { id, fecha: f });

        // 2) Preparar la versión combinada (subiendo las fotos nuevas)
        const imagenes = new Set(r.imagenes || []);
        const salida = { app: 'MisLibros', formato: 'sync-1', libros: [], citas: [], categorias: [], borrados };
        for (const col of ['libros', 'citas', 'categorias']) {
          for (const { o, local } of final[col]) {
            const actual = local ? o : (col === 'categorias' ? E.categorias.find(x => x.orden === o.orden) : E[col].find(x => x.id === o.id)) || o;
            salida[col].push(await haciaRemoto(col, actual, c, imagenes));
          }
        }
        salida.libros.sort((x, y) => String(x.id).localeCompare(String(y.id)));
        salida.citas.sort((x, y) => String(x.id).localeCompare(String(y.id)));
        salida.categorias.sort((x, y) => x.orden - y.orden);
        salida.imagenes = [...imagenes].sort();

        // 3) Escribir solo si algo ha cambiado
        const sinFecha = d => { const x = { ...d }; delete x.actualizado; return estable(x); };
        if (remoto && sinFecha(remoto) === sinFecha(salida)) break;
        salida.actualizado = ahora();
        if (await escribirDatos(c, salida, sha)) break;
        if (intento === 3) throw new ErrorGH(409, 'Otro dispositivo está sincronizando a la vez. Lo intento de nuevo enseguida.');
      }
      ajuste.guardar('ultimaSync', ahora());
      ponerEstado('ok', 'Sincronizado');
      if (manual) avisar('Sincronizado');
    } catch (e) {
      const texto = e instanceof ErrorGH ? e.message : 'No se ha podido sincronizar.';
      ponerEstado(e.estadoHttp === 0 ? 'pausa' : 'error', texto);
      if (manual) avisar(texto);
    } finally {
      ocupado = false;
      if (huboCambiosAqui) repintarConCuidado();
      if (otraVez) { otraVez = false; programar(1500); }
    }
  }

  /** Repinta sin estropear lo que estés escribiendo en ese momento. */
  function repintarConCuidado() {
    E.libros.sort((a, b) => String(b.fechaAlta).localeCompare(String(a.fechaAlta)));
    const foco = document.activeElement;
    const escribiendo = foco && /INPUT|TEXTAREA/.test(foco.tagName) && (foco.closest('#ficha') || foco.closest('#ventanas'));
    if (escribiendo || $('#ventanas').innerHTML) pintarColumna();
    else pintarTodo();
  }

  function programar(ms = 4000) {
    if (!conf()) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => sincronizar(), ms);
  }

  // ---------- Estado visible ----------
  function ponerEstado(tipo, texto) {
    estado = { tipo, texto };
    const b = $('#estado-sync');
    if (b) {
      b.hidden = tipo === 'apagado';
      b.dataset.estado = tipo;
      b.title = texto;
      b.setAttribute('aria-label', 'Sincronización: ' + texto);
    }
    const t = $('#texto-sync');
    if (t) t.textContent = textoEstado();
  }
  function textoEstado() {
    const ultima = ajuste.leer('ultimaSync');
    if (estado.tipo === 'ok' || (estado.tipo === 'apagado' && ultima)) return 'Última sincronización: ' + (ultima ? hace(ultima) : 'ahora');
    return estado.texto || (ultima ? 'Última sincronización: ' + hace(ultima) : '');
  }

  // ---------- Pantalla de ajustes ----------
  function htmlAjustes() {
    const c = conf();
    if (c) {
      return `<div class="bloque-copia" id="bloque-sync">
        <h3 class="seccion" style="margin:0;font-size:15px">Sincronizar entre dispositivos</h3>
        <p class="ayuda">Conectado a <b>${esc(c.repo)}</b>. Tus libros, citas y fotos se guardan también ahí y se combinan con tus otros dispositivos.</p>
        <p class="ayuda" id="texto-sync">${esc(textoEstado())}</p>
        <div class="botones">
          <button type="button" class="boton principal" data-sync="ahora">Sincronizar ahora</button>
          <button type="button" class="boton" data-sync="desconectar">Desconectar este dispositivo</button>
        </div></div>`;
    }
    return `<div class="bloque-copia" id="bloque-sync">
      <h3 class="seccion" style="margin:0;font-size:15px">Sincronizar entre dispositivos</h3>
      <p class="ayuda">Guarda tus libros en un repositorio <b>privado</b> de GitHub y tenlos iguales en el iPhone y en el ordenador. Los pasos para crearlo están en el LEEME.</p>
      <label class="etiqueta-campo">Repositorio de datos (usuario/nombre)
        <input class="campo" id="sync-repo" placeholder="javimaltes/lecturas-datos" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label class="etiqueta-campo">Clave de GitHub (token)
        <input class="campo" id="sync-token" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="botones"><button type="button" class="boton principal" data-sync="conectar">Conectar</button></div>
      <p class="ayuda" id="sync-resultado"></p></div>`;
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-sync]');
    if (!b) return;
    const que = b.dataset.sync;
    if (que === 'ahora') { await sincronizar(true); const t = $('#texto-sync'); if (t) t.textContent = textoEstado(); }
    if (que === 'desconectar') {
      guardarConf(null);
      ponerEstado('apagado', '');
      $('#bloque-sync').outerHTML = htmlAjustes();
      avisar('Este dispositivo ya no se sincroniza. Tus libros siguen aquí.');
    }
    if (que === 'conectar') {
      const salida = $('#sync-resultado');
      const c = { repo: limpiarRepo($('#sync-repo').value), token: $('#sync-token').value.trim() };
      if (!/^[\w.-]+\/[\w.-]+$/.test(c.repo)) { salida.textContent = 'Escribe el repositorio como usuario/nombre, por ejemplo javimaltes/lecturas-datos.'; return; }
      if (!c.token) { salida.textContent = 'Pega la clave (token) de GitHub.'; return; }
      b.disabled = true;
      salida.innerHTML = '<span class="cargando"></span> Comprobando…';
      try {
        const info = await comprobarRepo(c);
        if (!info.private) {
          salida.innerHTML = '<b class="mal">Ese repositorio es público</b>: cualquiera podría ver tus libros y notas. Hazlo privado (Settings → General → Danger Zone → Change visibility) o crea uno privado.';
          b.disabled = false;
          return;
        }
        guardarConf(c);
        salida.innerHTML = '<span class="cargando"></span> Conectado. Sincronizando por primera vez…';
        await sincronizar(true);
        const bloque = $('#bloque-sync');
        if (bloque) bloque.outerHTML = htmlAjustes();
      } catch (err) {
        salida.textContent = err instanceof ErrorGH ? err.message : 'No se ha podido conectar.';
        b.disabled = false;
      }
    }
  });

  // ---------- Arranque ----------
  function arrancar() {
    window.alCambiarDatos = () => programar();
    if (conf()) {
      ponerEstado('ok', 'Sincronizado');
      sincronizar();
    } else {
      ponerEstado('apagado', '');
    }
    // Estos avisos sirven también si conectas más tarde (sin conexión configurada no hacen nada).
    addEventListener('online', () => programar(1500));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') programar(500);
      else if (temporizador) { clearTimeout(temporizador); sincronizar(); } // sube lo pendiente al salir
    });
    setInterval(() => { if (document.visibilityState === 'visible') programar(100); }, 5 * 60 * 1000);
  }

  return { arrancar, sincronizar, htmlAjustes, programar };
})();
window.Sync = Sync;
