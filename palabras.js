'use strict';

/* =====================================================================
   Palabras y tarjetas
   - Busca palabras en español, inglés o alemán (Wiktionary + traducción de MyMemory).
   - Cada palabra guardada es una tarjeta, unida al libro donde la encontraste.
   - Repaso por cajas: lo que sabes vuelve cada vez más tarde; lo que fallas, enseguida.
   ===================================================================== */

const Palabras = (() => {
  const IDIOMAS = {
    en: { nombre: 'Inglés', corto: 'EN', voz: 'en-GB' },
    de: { nombre: 'Alemán', corto: 'DE', voz: 'de-DE' },
    es: { nombre: 'Español', corto: 'ES', voz: 'es-ES' },
  };
  const INTERVALOS = [0, 1, 3, 7, 16, 35, 90]; // días hasta el próximo repaso, según la caja
  const filtro = { idioma: '', libro: '', texto: '' };
  const DIA = 24 * 3600 * 1000;

  const ahoraMs = () => Date.now();
  const pendientesDeRepaso = lista => lista.filter(p => !p.proxima || new Date(p.proxima).getTime() <= ahoraMs());
  const palabrasDe = libroId => E.palabras.filter(p => p.libroId === libroId);
  const idiomaPorDefecto = l => l?.idioma || ajuste.leer('ultimoIdioma') || 'en';
  const puedeHablar = () => 'speechSynthesis' in window;

  // ---------- Búsqueda en diccionarios ----------
  function variantes(palabra, idioma) {
    const p = palabra.trim();
    const lista = [p, p.toLowerCase()];
    if (idioma === 'de') lista.push(p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()); // sustantivos alemanes
    return [...new Set(lista)].filter(Boolean);
  }

  const TIPOS = {
    noun: 'sustantivo', verb: 'verbo', adjective: 'adjetivo', adverb: 'adverbio', pronoun: 'pronombre',
    preposition: 'preposición', conjunction: 'conjunción', interjection: 'interjección', article: 'artículo',
    determiner: 'determinante', numeral: 'numeral', particle: 'partícula', phrase: 'expresión',
    'proper noun': 'nombre propio', idiom: 'modismo', 'prepositional phrase': 'locución', contraction: 'contracción',
  };
  const traducirTipo = t => TIPOS[String(t || '').toLowerCase()] || String(t || '').toLowerCase();

  /** en.wiktionary.org: definiciones (en inglés) de palabras en inglés, alemán o español. */
  async function wiktionaryIngles(palabra, idioma) {
    let ultimoError = null;
    for (const forma of variantes(palabra, idioma)) {
      const r = await pedirJSON('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(forma.replace(/ /g, '_')) + '?redirect=true');
      if (r.error) {
        if (/404/.test(r.error)) continue;
        ultimoError = r.error;
        continue;
      }
      const defs = [];
      for (const s of r.datos?.[idioma] || []) {
        for (const d of s.definitions || []) {
          const texto = quitarHTML(d.definition || '').replace(/\s+/g, ' ').trim();
          const ejemplo = quitarHTML((d.examples || [])[0] || '').replace(/\s+/g, ' ').trim();
          if (texto) defs.push({ tipo: traducirTipo(s.partOfSpeech), texto, ejemplo });
        }
      }
      if (defs.length) return { forma, defs: defs.slice(0, 6) };
    }
    return { defs: [], error: ultimoError };
  }

  /** es.wiktionary.org: definiciones en español de palabras en español. */
  async function wiktionaryEspanol(palabra) {
    let ultimoError = null;
    for (const forma of variantes(palabra, 'es')) {
      const r = await pedirJSON('https://es.wiktionary.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&origin=*&redirects=1&page=' + encodeURIComponent(forma));
      if (r.error) { ultimoError = r.error; continue; }
      const wt = r.datos?.parse?.wikitext;
      if (!wt) continue;
      const defs = definicionesWikitext(wt);
      if (defs.length) return { forma, defs: defs.slice(0, 6) };
    }
    return { defs: [], error: ultimoError };
  }

  function definicionesWikitext(wt) {
    const ini = wt.search(/==\s*\{\{lengua\|es\}\}\s*==/);
    if (ini < 0) return [];
    let seccion = wt.slice(ini + 5);
    const fin = seccion.search(/\n==\s*\{\{lengua\|/);
    if (fin >= 0) seccion = seccion.slice(0, fin);
    const defs = [];
    let tipo = '';
    for (const linea of seccion.split('\n')) {
      const t = linea.match(/^===+\s*\{\{([^|}]+)/);
      if (t) { tipo = t[1].trim(); continue; }
      const m = linea.match(/^;\s*\d+[^:]*:\s*(.+)$/);
      if (m) {
        const texto = limpiarWiki(m[1]);
        if (texto && texto.length > 2) defs.push({ tipo, texto, ejemplo: '' });
      }
    }
    return defs;
  }

  function limpiarWiki(t) {
    let s = String(t);
    s = s.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
    // plantillas que muestran una palabra: {{plm|casa}}, {{l|es|casa}}, {{l+|es|casa}}
    s = s.replace(/\{\{(?:plm|l\+?|ll)\|(?:[a-z]{2,3}\|)?([^|{}]+)[^{}]*\}\}/gi, '$1');
    // el resto de plantillas se quitan (pueden ir unas dentro de otras)
    for (let i = 0; i < 6 && /\{\{[^{}]*\}\}/.test(s); i++) s = s.replace(/\{\{[^{}]*\}\}/g, '');
    s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/<[^>]+>/g, '');
    return s.replace(/\s+/g, ' ').replace(/^[\s,.;:]+/, '').trim();
  }

  /** Traducción al español con MyMemory (gratis, sin clave). */
  async function traducir(palabra, de) {
    const r = await pedirJSON(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(palabra.trim())}&langpair=${de}|es`);
    if (r.error) return { lista: [], error: r.error };
    const limpia = t => String(t || '').replace(/^[\s"'«»]+|[\s"'«».;:,]+$/g, '').trim();
    const candidatas = [r.datos?.responseData?.translatedText, ...(r.datos?.matches || []).map(m => m.translation)]
      .map(limpia)
      .filter(t => t && !/MYMEMORY|QUOTA|INVALID/i.test(t) && t.toLowerCase() !== palabra.trim().toLowerCase() && t.length < 60);
    const vistas = new Set();
    const lista = [];
    for (const t of candidatas) {
      const k = t.toLowerCase();
      if (vistas.has(k)) continue;
      vistas.add(k);
      lista.push(t);
    }
    return { lista: lista.slice(0, 4) };
  }

  async function buscar(palabra, idioma) {
    palabra = palabra.trim();
    if (sinConexion()) return { palabra, idioma, traducciones: [], definiciones: [], sinRed: true };
    let defs;
    let trad = { lista: [] };
    let definicionesEnIngles = false;
    if (idioma === 'es') {
      defs = await wiktionaryEspanol(palabra);
      if (!defs.defs.length && !defs.error) {
        defs = await wiktionaryIngles(palabra, 'es');
        definicionesEnIngles = defs.defs.length > 0;
      }
    } else {
      [defs, trad] = await Promise.all([wiktionaryIngles(palabra, idioma), traducir(palabra, idioma)]);
    }
    const nada = !defs.defs.length && !trad.lista.length;
    const sinRed = nada && ERRORES_RED.includes(defs.error) && (idioma === 'es' || ERRORES_RED.includes(trad.error));
    return {
      palabra: idioma === 'de' && defs.forma && defs.forma !== palabra && defs.forma.toLowerCase() === palabra.toLowerCase() ? defs.forma : palabra,
      idioma, traducciones: trad.lista, definiciones: defs.defs, definicionesEnIngles, sinRed,
    };
  }

  // ---------- Guardar y repasar ----------
  function nuevaPalabra(r, libroId, frase, pagina) {
    return {
      id: uid(), libroId: libroId || '', palabra: r.palabra, idioma: r.idioma,
      traducciones: r.traducciones || [], definiciones: r.definiciones || [], definicionesEnIngles: !!r.definicionesEnIngles,
      frase: frase || '', pagina: pagina || 0, nota: '', caja: 0, proxima: ahora(), aciertos: 0, fallos: 0, fecha: ahora(),
      ...(r.sinRed ? { pendiente: true } : {}),
    };
  }
  async function guardar(p) {
    await BD.poner('palabras', p);
  }
  function calificar(p, nota) {
    if (nota === 'otra') {
      p.caja = 0;
      p.proxima = ahora();
      p.fallos = (p.fallos || 0) + 1;
    } else if (nota === 'dificil') {
      p.caja = Math.max(1, p.caja || 0);
      p.proxima = new Date(ahoraMs() + DIA).toISOString();
    } else {
      p.caja = Math.min(INTERVALOS.length - 1, (p.caja || 0) + 1);
      p.proxima = new Date(ahoraMs() + INTERVALOS[p.caja] * DIA).toISOString();
      p.aciertos = (p.aciertos || 0) + 1;
    }
    guardar(p);
  }
  function cuandoToca(p) {
    if (!p.proxima || new Date(p.proxima).getTime() <= ahoraMs()) return 'toca hoy';
    const dias = Math.round((new Date(p.proxima).getTime() - ahoraMs()) / DIA);
    return dias <= 1 ? 'mañana' : `en ${dias} días`;
  }

  function hablar(texto, idioma) {
    if (!puedeHablar()) return;
    try {
      const u = new SpeechSynthesisUtterance(texto);
      u.lang = IDIOMAS[idioma]?.voz || 'es-ES';
      const voz = speechSynthesis.getVoices().find(v => (v.lang || '').toLowerCase().startsWith(idioma));
      if (voz) u.voice = voz;
      u.rate = 0.9;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* sin voz */ }
  }

  /** Completa las palabras guardadas sin conexión. */
  let completando = false;
  async function completarPendientes() {
    if (completando || sinConexion()) return;
    const lista = E.palabras.filter(p => p.pendiente);
    if (!lista.length) return;
    completando = true;
    let hechas = 0;
    for (const p of lista) {
      const r = await buscar(p.palabra, p.idioma);
      if (r.sinRed) break;
      if (!p.traducciones?.length) p.traducciones = r.traducciones;
      if (!p.definiciones?.length) { p.definiciones = r.definiciones; p.definicionesEnIngles = r.definicionesEnIngles; }
      delete p.pendiente;
      await guardar(p);
      hechas++;
    }
    completando = false;
    if (hechas) {
      avisar(hechas === 1 ? 'Completada 1 palabra guardada sin conexión' : `Completadas ${hechas} palabras guardadas sin conexión`);
      if (E.vista === 'palabras') pintarColumna();
    }
  }

  // ---------- Trozos de pantalla ----------
  const insignia = idioma => `<span class="insignia-idioma" title="${esc(IDIOMAS[idioma]?.nombre || '')}">${esc(IDIOMAS[idioma]?.corto || idioma)}</span>`;
  const botonHablar = (texto, idioma) => puedeHablar()
    ? `<button type="button" class="boton icono-solo plano" data-accion="hablar" data-texto="${esc(texto)}" data-idioma="${idioma}" aria-label="Escuchar">${icono('altavoz')}</button>` : '';
  function resumenSignificado(p) {
    if (p.traducciones?.length) return p.traducciones.slice(0, 3).join(', ');
    return p.definiciones?.[0]?.texto || (p.pendiente ? 'Se completará al volver la conexión' : 'Sin traducción');
  }
  function fraseMarcada(frase, palabra) {
    if (!frase) return '';
    const seguro = esc(frase);
    const patron = palabra.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return seguro.replace(new RegExp(`(${patron})`, 'gi'), '<mark>$1</mark>'); } catch { return seguro; }
  }
  function cajitas(p) {
    const n = INTERVALOS.length - 1;
    return `<span class="cajitas" title="Nivel ${p.caja || 0} de ${n}">${Array.from({ length: n }, (_, i) => `<i class="${i < (p.caja || 0) ? 'llena' : ''}"></i>`).join('')}</span>`;
  }

  function seccionFicha(l) {
    const lista = palabrasDe(l.id).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    const toca = pendientesDeRepaso(lista).length;
    return `<section class="seccion">
      <h2>Palabras <span class="espacio"></span><span style="text-transform:none;letter-spacing:0;font-weight:400">${lista.length || ''}</span></h2>
      ${lista.length ? `<div class="etiquetas-libro">${lista.slice(0, 14).map(p => `<button type="button" class="chip" data-accion="ver-palabra" data-id="${p.id}">${esc(p.palabra)}</button>`).join('')}${lista.length > 14 ? `<button type="button" class="boton plano" data-accion="vista-palabras-libro" data-libro="${l.id}">Ver todas</button>` : ''}</div>` : ''}
      <div class="fila-campo" style="flex-wrap:wrap">
        <button type="button" class="boton principal" data-accion="buscar-palabra" data-libro="${l.id}">${icono('buscar')} Buscar una palabra</button>
        ${lista.length ? `<button type="button" class="boton" data-accion="repasar" data-libro="${l.id}">${icono('tarjetas')} Repasar${toca ? ` (${toca})` : ''}</button>` : ''}
      </div>
      <p class="ayuda">En español, inglés o alemán. Cada palabra que guardes se convierte en una tarjeta para repasar.</p>
    </section>`;
  }

  function pintarColumna() {
    const c = $('#columna');
    const librosConPalabras = E.libros.filter(l => E.palabras.some(p => p.libroId === l.id));
    const enFoco = document.activeElement?.id === 'buscar-palabras';
    c.innerHTML = `
      <div class="caja-busqueda">${icono('buscar')}<input id="buscar-palabras" class="campo" type="search" placeholder="Buscar en tus palabras" value="${esc(filtro.texto)}" autocomplete="off"></div>
      <div class="filtros">
        ${[['', 'Todas'], ['en', 'Inglés'], ['de', 'Alemán'], ['es', 'Español']].map(([k, t]) => `<button type="button" class="chip ${filtro.idioma === k ? 'activo' : ''}" data-accion="filtro-idioma" data-idioma="${k}" aria-pressed="${filtro.idioma === k}">${t}</button>`).join('')}
        ${librosConPalabras.length ? `<select class="chip ${filtro.libro ? 'activo' : ''}" id="filtro-libro-palabras" aria-label="Filtrar por libro">
          <option value="">Todos los libros</option>
          ${librosConPalabras.map(l => `<option value="${l.id}" ${filtro.libro === l.id ? 'selected' : ''}>${esc(tituloVisible(l))}</option>`).join('')}
        </select>` : ''}
      </div>
      <div id="banda-repaso"></div>
      <div class="fila-campo"><button type="button" class="boton" data-accion="buscar-palabra" data-libro="${esc(filtro.libro)}">${icono('mas')} Buscar una palabra</button></div>
      <p class="contador" id="contador-palabras"></p>
      <div class="lista" id="lista-palabras"></div>`;
    pintarLista();
    if (enFoco) { const i = $('#buscar-palabras'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  function filtradas() {
    const t = filtro.texto.toLowerCase();
    return E.palabras.filter(p => (!filtro.idioma || p.idioma === filtro.idioma) && (!filtro.libro || p.libroId === filtro.libro))
      .filter(p => !t || [p.palabra, ...(p.traducciones || []), p.frase, p.nota].some(x => String(x || '').toLowerCase().includes(t)))
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  }

  function pintarLista() {
    const cont = $('#lista-palabras');
    if (!cont) return;
    const lista = filtradas();
    const toca = pendientesDeRepaso(lista).length;
    $('#banda-repaso').innerHTML = lista.length ? `<div class="consejo banda-repaso">${icono('tarjetas')}<p>${toca ? `<b>${toca === 1 ? '1 tarjeta' : toca + ' tarjetas'}</b> para repasar hoy.` : 'Hoy no te toca repasar ninguna. Puedes practicar igualmente.'}</p>
      <button type="button" class="boton principal" data-accion="repasar" data-libro="${esc(filtro.libro)}" data-idioma="${esc(filtro.idioma)}">${toca ? 'Repasar' : 'Practicar'}</button></div>` : '';
    $('#contador-palabras').textContent = lista.length === E.palabras.length ? `${lista.length} palabras` : `${lista.length} de ${E.palabras.length} palabras`;
    if (!E.palabras.length) {
      cont.innerHTML = `<div class="vacio">${icono('tarjetas', 'grande-icono')}<h2>Tu vocabulario</h2><p>Abre un libro y pulsa «Buscar una palabra». Las que guardes aparecerán aquí como tarjetas para repasar.</p></div>`;
      return;
    }
    cont.innerHTML = lista.length ? lista.map(p => {
      const l = libroPorId(p.libroId);
      return `<button type="button" class="fila fila-palabra" data-accion="ver-palabra" data-id="${p.id}">
        <span class="fila-texto">
          <span class="fila-titulo">${esc(p.palabra)} ${insignia(p.idioma)}</span>
          <span class="fila-autor">${esc(resumenSignificado(p))}</span>
          <span class="fila-meta"><span>${esc(l ? tituloVisible(l) : 'Sin libro')}${p.pagina ? ' · p. ' + p.pagina : ''}</span><span>${cajitas(p)} ${esc(cuandoToca(p))}</span></span>
        </span></button>`;
    }).join('') : `<div class="vacio"><p>Ninguna palabra coincide.</p></div>`;
  }

  // ---------- Ventana: buscar una palabra ----------
  let idiomaBusqueda = 'en';
  let libroBusqueda = '';
  let ultimoResultado = null;
  function ventanaBuscar(libroId) {
    libroBusqueda = libroId || '';
    const l = libroPorId(libroId);
    idiomaBusqueda = idiomaPorDefecto(l);
    abrirVentana({
      titulo: 'Buscar una palabra',
      cuerpo: `
        ${l ? `<p class="ayuda">En «${esc(tituloVisible(l))}»</p>` : ''}
        <div class="segmentos" id="idiomas-busqueda">${Object.entries(IDIOMAS).map(([k, v]) => `<button type="button" data-accion="idioma-busqueda" data-idioma="${k}" aria-pressed="${idiomaBusqueda === k}">${v.nombre}</button>`).join('')}</div>
        <form class="fila-campo" id="form-palabra"><input class="campo" id="palabra-buscada" placeholder="Escribe la palabra" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><button class="boton principal" type="submit">Buscar</button></form>
        <div id="resultado-palabra"></div>`,
      pie: `<button type="button" class="boton principal" data-accion="cerrar-ventana">Hecho</button>`,
    });
    $('#form-palabra').addEventListener('submit', e => { e.preventDefault(); hacerBusqueda(libroId); });
    setTimeout(() => $('#palabra-buscada')?.focus(), 60);
  }

  async function hacerBusqueda(libroId) {
    const palabra = $('#palabra-buscada').value.trim();
    const cont = $('#resultado-palabra');
    if (!palabra) return;
    cont.innerHTML = `<p class="ayuda"><span class="cargando"></span> Buscando «${esc(palabra)}»…</p>`;
    const r = await buscar(palabra, idiomaBusqueda);
    if (!$('#resultado-palabra') || $('#palabra-buscada').value.trim() !== palabra) return;
    ultimoResultado = r;
    const ya = E.palabras.find(p => p.palabra.toLowerCase() === r.palabra.toLowerCase() && p.idioma === r.idioma && p.libroId === (libroId || ''));
    const nada = !r.traducciones.length && !r.definiciones.length;
    let html = '';
    if (r.sinRed) {
      html = `<div class="consejo">${icono('nube')}<p>Sin conexión. Puedo guardar «${esc(palabra)}» y buscar su significado cuando vuelva la cobertura.</p></div>`;
    } else if (nada) {
      html = `<div class="consejo">${icono('buscar')}<p>No encuentro «${esc(palabra)}» en ${esc(IDIOMAS[idiomaBusqueda].nombre.toLowerCase())}. ¿Está bien escrita y en el idioma correcto? Si es una forma conjugada, prueba con el infinitivo. Puedes guardarla igualmente y escribir tú la traducción.</p></div>`;
    } else {
      html = `<div class="tarjeta-resultado">
        <div class="cab-resultado"><b class="palabra-grande">${esc(r.palabra)}</b>${insignia(r.idioma)}${botonHablar(r.palabra, r.idioma)}</div>
        ${r.traducciones.length ? `<p class="traduccion">${esc(r.traducciones.join(', '))}</p>` : ''}
        ${r.definiciones.length ? `<ol class="definiciones">${r.definiciones.slice(0, 4).map(d => `<li>${d.tipo ? `<i>${esc(d.tipo)}</i> ` : ''}${esc(d.texto)}${d.ejemplo ? `<small>${esc(d.ejemplo)}</small>` : ''}</li>`).join('')}</ol>` : ''}
        ${r.definicionesEnIngles ? '<p class="nota-pequena">Definiciones en inglés (no la he encontrado en el diccionario en español).</p>' : (r.idioma !== 'es' && r.definiciones.length ? '<p class="nota-pequena">Definiciones en inglés, de Wiktionary.</p>' : '')}
      </div>`;
    }
    if (ya) {
      html += `<div class="fila-campo"><span class="ayuda" style="flex:1">Ya la tienes guardada en este libro.</span><button type="button" class="boton" data-accion="ver-palabra" data-id="${ya.id}">Ver tarjeta</button></div>`;
    } else {
      html += `
        <label class="etiqueta-campo">Frase del libro donde aparece (opcional)
          <textarea class="campo" id="frase-palabra" rows="2" placeholder="Te ayudará a recordarla en contexto"></textarea></label>
        <div class="fila-campo" style="align-items:flex-end;flex-wrap:wrap">
          ${nada && !r.sinRed ? `<label class="etiqueta-campo" style="flex:1;min-width:160px">Traducción<input class="campo" id="traduccion-manual" placeholder="Escríbela tú"></label>` : ''}
          <label class="etiqueta-campo" style="width:110px">Página<input class="campo" id="pagina-palabra" type="number" min="0" inputmode="numeric" value="${libroPorId(libroId)?.paginaActual || ''}"></label>
          <span class="espacio"></span>
          <button type="button" class="boton principal" data-accion="guardar-palabra" data-libro="${esc(libroId || '')}">${icono('tarjetas')} Guardar tarjeta</button>
        </div>`;
    }
    cont.innerHTML = html;
  }

  // ---------- Ventana: una palabra ----------
  function ventanaPalabra(id) {
    const p = E.palabras.find(x => x.id === id);
    if (!p) return;
    const l = libroPorId(p.libroId);
    abrirVentana({
      titulo: 'Tarjeta',
      cuerpo: `
        <div class="cab-resultado"><b class="palabra-grande">${esc(p.palabra)}</b>${insignia(p.idioma)}${botonHablar(p.palabra, p.idioma)}</div>
        ${p.pendiente ? `<div class="consejo">${icono('nube')}<p>Guardada sin conexión: buscaré su significado cuando vuelva la cobertura.</p></div>` : ''}
        <label class="etiqueta-campo">${p.idioma === 'es' ? 'Significado (lo que verás al girar la tarjeta)' : 'Traducción (separa varias con comas)'}
          <input class="campo" id="p-traduccion" value="${esc((p.traducciones || []).join(', '))}" placeholder="${p.idioma === 'es' ? 'Opcional: tus propias palabras' : 'Escribe la traducción'}"></label>
        ${p.definiciones?.length ? `<ol class="definiciones">${p.definiciones.slice(0, 4).map(d => `<li>${d.tipo ? `<i>${esc(d.tipo)}</i> ` : ''}${esc(d.texto)}${d.ejemplo ? `<small>${esc(d.ejemplo)}</small>` : ''}</li>`).join('')}</ol>` : ''}
        <label class="etiqueta-campo">Frase del libro<textarea class="campo" id="p-frase" rows="2">${esc(p.frase)}</textarea></label>
        <div class="dos">
          <label class="etiqueta-campo">Página<input class="campo" id="p-pagina" type="number" min="0" inputmode="numeric" value="${p.pagina || ''}"></label>
          <label class="etiqueta-campo">Libro<input class="campo" value="${esc(l ? tituloVisible(l) : 'Sin libro')}" disabled></label>
        </div>
        <label class="etiqueta-campo">Nota<textarea class="campo" id="p-nota" rows="2" placeholder="Un truco para recordarla, una palabra parecida…">${esc(p.nota)}</textarea></label>
        <p class="ayuda">${cajitas(p)} Próximo repaso: ${esc(cuandoToca(p))} · ${p.aciertos || 0} aciertos, ${p.fallos || 0} fallos</p>`,
      pie: `<div class="confirmar" id="zona-borrar-palabra"><button type="button" class="boton peligro" data-accion="pedir-borrar-palabra" data-id="${p.id}">${icono('papelera')} Borrar</button></div>
        <span class="espacio"></span>
        ${!p.pendiente ? `<button type="button" class="boton" data-accion="rebuscar-palabra" data-id="${p.id}">Buscar otra vez</button>` : ''}
        <button type="button" class="boton principal" data-accion="cerrar-ventana">Hecho</button>`,
    });
    const guardarCampos = () => {
      p.traducciones = $('#p-traduccion').value.split(',').map(t => t.trim()).filter(Boolean);
      p.frase = $('#p-frase').value;
      p.nota = $('#p-nota').value;
      p.pagina = parseInt($('#p-pagina').value, 10) || 0;
      guardar(p);
    };
    ['#p-traduccion', '#p-frase', '#p-nota', '#p-pagina'].forEach(s => $(s).addEventListener('input', guardarCampos));
  }

  // ---------- Ventana: repaso ----------
  function ventanaRepaso(libroId, idioma) {
    let ambito = E.palabras.filter(p => (!libroId || p.libroId === libroId) && (!idioma || p.idioma === idioma));
    if (!ambito.length) { avisar('No hay palabras que repasar'); return; }
    let cola = pendientesDeRepaso(ambito);
    const practica = !cola.length;
    if (practica) cola = [...ambito];
    // las más atrasadas primero, con algo de mezcla
    cola.sort((a, b) => String(a.proxima).localeCompare(String(b.proxima)));
    cola = cola.map((p, i) => ({ p, k: i + Math.random() * 4 })).sort((a, b) => a.k - b.k).map(x => x.p).slice(0, 40);
    const total = cola.length;
    const vueltas = new Map();
    const cuenta = { bien: 0, dificil: 0, otra: 0 };
    let actual = null;
    let girada = false;

    const pintar = () => {
      const cuerpo = $('#ventana-cuerpo');
      if (!cuerpo) return;
      if (!cola.length) {
        const hechas = cuenta.bien + cuenta.dificil + cuenta.otra;
        cuerpo.innerHTML = `<div class="vacio">${icono('tarjetas', 'grande-icono')}<h2>¡Repaso terminado!</h2>
          <p>${hechas === 1 ? '1 respuesta' : hechas + ' respuestas'}: ${cuenta.bien} bien, ${cuenta.dificil === 1 ? '1 difícil' : cuenta.dificil + ' difíciles'}, ${cuenta.otra} para repetir.</p>
          <p class="ayuda">Las que sabías volverán más adelante; las difíciles, mañana.</p></div>`;
        $('#ventana-pie').innerHTML = `<span class="espacio"></span><button type="button" class="boton principal" data-accion="cerrar-ventana">Cerrar</button>`;
        return;
      }
      actual = cola[0];
      const p = actual;
      const l = libroPorId(p.libroId);
      const hecho = total - cola.length;
      cuerpo.innerHTML = `
        <div class="progreso-repaso"><span style="width:${Math.round(hecho / total * 100)}%"></span></div>
        <p class="ayuda" style="text-align:center">${practica ? 'Práctica libre · ' : ''}${hecho + 1} de ${total}${vueltas.get(p.id) ? ' · otra vez' : ''}</p>
        <button type="button" class="tarjeta-flash ${girada ? 'girada' : ''}" data-accion="girar-tarjeta">
          <span class="cara">
            ${insignia(p.idioma)}
            <b class="palabra-tarjeta">${esc(p.palabra)}</b>
            ${p.frase ? `<span class="frase-tarjeta">${fraseMarcada(p.frase, p.palabra)}</span>` : ''}
            ${!girada ? '<span class="nota-pequena">Toca para ver la respuesta</span>' : ''}
          </span>
          ${girada ? `<span class="reverso">
            <span class="traduccion">${esc(resumenSignificado(p))}</span>
            ${p.definiciones?.length && p.traducciones?.length ? `<span class="def-tarjeta">${esc(p.definiciones[0].texto)}</span>` : ''}
            ${p.definiciones?.length > 1 && !p.traducciones?.length ? `<span class="def-tarjeta">${esc(p.definiciones[1].texto)}</span>` : ''}
            ${p.nota ? `<span class="def-tarjeta"><i>${esc(p.nota)}</i></span>` : ''}
            <span class="nota-pequena">${esc(l ? tituloVisible(l) : '')}${p.pagina ? ' · p. ' + p.pagina : ''}</span>
          </span>` : ''}
        </button>
        ${puedeHablar() ? `<div style="text-align:center">${botonHablar(p.palabra, p.idioma)}</div>` : ''}`;
      $('#ventana-pie').innerHTML = girada
        ? `<div class="botones-nota">
            <button type="button" class="boton nota-otra" data-accion="nota-repaso" data-nota="otra"><b>Otra vez</b><small>No me la sabía</small></button>
            <button type="button" class="boton nota-dificil" data-accion="nota-repaso" data-nota="dificil"><b>Difícil</b><small>Mañana</small></button>
            <button type="button" class="boton nota-bien" data-accion="nota-repaso" data-nota="bien"><b>Bien</b><small>${esc(proximoSiBien(p))}</small></button>
          </div>`
        : `<button type="button" class="boton principal grande" style="flex:1" data-accion="girar-tarjeta">Ver respuesta</button>`;
    };
    const proximoSiBien = p => {
      const d = INTERVALOS[Math.min(INTERVALOS.length - 1, (p.caja || 0) + 1)];
      return d === 1 ? 'Mañana' : `En ${d} días`;
    };

    abrirVentana({
      titulo: libroId ? 'Repasar: ' + tituloVisible(libroPorId(libroId) || { titulo: '' }) : 'Repasar palabras',
      cuerpo: '',
      pie: ' ',
      alCerrar: () => { document.removeEventListener('keydown', teclas); if (E.vista === 'palabras') pintarColumna(); else pintarFicha(); },
    });
    const teclas = e => {
      if (e.target.closest('input, textarea')) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!girada) { girada = true; pintar(); } }
      if (girada && ['1', '2', '3'].includes(e.key)) responder({ 1: 'otra', 2: 'dificil', 3: 'bien' }[e.key]);
    };
    document.addEventListener('keydown', teclas);
    const responder = nota => {
      const p = cola.shift();
      calificar(p, nota);
      cuenta[nota]++;
      if (nota === 'otra' && (vueltas.get(p.id) || 0) < 2) {
        vueltas.set(p.id, (vueltas.get(p.id) || 0) + 1);
        cola.splice(Math.min(cola.length, 3), 0, p); // vuelve a salir dentro de poco
      }
      girada = false;
      pintar();
    };
    Palabras._responder = responder;
    Palabras._girar = () => { girada = !girada; pintar(); };
    pintar();
  }

  // ---------- Exportar para Anki ----------
  function csvAnki() {
    return csv([
      ['Palabra', 'Significado', 'Definición', 'Frase', 'Libro', 'Idioma'],
      ...E.palabras.map(p => [p.palabra, (p.traducciones || []).join(', '), p.definiciones?.[0]?.texto || '', p.frase, tituloVisible(libroPorId(p.libroId) || { titulo: '' }), IDIOMAS[p.idioma]?.nombre || p.idioma]),
    ]);
  }

  // ---------- Acciones ----------
  Object.assign(acciones, {
    'buscar-palabra': b => ventanaBuscar(b.dataset.libro || E.sel || ''),
    'idioma-busqueda': b => {
      idiomaBusqueda = b.dataset.idioma;
      ajuste.guardar('ultimoIdioma', idiomaBusqueda);
      $$('#idiomas-busqueda button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.idioma === idiomaBusqueda)));
      if ($('#palabra-buscada')?.value.trim()) hacerBusqueda(libroBusqueda);
      else $('#palabra-buscada')?.focus();
    },
    'guardar-palabra': async b => {
      const r = ultimoResultado;
      if (!r) return;
      const libroId = b.dataset.libro || '';
      const manual = $('#traduccion-manual')?.value.trim();
      if (manual) r.traducciones = manual.split(',').map(t => t.trim()).filter(Boolean);
      const p = nuevaPalabra(r, libroId, $('#frase-palabra')?.value.trim(), parseInt($('#pagina-palabra')?.value, 10) || 0);
      E.palabras.push(p);
      await guardar(p);
      const l = libroPorId(libroId);
      if (l && l.idioma !== r.idioma) { l.idioma = r.idioma; guardarLibro(l, true); }
      ajuste.guardar('ultimoIdioma', r.idioma);
      avisar(`Guardada: ${p.palabra}`);
      // lista para la siguiente palabra
      $('#palabra-buscada').value = '';
      $('#resultado-palabra').innerHTML = `<p class="ayuda">${icono('check', 'ok')} «${esc(p.palabra)}» guardada. Escribe otra palabra.</p>`;
      $('#palabra-buscada').focus();
      ultimoResultado = null;
    },
    'ver-palabra': b => ventanaPalabra(b.dataset.id),
    hablar: b => hablar(b.dataset.texto, b.dataset.idioma),
    repasar: b => ventanaRepaso(b.dataset.libro || '', b.dataset.idioma || ''),
    'girar-tarjeta': () => Palabras._girar?.(),
    'nota-repaso': b => Palabras._responder?.(b.dataset.nota),
    'filtro-idioma': b => { filtro.idioma = b.dataset.idioma; pintarColumna(); },
    'vista-palabras-libro': b => { filtro.libro = b.dataset.libro; filtro.idioma = ''; E.vista = 'palabras'; if (innerWidth < 920) E.sel = null; pintarTodo(); },
    'pedir-borrar-palabra': b => {
      $('#zona-borrar-palabra').innerHTML = `<button type="button" class="boton peligro" data-accion="borrar-palabra" data-id="${b.dataset.id}">Sí, borrar</button>`;
    },
    'borrar-palabra': async b => {
      E.palabras = E.palabras.filter(p => p.id !== b.dataset.id);
      await BD.borrar('palabras', b.dataset.id);
      cerrarVentana();
      avisar('Palabra borrada');
    },
    'rebuscar-palabra': async b => {
      const p = E.palabras.find(x => x.id === b.dataset.id);
      if (!p) return;
      b.disabled = true;
      b.innerHTML = '<span class="cargando"></span> Buscando…';
      const r = await buscar(p.palabra, p.idioma);
      if (r.sinRed) { avisar('Sin conexión'); b.disabled = false; b.textContent = 'Buscar otra vez'; return; }
      if (r.traducciones.length) p.traducciones = r.traducciones;
      if (r.definiciones.length) { p.definiciones = r.definiciones; p.definicionesEnIngles = r.definicionesEnIngles; }
      await guardar(p);
      ventanaPalabra(p.id);
    },
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'buscar-palabras') { filtro.texto = e.target.value; pintarLista(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'filtro-libro-palabras') { filtro.libro = e.target.value; pintarColumna(); }
  });
  addEventListener('online', () => setTimeout(completarPendientes, 2500));
  setTimeout(completarPendientes, 3000);
  if (puedeHablar()) speechSynthesis.getVoices(); // carga las voces

  return { pintarColumna, seccionFicha, csvAnki, buscar, definicionesWikitext, limpiarWiki, calificar, INTERVALOS };
})();
window.Palabras = Palabras;
