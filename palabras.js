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

  /** de.wiktionary.org: género (der/die/das) y plural de los sustantivos alemanes.
   *  Si es una forma flexionada (p. ej. «Häuser»), devuelve la palabra base («Haus»). */
  async function gramaticaAleman(palabra) {
    const p = palabra.trim();
    // Primero tal cual (gehen = verbo) y luego con mayúscula (das Gehen = sustantivo)
    const formas = [...new Set([p, p.charAt(0).toUpperCase() + p.slice(1)])];
    for (const forma of formas) {
      const r = await pedirJSON('https://de.wiktionary.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&origin=*&redirects=1&page=' + encodeURIComponent(forma));
      if (r.error) return { error: r.error };
      const wt = r.datos?.parse?.wikitext;
      if (!wt) continue;
      const ini = wt.search(/\(\{\{Sprache\|Deutsch\}\}\)/);
      if (ini < 0) continue;
      let seccion = wt.slice(ini);
      const fin = seccion.search(/\n==\s[^=]/);
      if (fin > 0) seccion = seccion.slice(0, fin);
      if (/\{\{Wortart\|Substantiv\|Deutsch\}\}/.test(seccion)) {
        const g = seccion.match(/\|\s*Genus(?:\s*1)?\s*=\s*([mfn])\b/) || seccion.match(/\{\{Wortart\|Substantiv\|Deutsch\}\}[^\n]*?\{\{([mfn])\}\}/);
        const pl = seccion.match(/\|\s*Nominativ Plural(?:\s*1)?\s*=\s*([^\n|}]*)/);
        let plural = pl ? limpiarWiki(pl[1]) : '';
        if (/^[—–\-?]*$/.test(plural)) plural = '';
        return { forma, sustantivo: true, genero: g ? g[1] : '', plural };
      }
      if (/\{\{Wortart\|Verb\|Deutsch\}\}/.test(seccion)) {
        const verbo = verboDeSeccion(seccion);
        if (verbo) return { forma, verbo };
      }
      const base = seccion.match(/\{\{Grundformverweis[^|}]*\|([^|}]+)/);
      if (base) return { forma, base: base[1].trim() };
      return { forma, sustantivo: false };
    }
    return {};
  }

  /** Formas principales de un verbo alemán, sacadas de la tabla «Deutsch Verb Übersicht» de de.wiktionary. */
  function verboDeSeccion(seccion) {
    const t = seccion.match(/\{\{Deutsch Verb Übersicht([\s\S]*?)\n\}\}/);
    if (!t) return null;
    const campo = nombre => {
      const m = t[1].match(new RegExp('\\|\\s*' + nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*([^\\n|]*)'));
      const x = m ? limpiarWiki(m[1]) : '';
      return /^[—–\-?]*$/.test(x) ? '' : x;
    };
    const aux = [campo('Hilfsverb'), campo('Hilfsverb2')].filter(Boolean);
    const v = {
      ich: campo('Präsens_ich'), du: campo('Präsens_du'), er: campo('Präsens_er, sie, es'),
      prat: campo('Präteritum_ich'), part: campo('Partizip II'),
      aux: [...new Set(aux.map(a => (/sein/.test(a) ? 'sein' : /haben/.test(a) ? 'haben' : a)))].join('/'),
      konj: campo('Konjunktiv II_ich'), imp: campo('Imperativ Singular'), impPl: campo('Imperativ Plural'),
    };
    return v.er || v.prat || v.part ? v : null;
  }

  async function buscar(palabra, idioma, opciones = {}) {
    palabra = palabra.trim();
    if (sinConexion()) return { palabra, idioma, traducciones: [], definiciones: [], sinRed: true };
    let defs;
    let trad = { lista: [] };
    let gram = {};
    let definicionesEnIngles = false;
    if (idioma === 'es') {
      defs = await wiktionaryEspanol(palabra);
      if (!defs.defs.length && !defs.error) {
        defs = await wiktionaryIngles(palabra, 'es');
        definicionesEnIngles = defs.defs.length > 0;
      }
    } else if (idioma === 'de') {
      [defs, trad, gram] = await Promise.all([wiktionaryIngles(palabra, 'de'), traducir(palabra, 'de'), gramaticaAleman(palabra)]);
      // «Häuser» -> «Haus»: se busca la palabra base y se avisa
      if (gram.base && gram.base.toLowerCase() !== palabra.toLowerCase() && !opciones.sinBase) {
        const r = await buscar(gram.base, 'de', { sinBase: true });
        if (r.definiciones.length || r.traducciones.length) return { ...r, desde: palabra };
      }
    } else {
      [defs, trad] = await Promise.all([wiktionaryIngles(palabra, idioma), traducir(palabra, idioma)]);
    }
    const nada = !defs.defs.length && !trad.lista.length;
    const sinRed = nada && ERRORES_RED.includes(defs.error) && (idioma === 'es' || ERRORES_RED.includes(trad.error));
    let forma = palabra;
    if (idioma === 'de') {
      if (gram.sustantivo && gram.forma) forma = gram.forma;
      else if (defs.forma && defs.forma.toLowerCase() === palabra.toLowerCase()) forma = defs.forma;
    }
    return {
      palabra: forma, idioma, traducciones: trad.lista, definiciones: defs.defs, definicionesEnIngles, sinRed,
      ...(idioma === 'de' ? { genero: gram.genero || '', plural: gram.plural || '', verbo: gram.verbo || null, generoBuscado: !gram.error && !sinRed, gram2: !gram.error && !sinRed } : {}),
    };
  }

  // ---------- Guardar y repasar ----------
  function nuevaPalabra(r, libroId, frase, pagina) {
    return {
      id: uid(), libroId: libroId || '', palabra: r.palabra, idioma: r.idioma,
      traducciones: r.traducciones || [], definiciones: r.definiciones || [], definicionesEnIngles: !!r.definicionesEnIngles,
      ...(r.idioma === 'de' ? { genero: r.genero || '', plural: r.plural || '', generoBuscado: !!r.generoBuscado, gram2: !!r.gram2, ...(r.verbo ? { verbo: r.verbo } : {}) } : {}),
      ...(r.miDefinicion ? { miDefinicion: r.miDefinicion } : {}),
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
      if (r.idioma === 'de') Object.assign(p, { palabra: r.palabra, genero: r.genero, plural: r.plural, generoBuscado: r.generoBuscado, gram2: r.gram2 }, r.verbo ? { verbo: r.verbo } : {});
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
  const ARTICULOS = { m: 'der', f: 'die', n: 'das' };
  const articulo = p => (p.idioma === 'de' && ARTICULOS[p.genero] ? `<span class="art art-${p.genero}">${ARTICULOS[p.genero]}</span> ` : '');
  const articuloTexto = p => (p.idioma === 'de' && ARTICULOS[p.genero] ? ARTICULOS[p.genero] + ' ' : '');
  function lineaPlural(p) {
    if (p.idioma !== 'de' || !p.genero) return '';
    return p.plural ? `Plural: <span class="art art-f">die</span> ${esc(p.plural)}` : 'Sin plural';
  }
  /** «gehen · ging · ist gegangen» */
  function formasVerbo(p) {
    const v = p.verbo;
    if (p.idioma !== 'de' || !v) return '';
    const aux = { sein: 'ist', haben: 'hat', 'haben/sein': 'hat/ist', 'sein/haben': 'ist/hat' }[v.aux] || '';
    return [p.palabra, v.prat, v.part ? (aux ? aux + ' ' : '') + v.part : ''].filter(Boolean).join(' · ');
  }
  /** Tabla corta con las conjugaciones principales. */
  function tablaVerbo(p) {
    const v = p.verbo;
    if (p.idioma !== 'de' || !v) return '';
    const aux = { sein: 'ist', haben: 'hat', 'haben/sein': 'hat/ist', 'sein/haben': 'ist/hat' }[v.aux] || '';
    const filas = [
      ['Presente', [v.ich && 'ich ' + v.ich, v.du && 'du ' + v.du, v.er && 'er ' + v.er].filter(Boolean).join(', ')],
      ['Präteritum', v.prat ? 'er ' + v.prat : ''],
      ['Perfekt', v.part ? 'er ' + (aux ? aux + ' ' : '') + v.part : ''],
      ['Imperativo', [v.imp, v.impPl].filter(Boolean).map(x => x + '!').join(' / ')],
      ['Konjunktiv II', v.konj ? 'ich ' + v.konj : ''],
    ].filter(f => f[1]);
    return `<table class="tabla-verbo">${filas.map(([k, x]) => `<tr><th>${k}</th><td>${esc(x)}</td></tr>`).join('')}</table>`;
  }
  function textoVerbo(p) {
    const v = p.verbo;
    if (p.idioma !== 'de' || !v) return '';
    return [formasVerbo(p), [v.ich && 'ich ' + v.ich, v.du && 'du ' + v.du, v.er && 'er ' + v.er].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
  }
  const insignia = idioma => `<span class="insignia-idioma" title="${esc(IDIOMAS[idioma]?.nombre || '')}">${esc(IDIOMAS[idioma]?.corto || idioma)}</span>`;
  const botonHablar = (texto, idioma) => puedeHablar()
    ? `<button type="button" class="boton icono-solo plano" data-accion="hablar" data-texto="${esc(texto)}" data-idioma="${idioma}" aria-label="Escuchar">${icono('altavoz')}</button>` : '';
  /** La definición que se enseña: la tuya si la has escrito; si no, la primera del diccionario. */
  const defPrincipal = p => (p.miDefinicion || '').trim() || p.definiciones?.[0]?.texto || '';
  function resumenSignificado(p) {
    if (p.traducciones?.length) return p.traducciones.slice(0, 3).join(', ');
    return defPrincipal(p) || (p.pendiente ? 'Se completará al volver la conexión' : 'Sin traducción');
  }
  /** Campos para escribir tú el género y el plural de un sustantivo alemán. */
  function camposGenero(prefijo, genero = '', plural = '') {
    return `<div class="dos">
      <label class="etiqueta-campo">Género (si es sustantivo)<select class="campo" id="${prefijo}-genero">
        ${[['', '—'], ['m', 'der (masculino)'], ['f', 'die (femenino)'], ['n', 'das (neutro)']].map(([v, t]) => `<option value="${v}" ${v === genero ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      <label class="etiqueta-campo">Plural<input class="campo" id="${prefijo}-plural" value="${esc(plural)}" placeholder="Häuser" autocapitalize="off" spellcheck="false"></label>
    </div>`;
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
      <div class="fila-campo" style="flex-wrap:wrap"><button type="button" class="boton" data-accion="buscar-palabra" data-libro="${esc(filtro.libro)}">${icono('mas')} Buscar una palabra</button>
        ${E.palabras.length ? `<button type="button" class="boton" data-accion="abrir-exportar">${icono('descargar')} Llevar a Anki o Quizlet</button>` : ''}</div>
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
          <span class="fila-titulo">${articulo(p)}${esc(p.palabra)} ${insignia(p.idioma)}</span>
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
        ${r.desde ? `<p class="nota-pequena">Has buscado «${esc(r.desde)}»: es una forma de esta palabra.</p>` : ''}
        <div class="cab-resultado"><b class="palabra-grande">${articulo(r)}${esc(r.palabra)}</b>${insignia(r.idioma)}${botonHablar(articuloTexto(r) + r.palabra, r.idioma)}</div>
        ${lineaPlural(r) ? `<p class="ayuda" style="margin:0">${lineaPlural(r)}</p>` : ''}
        ${r.traducciones.length ? `<p class="traduccion">${esc(r.traducciones.join(', '))}</p>` : ''}
        ${r.verbo ? `<p class="formas-verbo">${esc(formasVerbo(r))}</p>${tablaVerbo(r)}` : ''}
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
          ${nada && !r.sinRed ? `<div style="flex:1 1 100%;display:flex;flex-direction:column;gap:10px">
            <label class="etiqueta-campo">${r.idioma === 'es' ? 'Significado' : 'Traducción'}<input class="campo" id="traduccion-manual" placeholder="Escríbela tú"></label>
            <label class="etiqueta-campo"><span>Definición <span class="nota-pequena">(opcional)</span></span><textarea class="campo" id="definicion-manual" rows="2" placeholder="Con tus palabras, o la que hayas encontrado en otro diccionario"></textarea></label>
            ${r.idioma === 'de' ? camposGenero('manual', r.genero || '', r.plural || '') : ''}
          </div>` : ''}
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
        <div class="cab-resultado"><b class="palabra-grande">${articulo(p)}${esc(p.palabra)}</b>${insignia(p.idioma)}${botonHablar(articuloTexto(p) + p.palabra, p.idioma)}</div>
        ${lineaPlural(p) ? `<p class="ayuda" style="margin:0">${lineaPlural(p)}</p>` : ''}
        ${p.verbo ? `<p class="formas-verbo">${esc(formasVerbo(p))}</p>${tablaVerbo(p)}` : ''}
        ${p.pendiente ? `<div class="consejo">${icono('nube')}<p>Guardada sin conexión: buscaré su significado cuando vuelva la cobertura.</p></div>` : ''}
        <label class="etiqueta-campo">${p.idioma === 'es' ? 'Significado (lo que verás al girar la tarjeta)' : 'Traducción (separa varias con comas)'}
          <input class="campo" id="p-traduccion" value="${esc((p.traducciones || []).join(', '))}" placeholder="${p.idioma === 'es' ? 'Opcional: tus propias palabras' : 'Escribe la traducción'}"></label>
        ${p.definiciones?.length ? `<ol class="definiciones">${p.definiciones.slice(0, 4).map(d => `<li>${d.tipo ? `<i>${esc(d.tipo)}</i> ` : ''}${esc(d.texto)}${d.ejemplo ? `<small>${esc(d.ejemplo)}</small>` : ''}</li>`).join('')}</ol>` : ''}
        <label class="etiqueta-campo"><span>Mi definición <span class="nota-pequena">(${p.definiciones?.length ? 'si la escribes, sale en la tarjeta en vez de la del diccionario' : 'opcional; sale en la tarjeta'})</span></span>
          <textarea class="campo" id="p-definicion" rows="2" placeholder="Con tus palabras, o la que hayas encontrado en otro diccionario">${esc(p.miDefinicion || '')}</textarea></label>
        ${p.idioma === 'de' && !p.verbo ? camposGenero('p', p.genero || '', p.plural || '') : ''}
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
      const def = $('#p-definicion').value.trim();
      if (def) p.miDefinicion = def; else delete p.miDefinicion;
      if ($('#p-genero')) {
        p.genero = $('#p-genero').value;
        p.plural = $('#p-plural').value.trim();
        const cab = $('.ventana .cab-resultado .palabra-grande');
        if (cab) cab.innerHTML = articulo(p) + esc(p.palabra);
      }
      guardar(p);
    };
    ['#p-traduccion', '#p-frase', '#p-nota', '#p-pagina', '#p-definicion', '#p-genero', '#p-plural'].forEach(s => $(s)?.addEventListener('input', guardarCampos));
    $('#p-genero')?.addEventListener('change', guardarCampos);
  }

  // ---------- Repaso: opciones ----------
  const MODOS = {
    ver: { nombre: 'Ver y recordar', nota: 'Ves la palabra y piensas qué significa' },
    reves: { nombre: 'Al revés', nota: 'Ves el significado y piensas la palabra' },
    escribir: { nombre: 'Escribir', nota: 'Ves el significado y escribes la palabra' },
    genero: { nombre: 'der, die, das', nota: 'Eliges el artículo de los sustantivos alemanes' },
  };
  const QUE = { hoy: 'Las de hoy', todas: 'Todas', dificiles: 'Las difíciles', nuevas: 'Las nuevas' };
  const OPCIONES_INICIALES = { que: 'hoy', modo: 'ver', cuantas: '20', voz: false };
  function opcionesGuardadas() {
    try { return { ...OPCIONES_INICIALES, ...JSON.parse(ajuste.leer('opcionesRepaso') || '{}') }; } catch { return { ...OPCIONES_INICIALES }; }
  }
  const esDificil = p => (p.fallos || 0) > 0 && (p.caja || 0) <= 2;
  const esNueva = p => !(p.aciertos || 0) && !(p.fallos || 0);
  const esSustantivoAleman = p => p.idioma === 'de' && !!ARTICULOS[p.genero];
  function seleccion(ambito, que, modo) {
    let l = modo === 'genero' ? ambito.filter(esSustantivoAleman) : ambito;
    if (que === 'hoy') l = pendientesDeRepaso(l);
    if (que === 'dificiles') l = l.filter(esDificil);
    if (que === 'nuevas') l = l.filter(esNueva);
    return l;
  }

  // ---------- Estadísticas ----------
  const hoyClave = (d = new Date()) => d.toLocaleDateString('sv-SE'); // AAAA-MM-DD en hora local
  function registro() {
    try { return JSON.parse(ajuste.leer('registroRepaso') || '{}'); } catch { return {}; }
  }
  function anotarRepaso(n) {
    const r = registro();
    r[hoyClave()] = (r[hoyClave()] || 0) + n;
    ajuste.guardar('registroRepaso', JSON.stringify(r));
  }
  function racha() {
    const r = registro();
    const d = new Date();
    if (!r[hoyClave(d)]) d.setDate(d.getDate() - 1); // si hoy aún no has repasado, cuenta hasta ayer
    let n = 0;
    while (r[hoyClave(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function estadisticasHTML(ambito) {
    const dominadas = ambito.filter(p => (p.caja || 0) >= 4).length;
    const nuevas = ambito.filter(esNueva).length;
    const aprendiendo = ambito.length - dominadas - nuevas;
    const r = racha();
    const hoy = registro()[hoyClave()] || 0;
    const aciertos = ambito.reduce((a, p) => a + (p.aciertos || 0), 0);
    const intentos = aciertos + ambito.reduce((a, p) => a + (p.fallos || 0), 0);
    return `<div class="seccion"><h2>Tu progreso</h2>
      <div class="estadisticas">
        <div><b>${r}</b><small>${r === 1 ? 'día seguido' : 'días seguidos'}</small></div>
        <div><b>${hoy}</b><small>repasadas hoy</small></div>
        <div><b>${dominadas}</b><small>dominadas</small></div>
        <div><b>${aprendiendo}</b><small>aprendiendo</small></div>
        <div><b>${nuevas}</b><small>nuevas</small></div>
        <div><b>${intentos ? Math.round(aciertos / intentos * 100) + ' %' : '—'}</b><small>aciertos</small></div>
      </div>
      <div class="barra-niveles" title="Dominadas, aprendiendo y nuevas">
        <i class="dominadas" style="flex:${dominadas}"></i><i class="aprendiendo" style="flex:${aprendiendo}"></i><i class="nuevas" style="flex:${nuevas}"></i>
      </div></div>`;
  }

  let ambitoRepaso = { libroId: '', idioma: '' };
  function ventanaOpcionesRepaso(libroId, idioma) {
    ambitoRepaso = { libroId: libroId || '', idioma: idioma || '' };
    const ambito = E.palabras.filter(p => (!ambitoRepaso.libroId || p.libroId === ambitoRepaso.libroId) && (!ambitoRepaso.idioma || p.idioma === ambitoRepaso.idioma));
    if (!ambito.length) { avisar('No hay palabras que repasar'); return; }
    const o = opcionesGuardadas();
    const hayGenero = ambito.some(esSustantivoAleman);
    if (o.modo === 'genero' && !hayGenero) o.modo = 'ver';
    const l = libroPorId(ambitoRepaso.libroId);
    abrirVentana({
      titulo: l ? 'Repasar: ' + tituloVisible(l) : 'Repasar palabras',
      cuerpo: `
        <div class="seccion"><h2>Qué tarjetas</h2>
          <div class="opciones-repaso">${Object.entries(QUE).map(([k, t]) => {
            const n = seleccion(ambito, k, o.modo).length;
            return `<button type="button" data-accion="opcion-repaso" data-grupo="que" data-valor="${k}" aria-pressed="${o.que === k}" ${n ? '' : 'class="vacia"'}><b>${n}</b><small>${t}</small></button>`;
          }).join('')}</div></div>
        <div class="seccion"><h2>Cómo</h2>
          <div class="estados">${Object.entries(MODOS).filter(([k]) => k !== 'genero' || hayGenero).map(([k, m]) => `<button type="button" class="estado" data-accion="opcion-repaso" data-grupo="modo" data-valor="${k}" aria-pressed="${o.modo === k}"><span><b>${m.nombre}</b><small>${m.nota}</small></span></button>`).join('')}</div></div>
        <div class="seccion"><h2>Cuántas como máximo</h2>
          <div class="segmentos" style="grid-template-columns:repeat(4,1fr)">${['10', '20', '50', 'todas'].map(k => `<button type="button" data-accion="opcion-repaso" data-grupo="cuantas" data-valor="${k}" aria-pressed="${o.cuantas === k}">${k === 'todas' ? 'Todas' : k}</button>`).join('')}</div></div>
        ${puedeHablar() ? `<label class="interruptor"><input type="checkbox" id="opcion-voz" ${o.voz ? 'checked' : ''}> Leer cada palabra en voz alta</label>` : ''}
        ${estadisticasHTML(ambito)}`,
      pie: `<span class="espacio"></span><button type="button" class="boton principal grande" data-accion="empezar-repaso">Empezar</button>`,
    });
    $('#opcion-voz')?.addEventListener('change', e => {
      const x = opcionesGuardadas();
      x.voz = e.target.checked;
      ajuste.guardar('opcionesRepaso', JSON.stringify(x));
    });
  }

  function empezarRepaso() {
    const o = opcionesGuardadas();
    const ambito = E.palabras.filter(p => (!ambitoRepaso.libroId || p.libroId === ambitoRepaso.libroId) && (!ambitoRepaso.idioma || p.idioma === ambitoRepaso.idioma));
    let lista = seleccion(ambito, o.que, o.modo);
    if (!lista.length) {
      avisar(o.que === 'hoy' ? 'Hoy no te toca ninguna: elige «Todas» o «Las difíciles»' : 'No hay tarjetas de ese tipo');
      return;
    }
    // las más atrasadas primero, con algo de mezcla
    lista = [...lista].sort((a, b) => String(a.proxima).localeCompare(String(b.proxima)))
      .map((p, i) => ({ p, k: i + Math.random() * 4 })).sort((a, b) => a.k - b.k).map(x => x.p);
    if (o.cuantas !== 'todas') lista = lista.slice(0, parseInt(o.cuantas, 10));
    sesionRepaso(lista, o);
  }

  // ---------- Repaso: la sesión ----------
  const quitarAcentos = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  function normalizar(t, idioma) {
    let s = String(t || '').trim().toLowerCase().replace(/[.,;:!?¡¿"'«»()]/g, '').replace(/\s+/g, ' ');
    s = s.replace(/^(der|die|das|the|a|an|to|el|la|los|las|un|una)\s+/, '');
    if (idioma === 'de') s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    return s;
  }
  function distancia(a, b) {
    const m = a.length;
    const n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[m][n];
  }
  /** Compara lo escrito con la palabra: 'bien', 'casi' (acentos o una letra) o 'mal'. */
  function comprobar(escrito, p) {
    const a = normalizar(escrito, p.idioma);
    const b = normalizar(p.palabra, p.idioma);
    if (!a) return 'mal';
    if (a === b) return 'bien';
    if (quitarAcentos(a) === quitarAcentos(b)) return 'casi';
    if (b.length >= 5 && distancia(a, b) === 1) return 'casi';
    return 'mal';
  }
  function fraseOculta(frase, palabra) {
    if (!frase) return '';
    const patron = palabra.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return esc(frase).replace(new RegExp(patron, 'gi'), '<span class="hueco">_____</span>'); } catch { return esc(frase); }
  }

  function sesionRepaso(lista, o) {
    let cola = [...lista];
    const total = cola.length;
    const vueltas = new Map();
    const cuenta = { bien: 0, dificil: 0, otra: 0 };
    let fase = 'pregunta'; // pregunta | respuesta
    let resultado = null; // para «escribir» y «der, die, das»
    let escrito = '';
    let anotadas = 0;

    const significadoHTML = p => `
      <span class="traduccion">${esc(resumenSignificado(p))}</span>
      ${(() => {
        const extra = p.traducciones?.length ? defPrincipal(p) : (p.miDefinicion ? p.definiciones?.[0]?.texto : p.definiciones?.[1]?.texto);
        return extra ? `<span class="def-tarjeta">${esc(extra)}</span>` : '';
      })()}`;
    const palabraHTML = (p, conArticulo) => `<b class="palabra-tarjeta">${conArticulo ? articulo(p) : ''}${esc(p.palabra)}</b>
      ${conArticulo && lineaPlural(p) ? `<span class="nota-pequena">${lineaPlural(p)}</span>` : ''}
`;
    const bloqueVerbo = p => (p.idioma === 'de' && p.verbo ? `<span class="formas-verbo">${esc(formasVerbo(p))}</span>${tablaVerbo(p)}` : '');
    const pie = p => {
      const l = libroPorId(p.libroId);
      return `<span class="nota-pequena">${esc(l ? tituloVisible(l) : '')}${p.pagina ? ' · p. ' + p.pagina : ''}</span>`;
    };
    const decir = p => { if (o.voz) hablar(articuloTexto(p) + p.palabra, p.idioma); };

    const pintar = () => {
      const cuerpo = $('#ventana-cuerpo');
      const piePag = $('#ventana-pie');
      if (!cuerpo) return;
      if (!cola.length) return terminar();
      const p = cola[0];
      const hecho = total - cola.length;
      const cabecera = `<div class="progreso-repaso"><span style="width:${Math.round(hecho / total * 100)}%"></span></div>
        <p class="ayuda" style="text-align:center">${MODOS[o.modo].nombre} · ${hecho + 1} de ${total}${vueltas.get(p.id) ? ' · otra vez' : ''}</p>`;
      let cara = '';
      let reverso = '';
      if (o.modo === 'ver') {
        cara = `${insignia(p.idioma)}${palabraHTML(p, false)}${p.frase ? `<span class="frase-tarjeta">${fraseMarcada(p.frase, p.palabra)}</span>` : ''}`;
        reverso = `${p.idioma === 'de' && p.genero ? palabraHTML(p, true) : ''}${significadoHTML(p)}${bloqueVerbo(p)}${p.nota ? `<span class="def-tarjeta"><i>${esc(p.nota)}</i></span>` : ''}${pie(p)}`;
      } else if (o.modo === 'reves' || o.modo === 'escribir') {
        cara = `${insignia(p.idioma)}${significadoHTML(p)}${p.frase ? `<span class="frase-tarjeta">${fraseOculta(p.frase, p.palabra)}</span>` : ''}`;
        reverso = `${palabraHTML(p, true)}${bloqueVerbo(p)}${resultado && o.modo === 'escribir' ? `<span class="veredicto ${resultado}">${resultado === 'bien' ? '¡Correcto!' : resultado === 'casi' ? `Casi: escribiste «${esc(escrito)}»` : `Escribiste «${esc(escrito || '—')}»`}</span>` : ''}${p.nota ? `<span class="def-tarjeta"><i>${esc(p.nota)}</i></span>` : ''}${pie(p)}`;
      } else {
        cara = `${insignia(p.idioma)}<b class="palabra-tarjeta">${esc(p.palabra)}</b><span class="def-tarjeta">${esc(resumenSignificado(p))}</span>`;
        reverso = `${palabraHTML(p, true)}<span class="veredicto ${resultado}">${resultado === 'bien' ? '¡Correcto!' : 'Era ' + ARTICULOS[p.genero]}</span>`;
      }
      const respondida = fase === 'respuesta';
      cuerpo.innerHTML = `${cabecera}
        <div class="tarjeta-flash ${respondida ? 'girada' : ''}" ${o.modo === 'ver' || o.modo === 'reves' ? 'role="button" tabindex="0" data-accion="girar-tarjeta"' : ''}>
          <span class="cara">${cara}${!respondida && (o.modo === 'ver' || o.modo === 'reves') ? '<span class="nota-pequena">Toca para ver la respuesta</span>' : ''}</span>
          ${respondida ? `<span class="reverso">${reverso}</span>` : ''}
        </div>
        ${o.modo === 'escribir' && !respondida ? `<form class="fila-campo" id="form-escribir"><input class="campo" id="respuesta-escrita" placeholder="Escribe la palabra" autocomplete="off" autocapitalize="off" spellcheck="false" lang="${p.idioma}" enterkeyhint="done"><button class="boton principal" type="submit">Comprobar</button></form>` : ''}
        ${puedeHablar() && respondida ? `<div style="text-align:center">${botonHablar(articuloTexto(p) + p.palabra, p.idioma)}</div>` : ''}`;

      if (o.modo === 'genero') {
        piePag.innerHTML = respondida
          ? `<span class="espacio"></span><button type="button" class="boton principal grande" data-accion="siguiente-genero">Siguiente</button>`
          : `<div class="botones-genero">${['m', 'f', 'n'].map(g => `<button type="button" class="boton art-boton art-${g}" data-accion="elegir-genero" data-genero="${g}">${ARTICULOS[g]}</button>`).join('')}</div>`;
      } else if (!respondida) {
        piePag.innerHTML = o.modo === 'escribir'
          ? `<button type="button" class="boton plano" data-accion="no-lo-se">No lo sé</button><span class="espacio"></span>`
          : `<button type="button" class="boton principal grande" style="flex:1" data-accion="girar-tarjeta">Ver respuesta</button>`;
      } else {
        const sugerida = o.modo === 'escribir' ? { bien: 'bien', casi: 'dificil', mal: 'otra' }[resultado] : '';
        piePag.innerHTML = `<div class="botones-nota">
          <button type="button" class="boton nota-otra ${sugerida === 'otra' ? 'sugerida' : ''}" data-accion="nota-repaso" data-nota="otra"><b>Otra vez</b><small>No me la sabía</small></button>
          <button type="button" class="boton nota-dificil ${sugerida === 'dificil' ? 'sugerida' : ''}" data-accion="nota-repaso" data-nota="dificil"><b>Difícil</b><small>Mañana</small></button>
          <button type="button" class="boton nota-bien ${sugerida === 'bien' ? 'sugerida' : ''}" data-accion="nota-repaso" data-nota="bien"><b>Bien</b><small>${esc(proximoSiBien(p))}</small></button>
        </div>`;
      }
      if (o.modo === 'escribir' && !respondida) {
        const i = $('#respuesta-escrita');
        $('#form-escribir').addEventListener('submit', e => { e.preventDefault(); escribirRespuesta(i.value); });
        i.focus();
      }
      if (!respondida && (o.modo === 'ver' || o.modo === 'genero')) decir(p);
      if (respondida && (o.modo === 'reves' || o.modo === 'escribir')) decir(p);
    };

    const proximoSiBien = p => {
      const d = INTERVALOS[Math.min(INTERVALOS.length - 1, (p.caja || 0) + 1)];
      return d === 1 ? 'Mañana' : `En ${d} días`;
    };
    const girar = () => {
      if (o.modo !== 'ver' && o.modo !== 'reves') return;
      fase = fase === 'pregunta' ? 'respuesta' : 'pregunta';
      pintar();
    };
    const escribirRespuesta = texto => {
      escrito = texto.trim();
      resultado = comprobar(escrito, cola[0]);
      fase = 'respuesta';
      pintar();
    };
    const responder = nota => {
      const p = cola.shift();
      calificar(p, nota);
      p.ultimoRepaso = ahora();
      cuenta[nota]++;
      anotadas++;
      if (nota === 'otra' && (vueltas.get(p.id) || 0) < 2) {
        vueltas.set(p.id, (vueltas.get(p.id) || 0) + 1);
        cola.splice(Math.min(cola.length, 3), 0, p); // vuelve a salir dentro de poco
      }
      fase = 'pregunta';
      resultado = null;
      escrito = '';
      pintar();
    };
    const elegirGenero = g => {
      const p = cola[0];
      resultado = g === p.genero ? 'bien' : 'mal';
      p.generoAciertos = (p.generoAciertos || 0) + (resultado === 'bien' ? 1 : 0);
      p.generoFallos = (p.generoFallos || 0) + (resultado === 'bien' ? 0 : 1);
      guardar(p);
      cuenta[resultado === 'bien' ? 'bien' : 'otra']++;
      anotadas++;
      fase = 'respuesta';
      pintar();
    };
    const siguienteGenero = () => {
      const p = cola.shift();
      if (resultado === 'mal' && (vueltas.get(p.id) || 0) < 1) {
        vueltas.set(p.id, 1);
        cola.splice(Math.min(cola.length, 3), 0, p);
      }
      fase = 'pregunta';
      resultado = null;
      pintar();
    };
    const terminar = () => {
      const hechas = cuenta.bien + cuenta.dificil + cuenta.otra;
      if (anotadas) anotarRepaso(anotadas);
      anotadas = 0;
      const r = racha();
      $('#ventana-cuerpo').innerHTML = `<div class="vacio">${icono('tarjetas', 'grande-icono')}<h2>¡Repaso terminado!</h2>
        <p>${o.modo === 'genero'
          ? `${cuenta.bien} de ${hechas} artículos acertados.`
          : `${hechas === 1 ? '1 respuesta' : hechas + ' respuestas'}: ${cuenta.bien} bien, ${cuenta.dificil === 1 ? '1 difícil' : cuenta.dificil + ' difíciles'}, ${cuenta.otra} para repetir.`}</p>
        ${r > 1 ? `<p><b>${r} días seguidos</b> repasando.</p>` : ''}
        <p class="ayuda">${o.modo === 'genero' ? 'La práctica de artículos no cambia cuándo te toca cada tarjeta.' : 'Las que sabías volverán más adelante; las difíciles, mañana.'}</p></div>`;
      $('#ventana-pie').innerHTML = `<button type="button" class="boton" data-accion="repasar" data-libro="${esc(ambitoRepaso.libroId)}" data-idioma="${esc(ambitoRepaso.idioma)}">Otro repaso</button>
        <span class="espacio"></span><button type="button" class="boton principal" data-accion="cerrar-ventana">Cerrar</button>`;
    };

    const teclas = e => {
      if (e.target.closest('input, textarea')) return;
      if (o.modo === 'genero') {
        if (fase === 'pregunta' && ['1', '2', '3'].includes(e.key)) elegirGenero({ 1: 'm', 2: 'f', 3: 'n' }[e.key]);
        else if (fase === 'respuesta' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); siguienteGenero(); }
        return;
      }
      if (fase === 'pregunta' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); girar(); return; }
      if (fase === 'respuesta' && ['1', '2', '3'].includes(e.key)) responder({ 1: 'otra', 2: 'dificil', 3: 'bien' }[e.key]);
    };
    abrirVentana({
      titulo: 'Repaso',
      cuerpo: '',
      pie: ' ',
      alCerrar: () => {
        document.removeEventListener('keydown', teclas);
        if (anotadas) anotarRepaso(anotadas);
        Palabras._sesion = null;
        if (E.vista === 'palabras') pintarColumna(); else pintarFicha();
      },
    });
    document.addEventListener('keydown', teclas);
    Palabras._sesion = { girar, responder, elegirGenero, siguienteGenero, noLoSe: () => escribirRespuesta('') };
    pintar();
  }

  // ---------- Exportar ----------
  const textoFrente = p => articuloTexto(p) + p.palabra;
  function textoReverso(p, html) {
    const partes = [(p.traducciones || []).join(', ') || defPrincipal(p)];
    if (p.idioma === 'de' && p.genero) partes.push(p.plural ? 'Plural: die ' + p.plural : 'Sin plural');
    if (p.verbo) partes.push(textoVerbo(p));
    if (p.traducciones?.length && defPrincipal(p)) partes.push(defPrincipal(p));
    if (p.frase) partes.push(html ? `<i>${esc(p.frase)}</i>` : p.frase);
    return partes.filter(Boolean).join(html ? '<br>' : ' — ');
  }
  function csvAnki() {
    return csv([
      ['Palabra', 'Significado', 'Definición', 'Frase', 'Libro', 'Idioma'],
      ...E.palabras.map(p => [textoFrente(p), (p.traducciones || []).join(', '), defPrincipal(p), p.frase, tituloVisible(libroPorId(p.libroId) || { titulo: '' }), IDIOMAS[p.idioma]?.nombre || p.idioma]),
    ]);
  }
  /** Archivo de texto que Anki importa directamente (Archivo → Importar). */
  function txtAnki(lista) {
    const limpia = t => String(t || '').replace(/[\t\r\n]+/g, ' ');
    const etiqueta = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '');
    const lineas = ['#separator:tab', '#html:true', '#columns:Frente\tReverso\tEtiquetas', '#tags column:3'];
    for (const p of lista) {
      const l = libroPorId(p.libroId);
      const tags = ['MisLibros', IDIOMAS[p.idioma]?.nombre || p.idioma, l ? etiqueta(tituloVisible(l)) : ''].filter(Boolean).join(' ');
      lineas.push([limpia(esc(textoFrente(p))), limpia(textoReverso(p, true)), tags].join('\t'));
    }
    return lineas.join('\n') + '\n';
  }
  /** Texto para pegar en Quizlet (Crear → Importar): término, tabulador, definición. */
  function textoQuizlet(lista) {
    return lista.map(p => `${textoFrente(p)}\t${textoReverso(p, false).replace(/[\t\n]+/g, ' ')}`).join('\n');
  }
  function ventanaExportar() {
    const lista = filtradas();
    abrirVentana({
      titulo: 'Llevar a otra app',
      cuerpo: `
        <p class="ayuda">Se exportan las <b>${lista.length}</b> palabras que tienes a la vista (según los filtros de idioma y libro).</p>
        <div class="bloque-copia">
          <h3 class="seccion" style="margin:0;font-size:15px">Anki</h3>
          <p class="ayuda">Descarga el archivo y, en Anki (ordenador, AnkiMobile o AnkiDroid), usa <b>Archivo → Importar</b>. Las columnas y las etiquetas (idioma y libro) se reconocen solas. Elige el tipo de nota «Básico» o «Básico (con tarjeta inversa)».</p>
          <div class="botones"><button type="button" class="boton principal" data-accion="exportar-palabras" data-formato="anki">${icono('descargar')} Archivo para Anki</button></div>
        </div>
        <div class="bloque-copia">
          <h3 class="seccion" style="margin:0;font-size:15px">Quizlet</h3>
          <p class="ayuda">Copia la lista y, en Quizlet, crea un set y pulsa <b>Importar</b>. Pega el texto y elige «Tabulador» entre término y definición y «Nueva línea» entre tarjetas.</p>
          <div class="botones"><button type="button" class="boton" data-accion="exportar-palabras" data-formato="quizlet">${icono('copiar')} Copiar para Quizlet</button></div>
        </div>
        <div class="bloque-copia">
          <h3 class="seccion" style="margin:0;font-size:15px">Hoja de cálculo</h3>
          <div class="botones"><button type="button" class="boton" data-accion="exportar-palabras" data-formato="csv">${icono('descargar')} Archivo .csv</button></div>
        </div>`,
      pie: `<span class="espacio"></span><button type="button" class="boton principal" data-accion="cerrar-ventana">Hecho</button>`,
    });
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
      const defManual = $('#definicion-manual')?.value.trim();
      if (defManual) r.miDefinicion = defManual;
      if ($('#manual-genero')) { r.genero = $('#manual-genero').value; r.plural = $('#manual-plural').value.trim(); }
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
    repasar: b => ventanaOpcionesRepaso(b.dataset.libro || '', b.dataset.idioma || ''),
    'opcion-repaso': b => {
      const o = opcionesGuardadas();
      o[b.dataset.grupo] = b.dataset.valor;
      ajuste.guardar('opcionesRepaso', JSON.stringify(o));
      ventanaOpcionesRepaso(ambitoRepaso.libroId, ambitoRepaso.idioma);
    },
    'empezar-repaso': () => empezarRepaso(),
    'girar-tarjeta': () => Palabras._sesion?.girar(),
    'nota-repaso': b => Palabras._sesion?.responder(b.dataset.nota),
    'elegir-genero': b => Palabras._sesion?.elegirGenero(b.dataset.genero),
    'siguiente-genero': () => Palabras._sesion?.siguienteGenero(),
    'no-lo-se': () => Palabras._sesion?.noLoSe(),
    'abrir-exportar': () => ventanaExportar(),
    'exportar-palabras': async b => {
      const lista = filtradas();
      if (!lista.length) { avisar('No hay palabras que exportar'); return; }
      const dia = new Date().toISOString().slice(0, 10);
      if (b.dataset.formato === 'anki') await entregarArchivo(`MisLibros-palabras-${dia}.txt`, txtAnki(lista), 'text/plain');
      else if (b.dataset.formato === 'csv') await entregarArchivo(`MisLibros-palabras-${dia}.csv`, csvAnki(), 'text/csv');
      else {
        try { await navigator.clipboard.writeText(textoQuizlet(lista)); avisar(`Copiadas ${lista.length} tarjetas. Pégalas en Quizlet.`); } catch { avisar('No se ha podido copiar'); }
      }
    },
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
      if (r.idioma === 'de' && r.generoBuscado) {
        if (r.genero || !p.genero) Object.assign(p, { genero: r.genero, plural: r.plural }); // no se borra el género que pusiste tú
        Object.assign(p, { generoBuscado: true, gram2: true });
        if (r.verbo) p.verbo = r.verbo; else delete p.verbo;
      }
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
  /** Añade el género a las palabras alemanas guardadas antes de que existiera. */
  let completandoGeneros = false;
  async function completarGeneros() {
    if (completandoGeneros || sinConexion()) return;
    const lista = E.palabras.filter(p => p.idioma === 'de' && !p.gram2 && !p.pendiente).slice(0, 25);
    if (!lista.length) return;
    completandoGeneros = true;
    let cambios = 0;
    for (const p of lista) {
      const g = await gramaticaAleman(p.palabra);
      if (g.error) break;
      if (g.sustantivo) { p.genero = g.genero; p.plural = g.plural; if (g.forma) p.palabra = g.forma; cambios++; }
      let v = g.verbo;
      if (!v && g.base) { const gb = await gramaticaAleman(g.base); v = gb.verbo; } // «ging» -> gehen
      if (v) { p.verbo = v; cambios++; }
      p.generoBuscado = true;
      p.gram2 = true;
      await guardar(p);
    }
    completandoGeneros = false;
    if (cambios && E.vista === 'palabras') pintarLista();
  }

  addEventListener('online', () => setTimeout(() => { completarPendientes(); completarGeneros(); }, 2500));
  setTimeout(() => { completarPendientes(); completarGeneros(); }, 3000);
  if (puedeHablar()) speechSynthesis.getVoices(); // carga las voces

  return { pintarColumna, seccionFicha, csvAnki, txtAnki, textoQuizlet, buscar, definicionesWikitext, limpiarWiki, calificar, comprobar, INTERVALOS };
})();
window.Palabras = Palabras;
