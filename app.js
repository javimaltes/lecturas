'use strict';

/* =====================================================================
   Mis Libros (web)
   Todo se guarda en este navegador (IndexedDB). Nada sale de aquí salvo
   las búsquedas de datos de libros (Google Books, Apple Books, Open Library).
   ===================================================================== */

// ---------- Utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const ahora = () => new Date().toISOString();
const icono = (n, clase = '') => `<svg class="icono ${clase}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

function fechaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}
function diaMes(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
}
const aFechaInput = iso => (iso ? String(iso).slice(0, 10) : '');
const deFechaInput = v => (v ? new Date(v + 'T12:00:00').toISOString() : null);
function hace(iso) {
  if (!iso) return '';
  const seg = (new Date(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  const pasos = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = seg;
  for (const [n, u] of pasos) {
    if (Math.abs(v) < n) return rtf.format(Math.round(v), u);
    v /= n;
  }
  return '';
}
function quitarHTML(s) {
  const d = document.createElement('div');
  d.innerHTML = String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  return d.textContent.trim();
}
const ajuste = {
  leer(k, def = '') { try { return localStorage.getItem('ml_' + k) ?? def; } catch { return def; } },
  guardar(k, v) { try { localStorage.setItem('ml_' + k, v); } catch { /* sin almacenamiento */ } },
};
let temporizadorAviso;
function avisar(texto) {
  $('.aviso-flotante')?.remove();
  const d = document.createElement('div');
  d.className = 'aviso-flotante';
  d.setAttribute('role', 'status');
  d.textContent = texto;
  document.body.appendChild(d);
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => d.remove(), 3200);
}

// ---------- Datos ----------
const ESTADOS = [
  { id: 'Cajón de sastre', icono: 'cajon', nota: 'Me suena interesante, ya veré si lo leo', corto: 'Cajón de sastre' },
  { id: 'Quiero leerlo', emoji: '🐘', nota: 'Lo tengo en la lista', corto: 'Quiero leer' },
  { id: 'Leyendo', icono: 'libro', nota: 'Lo estoy leyendo ahora', corto: 'Leyendo' },
  { id: 'Leído', icono: 'leido', nota: 'Terminado', corto: 'Leídos' },
  { id: 'Abandonado', icono: 'abandonado', nota: 'Lo dejé a medias', corto: 'Abandonados' },
];
const estadoDe = id => ESTADOS.find(e => e.id === id) || ESTADOS[0];
const simboloEstado = e => (e.emoji ? `<span aria-hidden="true">${e.emoji}</span>` : icono(e.icono));
const PROCEDENCIAS = [
  { id: 'Mío', icono: 'casa' },
  { id: 'Biblioteca', icono: 'biblioteca' },
  { id: 'Prestado', icono: 'personas' },
];
const CATEGORIAS_INICIALES = [
  { orden: 0, nombre: 'Idea clave', colorHex: '#F5C518' },
  { orden: 1, nombre: 'Cita bonita', colorHex: '#34C759' },
  { orden: 2, nombre: 'Me emocionó', colorHex: '#FF6FA8' },
  { orden: 3, nombre: 'Para pensar', colorHex: '#4A90E2' },
  { orden: 4, nombre: 'Para investigar', colorHex: '#FF9500' },
];

// Cada cambio queda fechado (campo "modificado") y cada borrado se apunta en "borrados":
// así la sincronización sabe qué versión es la más reciente en cada dispositivo.
const ALMACENES_SYNC = ['libros', 'citas', 'categorias', 'palabras'];
const BD = {
  db: null,
  memoria: null, // si el navegador no deja guardar, se trabaja en memoria
  abrir() {
    const vacia = () => ({ libros: {}, citas: {}, categorias: {}, borrados: {}, palabras: {} });
    return new Promise(ok => {
      let r;
      try { r = indexedDB.open('mislibros', 3); } catch { this.memoria = vacia(); return ok(false); }
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const [n, k] of [['libros', 'id'], ['citas', 'id'], ['categorias', 'orden'], ['borrados', 'id'], ['palabras', 'id']]) {
          if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: k });
        }
      };
      r.onsuccess = () => { this.db = r.result; ok(true); };
      r.onerror = () => { this.memoria = vacia(); ok(false); };
    });
  },
  _marcar(a, o) {
    if (ALMACENES_SYNC.includes(a)) o.modificado = ahora();
  },
  _avisar(a) {
    if (ALMACENES_SYNC.includes(a)) window.alCambiarDatos?.();
  },
  _tx(almacen, modo, fn) {
    return new Promise((ok, mal) => {
      const t = this.db.transaction(almacen, modo);
      const s = t.objectStore(almacen);
      let res;
      const q = fn(s);
      if (q) q.onsuccess = () => { res = q.result; };
      t.oncomplete = () => ok(res);
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error);
    });
  },
  async todos(a) { return this.memoria ? Object.values(this.memoria[a]) : this._tx(a, 'readonly', s => s.getAll()); },
  async poner(a, o) {
    this._marcar(a, o);
    await this.ponerCrudo(a, o);
    this._avisar(a);
  },
  async ponerVarios(a, lista) {
    for (const o of lista) this._marcar(a, o);
    await this.ponerVariosCrudo(a, lista);
    this._avisar(a);
  },
  async borrar(a, id) {
    await this.borrarCrudo(a, id);
    if (a === 'libros' || a === 'citas' || a === 'palabras') await this.ponerCrudo('borrados', { id, fecha: ahora() });
    this._avisar(a);
  },
  // Versiones "crudas": sin fechar ni avisar (las usa la sincronización al traer datos).
  async ponerCrudo(a, o) {
    if (this.memoria) { this.memoria[a][o.id ?? o.orden] = o; return; }
    return this._tx(a, 'readwrite', s => s.put(o));
  },
  async ponerVariosCrudo(a, lista) {
    if (this.memoria) { for (const o of lista) this.memoria[a][o.id ?? o.orden] = o; return; }
    return this._tx(a, 'readwrite', s => { for (const o of lista) s.put(o); });
  },
  async borrarCrudo(a, id) {
    if (this.memoria) { delete this.memoria[a][id]; return; }
    return this._tx(a, 'readwrite', s => s.delete(id));
  },
};

const E = {
  libros: [],
  citas: [],
  palabras: [],
  categorias: [],
  vista: 'libros',
  sel: null,
  filtro: { estado: null, etiqueta: '', prestados: false, texto: '' },
  filtroCitas: { cat: -1, texto: '' },
};

function nuevoLibro(d = {}, estado = 'Cajón de sastre') {
  return {
    id: uid(), isbn: d.isbn || '', titulo: d.titulo || '', autores: d.autores || '', editorial: d.editorial || '',
    fechaPublicacion: d.fechaPublicacion || '', paginas: d.paginas || 0, descripcion: d.descripcion || '',
    portada: d.portada || '', estado, procedencia: 'Mío', lugar: '', fechaDevolucion: null,
    paginaActual: 0, fechaProgreso: null, notas: d.notas || '', fechaInicio: estado === 'Leyendo' ? ahora() : null,
    fechaFin: estado === 'Leído' ? ahora() : null, fechaAlta: ahora(), etiquetas: [],
  };
}
const libroPorId = id => E.libros.find(l => l.id === id);
const citasDe = id => E.citas.filter(c => c.libroId === id).sort((a, b) => (a.pagina - b.pagina) || a.fecha.localeCompare(b.fecha));
const categoria = n => E.categorias.find(c => c.orden === n);

const pendientesGuardar = new Map();
function guardarLibro(l, inmediato = false) {
  clearTimeout(pendientesGuardar.get(l.id));
  if (inmediato) return BD.poner('libros', l);
  pendientesGuardar.set(l.id, setTimeout(() => BD.poner('libros', l), 400));
}
async function anadirLibro(l) {
  E.libros.unshift(l);
  await BD.poner('libros', l);
}
async function borrarLibro(l) {
  E.libros = E.libros.filter(x => x.id !== l.id);
  for (const c of citasDe(l.id)) await BD.borrar('citas', c.id);
  E.citas = E.citas.filter(c => c.libroId !== l.id);
  await BD.borrar('libros', l.id);
}
function cambiarEstado(l, nuevo) {
  l.estado = nuevo;
  if (nuevo === 'Leyendo' && !l.fechaInicio) l.fechaInicio = ahora();
  if (nuevo === 'Leído') {
    if (!l.fechaFin) l.fechaFin = ahora();
    if (l.paginas > 0) l.paginaActual = l.paginas;
  }
}
function libroExiste(d) {
  const vars = d.isbn ? Buscador.variantes(d.isbn) : [];
  const clave = (d.titulo + '|' + d.autores).toLowerCase();
  return E.libros.find(l => (l.isbn && vars.includes(l.isbn)) || (l.titulo + '|' + l.autores).toLowerCase() === clave);
}
const limpiarEtiqueta = t => String(t || '').replace(/#/g, '').replace(/\s+/g, ' ').trim();
function todasLasEtiquetas() {
  const m = new Map();
  for (const l of E.libros) for (const e of l.etiquetas || []) {
    const k = e.toLowerCase();
    if (!m.has(k)) m.set(k, { nombre: e, n: 0 });
    m.get(k).n++;
  }
  return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// ---------- Búsqueda de datos de libros ----------
const ERRORES_RED = ['no responde', 'tardó demasiado', 'sin internet'];
const sinConexion = () => navigator.onLine === false;

async function pedirJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { error: r.status === 429 ? 'demasiadas consultas (429)' : 'error ' + r.status };
    return { datos: await r.json() };
  } catch (e) {
    if (e.name === 'AbortError') return { error: 'tardó demasiado' };
    return { error: navigator.onLine === false ? 'sin internet' : 'no responde' };
  } finally {
    clearTimeout(t);
  }
}
function jsonp(url, ms = 12000) {
  return new Promise(ok => {
    const nombre = 'ml_cb_' + uid();
    const s = document.createElement('script');
    const t = setTimeout(() => { fin(); ok({ error: 'tardó demasiado' }); }, ms);
    function fin() { clearTimeout(t); window[nombre] = () => {}; s.remove(); }
    window[nombre] = d => { fin(); ok({ datos: d }); };
    s.onerror = () => { fin(); ok({ error: 'no responde' }); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + nombre;
    document.head.appendChild(s);
  });
}

const Buscador = {
  limpiar: t => String(t || '').toUpperCase().replace(/[^0-9X]/g, ''),

  valido13(s) {
    if (!/^\d{13}$/.test(s)) return false;
    let suma = 0;
    for (let i = 0; i < 12; i++) suma += +s[i] * (i % 2 ? 3 : 1);
    return (10 - (suma % 10)) % 10 === +s[12];
  },

  /** Las dos formas de un ISBN (13 y 10 cifras). La de 13 va primero. */
  variantes(isbn) {
    const l = [isbn];
    if (isbn.length === 13 && isbn.startsWith('978')) {
      const c = isbn.slice(3, 12);
      let s = 0;
      for (let i = 0; i < 9; i++) s += +c[i] * (10 - i);
      const k = (11 - (s % 11)) % 11;
      l.push(c + (k === 10 ? 'X' : k));
    } else if (isbn.length === 10) {
      const c = '978' + isbn.slice(0, 9);
      let s = 0;
      for (let i = 0; i < 12; i++) s += +c[i] * (i % 2 ? 3 : 1);
      l.unshift(c + ((10 - (s % 10)) % 10));
    }
    return l;
  },

  /** Saca un ISBN de un texto o una dirección (Amazon: /dp/ISBN-10). */
  isbnEn(texto) {
    const sin = String(texto).replace(/-/g, '');
    const re = /(^|\D)(97[89]\d{10})(?!\d)/g;
    let m;
    while ((m = re.exec(sin))) if (this.valido13(m[2])) return m[2];
    const a = String(texto).match(/\/(?:dp|gp\/product|ASIN)\/(\d{9}[\dXx])(?![0-9A-Za-z])/);
    return a ? a[1].toUpperCase() : null;
  },

  // Google Books
  async google(q, max = 10) {
    const u = new URL('https://www.googleapis.com/books/v1/volumes');
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', max);
    const clave = ajuste.leer('claveGoogle').trim();
    if (clave) u.searchParams.set('key', clave);
    const r = await pedirJSON(u);
    return { vols: (r.datos?.items || []).map(i => i.volumeInfo).filter(Boolean), error: r.error };
  },
  deGoogle(v, isbn) {
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '';
    return {
      isbn, titulo: [v.title, v.subtitle].filter(Boolean).join(': '), autores: (v.authors || []).join(', '),
      editorial: v.publisher || '', fechaPublicacion: v.publishedDate || '', paginas: v.pageCount || 0,
      descripcion: v.description || '', portada: img.replace('http://', 'https://').replace('&edge=curl', ''),
    };
  },
  isbnDe(v) {
    const ids = v.industryIdentifiers || [];
    const i = ids.find(x => x.type === 'ISBN_13') || ids.find(x => x.type === 'ISBN_10');
    return i ? this.limpiar(i.identifier) : '';
  },
  async fuenteGoogle(isbns) {
    const buscados = new Set(isbns);
    const [a, b] = await Promise.all([this.google(isbns[0]), this.google('isbn:' + isbns[0])]);
    const v = [...a.vols, ...b.vols].find(x => (x.industryIdentifiers || []).some(i => buscados.has(this.limpiar(i.identifier)))) || b.vols[0];
    if (v) {
      const d = this.deGoogle(v, isbns[0]);
      return d.titulo ? { d, estado: 'encontrado' } : { estado: 'lo tiene, pero sin título' };
    }
    if (a.error) return { estado: a.error };
    if (b.error) return { estado: b.error };
    return { estado: a.vols.length ? a.vols.length + ' resultados, ninguno con ese ISBN' : '0 resultados' };
  },

  // Apple Books (tienda española)
  deApple(l, isbn = '') {
    return {
      isbn, titulo: l.trackName || '', autores: (l.artistName || '').replace(/ & /g, ', '), editorial: '',
      fechaPublicacion: (l.releaseDate || '').slice(0, 4), paginas: 0, descripcion: quitarHTML(l.description || ''),
      portada: (l.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
    };
  },
  async fuenteApple(isbns) {
    const r = await jsonp('https://itunes.apple.com/lookup?country=ES&isbn=' + isbns.join(','));
    if (r.error) return { estado: r.error };
    const l = (r.datos?.results || []).find(x => x.trackName);
    return l ? { d: this.deApple(l, isbns[0]), estado: 'encontrado' } : { estado: 'no lo tiene' };
  },

  // Open Library
  async fuenteOL(isbns) {
    const r = await pedirJSON('https://openlibrary.org/api/books?format=json&jscmd=data&bibkeys=' + isbns.map(i => 'ISBN:' + i).join(','));
    if (r.error) return { estado: r.error };
    const l = Object.values(r.datos || {}).find(x => x.title);
    if (!l) return { estado: 'no lo tiene' };
    return {
      estado: 'encontrado',
      d: {
        isbn: isbns[0], titulo: [l.title, l.subtitle].filter(Boolean).join(': '),
        autores: (l.authors || []).map(a => a.name).join(', '), editorial: (l.publishers || []).map(p => p.name).join(', '),
        fechaPublicacion: l.publish_date || '', paginas: l.number_of_pages || 0, descripcion: '',
        portada: l.cover?.large || l.cover?.medium || '',
      },
    };
  },
  async fuenteOLBusqueda(isbn) {
    const r = await pedirJSON('https://openlibrary.org/search.json?limit=1&fields=title,subtitle,author_name,publisher,first_publish_year,number_of_pages_median,cover_i&isbn=' + isbn);
    if (r.error) return { estado: r.error };
    const doc = r.datos?.docs?.[0];
    if (!doc?.title) return { estado: 'no lo tiene' };
    return {
      estado: 'encontrado',
      d: {
        isbn, titulo: [doc.title, doc.subtitle].filter(Boolean).join(': '), autores: (doc.author_name || []).join(', '),
        editorial: (doc.publisher || [])[0] || '', fechaPublicacion: doc.first_publish_year ? String(doc.first_publish_year) : '',
        paginas: doc.number_of_pages_median || 0, descripcion: '',
        portada: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
      },
    };
  },

  /** Pregunta a todas las fuentes a la vez y junta lo que encuentran. */
  async buscarIsbn(bruto) {
    const isbns = this.variantes(this.limpiar(bruto));
    if (sinConexion()) return { d: null, sinRed: true, informe: ['Sin conexión'] };
    const nombres = [ajuste.leer('claveGoogle').trim() ? 'Google (con clave)' : 'Google', 'Apple Books', 'Open Library', 'Open Library (buscador)'];
    const rs = await Promise.all([this.fuenteGoogle(isbns), this.fuenteApple(isbns), this.fuenteOL(isbns), this.fuenteOLBusqueda(isbns[0])]);
    const d = { isbn: isbns[0], titulo: '', autores: '', editorial: '', fechaPublicacion: '', paginas: 0, descripcion: '', portada: '' };
    for (const r of rs) {
      if (!r.d) continue;
      for (const k of ['titulo', 'autores', 'editorial', 'fechaPublicacion', 'descripcion']) if (!d[k] && r.d[k]) d[k] = r.d[k];
      if (!d.paginas && r.d.paginas) d.paginas = r.d.paginas;
    }
    for (const i of [1, 2, 3, 0]) if (rs[i].d?.portada) { d.portada = rs[i].d.portada; break; }
    if (!d.portada && d.titulo) d.portada = `https://covers.openlibrary.org/b/isbn/${isbns[0]}-L.jpg?default=false`;
    const sinRed = !d.titulo && rs.every(r => ERRORES_RED.includes(r.estado));
    return { d: d.titulo ? d : null, sinRed, informe: rs.map((r, i) => nombres[i] + ': ' + r.estado) };
  },

  /** Por título, autor o lo que escribas. Junta Google y Apple Books. */
  ultimaSinRed: false,
  async buscarTexto(q) {
    q = q.trim();
    this.ultimaSinRed = false;
    if (!q) return [];
    if (sinConexion()) { this.ultimaSinRed = true; return []; }
    const [g, a] = await Promise.all([
      this.google(q, 25),
      jsonp('https://itunes.apple.com/search?media=ebook&country=ES&limit=25&term=' + encodeURIComponent(q)),
    ]);
    const lista = [
      ...g.vols.map(v => this.deGoogle(v, this.isbnDe(v))),
      ...((a.datos?.results) || []).map(x => this.deApple(x)),
    ].filter(d => d.titulo);
    this.ultimaSinRed = !lista.length && ERRORES_RED.includes(g.error) && ERRORES_RED.includes(a.error);
    const vistos = new Set();
    return lista.filter(d => {
      const k = (d.titulo + '|' + d.autores).toLowerCase();
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
  },

  /** Completa un resultado de búsqueda con todas las fuentes, si tiene ISBN. */
  async completar(d) {
    if (d.isbn) {
      const r = await this.buscarIsbn(d.isbn);
      if (r.d) {
        const portadaBuena = r.d.portada && !r.d.portada.includes('default=false') ? r.d.portada : (d.portada || r.d.portada);
        return { ...r.d, descripcion: r.d.descripcion || d.descripcion, portada: portadaBuena };
      }
    }
    return d;
  },

  /** Intenta adivinar el título a partir de una dirección (p. ej. goodreads.com/book/show/123-los-asquerosos). */
  tituloDeEnlace(url) {
    let u;
    try { u = new URL(url); } catch { return ''; }
    const genericas = new Set(['libro', 'libros', 'book', 'books', 'show', 'dp', 'es', 'en', 'products', 'product', 'p', 'item', 'gp', 'ebook', 'ebooks', 'isbn', 'search', 'work', 'works', 'edition', 'tienda']);
    let mejor = '';
    for (let p of u.pathname.split('/')) {
      try { p = decodeURIComponent(p); } catch { /* deja el trozo tal cual */ }
      p = p.replace(/\.(html?|php|aspx?)$/i, '').replace(/^\d+[-.]/, '').replace(/[-_+.]+/g, ' ').replace(/\b\d{5,}\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (!/[a-záéíóúñü]{3,}/i.test(p) || genericas.has(p.toLowerCase())) continue;
      if (p.length > mejor.length) mejor = p;
    }
    return mejor.replace(/^(libro|book)\s+/i, '').slice(0, 120);
  },

  /** Convierte lo pegado (enlace, ISBN o título) en datos de un libro. */
  async resolver(entrada) {
    if (sinConexion()) return { sinRed: true };
    if (/^https?:\/\//i.test(entrada)) {
      const isbn = this.isbnEn(entrada);
      if (isbn) {
        const r = await this.buscarIsbn(isbn);
        if (r.d) return { d: r.d };
        if (r.sinRed) return { sinRed: true };
      }
      const titulo = this.tituloDeEnlace(entrada);
      if (titulo) {
        const lista = await this.buscarTexto(titulo);
        if (lista[0]) return { d: await this.completar(lista[0]), dudoso: true };
        if (this.ultimaSinRed) return { sinRed: true };
      }
      return null;
    }
    let isbn = this.isbnEn(entrada);
    const solo = this.limpiar(entrada);
    if (!isbn && solo.length === 10 && solo.length === entrada.replace(/[\s-]/g, '').length) isbn = solo;
    if (isbn) {
      const r = await this.buscarIsbn(isbn);
      if (r.d) return { d: r.d };
      if (r.sinRed) return { sinRed: true };
    }
    const lista = await this.buscarTexto(entrada);
    if (lista[0]) return { d: await this.completar(lista[0]), dudoso: true };
    return this.ultimaSinRed ? { sinRed: true } : null;
  },

  /** Qué tipo de entrada es: enlace, ISBN o título. */
  tipoDe(entrada) {
    if (/^https?:\/\//i.test(entrada)) return { tipo: 'enlace', valor: entrada };
    const isbn = this.isbnEn(entrada);
    if (isbn) return { tipo: 'isbn', valor: isbn };
    const solo = this.limpiar(entrada);
    if (solo.length === 10 && solo.length === entrada.replace(/[\s-]/g, '').length) return { tipo: 'isbn', valor: solo };
    return { tipo: 'texto', valor: entrada.trim() };
  },
};

function entradasPegadas(texto) {
  const lista = [];
  for (const bruta of String(texto).split(/\r?\n/)) {
    const linea = bruta.trim();
    if (!linea) continue;
    const enlaces = linea.match(/https?:\/\/[^\s<>"']+/gi);
    if (enlaces) lista.push(...enlaces.map(e => e.replace(/[),.;]+$/, '')));
    else lista.push(linea);
  }
  return [...new Set(lista)];
}

// ---------- Imágenes y texto de las fotos ----------
function comprimirImagen(archivo, max = 1800, calidad = 0.82) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const e = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * e);
      c.height = Math.round(img.naturalHeight * e);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', calidad));
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

let trabajadorOCR = null;
let alProgresoOCR = null;
// El lector necesita saber el idioma del texto (ä, ö, ü, ß, ñ, acentos y su diccionario).
const IDIOMAS_OCR = { es: { codigo: 'spa', nombre: 'Español' }, en: { codigo: 'eng', nombre: 'Inglés' }, de: { codigo: 'deu', nombre: 'Alemán' } };
let idiomaTrabajador = null;
async function trabajador(idioma = 'es') {
  if (!window.Tesseract) throw new Error('sin-libreria');
  const codigo = (IDIOMAS_OCR[idioma] || IDIOMAS_OCR.es).codigo;
  if (trabajadorOCR && idiomaTrabajador !== codigo) {
    try { await trabajadorOCR.terminate(); } catch { /* ya estaba cerrado */ }
    trabajadorOCR = null;
  }
  if (!trabajadorOCR) {
    trabajadorOCR = await Tesseract.createWorker(codigo, 1, { logger: m => alProgresoOCR?.(m) });
    idiomaTrabajador = codigo;
    await trabajadorOCR.setParameters({ preserve_interword_spaces: '1' });
  }
  return trabajadorOCR;
}
function cargarImagen(src) {
  return new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = src; });
}

/** Pasa a grises y quita sombras y luz desigual: divide cada punto por el "fondo" (la foto muy
 *  desenfocada), así el papel queda blanco y la tinta oscura aunque haya una sombra. */
function limpiarParaLeer(lienzo) {
  const w = lienzo.width;
  const h = lienzo.height;
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  const datos = ctx.getImageData(0, 0, w, h);
  const d = datos.data;
  // fondo: reducir mucho y volver a ampliar = desenfoque barato
  const pw = Math.max(8, Math.round(w / 24));
  const ph = Math.max(8, Math.round(h / 24));
  const peq = document.createElement('canvas');
  peq.width = pw; peq.height = ph;
  const pctx = peq.getContext('2d');
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(lienzo, 0, 0, pw, ph);
  const fondoC = document.createElement('canvas');
  fondoC.width = w; fondoC.height = h;
  const fctx = fondoC.getContext('2d', { willReadFrequently: true });
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(peq, 0, 0, w, h);
  const f = fctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < d.length; i += 4) {
    const gris = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const fondo = Math.max(1, f[i] * 0.299 + f[i + 1] * 0.587 + f[i + 2] * 0.114);
    // 0 = tinta, 255 = papel, con algo más de contraste
    let v = (gris / fondo) * 255;
    v = (v - 80) * 1.55;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(datos, 0, 0);
  return lienzo;
}

/** Borra líneas finas y largas (subrayados a lápiz o boli) que confunden al lector. */
function quitarSubrayados(lienzo, altoLinea) {
  const w = lienzo.width;
  const h = lienzo.height;
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  const datos = ctx.getImageData(0, 0, w, h);
  const d = datos.data;
  const oscuro = (x, y) => d[(y * w + x) * 4] < 150;
  const largoMin = Math.max(30, Math.round(altoLinea * 1.6));
  const grosor = Math.max(2, Math.round(altoLinea * 0.12));
  const borrar = [];
  for (let y = grosor + 1; y < h - grosor - 1; y++) {
    let ini = -1;
    for (let x = 0; x <= w; x++) {
      const o = x < w && oscuro(x, y);
      if (o && ini < 0) ini = x;
      if (!o && ini >= 0) {
        if (x - ini >= largoMin) {
          for (let k = ini; k < x; k++) {
            // es una raya si por encima y por debajo, a poca distancia, hay papel
            if (!oscuro(k, y - grosor - 1) && !oscuro(k, y + grosor + 1)) borrar.push(y * w + k);
          }
        }
        ini = -1;
      }
    }
  }
  for (const p of borrar) {
    for (let dy = -grosor; dy <= grosor; dy++) {
      const q = (p + dy * w) * 4;
      if (q >= 0 && q < d.length) d[q] = d[q + 1] = d[q + 2] = 255;
    }
  }
  ctx.putImageData(datos, 0, 0);
}

/** Primera lectura: toda la página, para poder marcar las líneas con el dedo. */
async function leerTextoDeFoto(dataURL, idioma = 'es') {
  const t = await trabajador(idioma);
  const img = await cargarImagen(dataURL);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  limpiarParaLeer(c);
  await t.setParameters({ tessedit_pageseg_mode: '3' });
  const { data } = await t.recognize(c);
  return (data.lines || [])
    .map((l, i) => ({ id: i, texto: (l.text || '').trim(), caja: l.bbox }))
    .filter(l => l.texto && l.caja);
}

/** Segunda lectura, solo de las líneas marcadas: recortadas, ampliadas y sin subrayados. */
async function releerLineas(dataURL, lineas, idioma = 'es') {
  if (!lineas.length) return '';
  const t = await trabajador(idioma);
  const img = await cargarImagen(dataURL);
  const altos = lineas.map(l => l.caja.y1 - l.caja.y0).sort((a, b) => a - b);
  const alto = Math.max(8, altos[Math.floor(altos.length / 2)]);
  const margen = Math.round(alto * 0.8);
  const x0 = Math.max(0, Math.min(...lineas.map(l => l.caja.x0)) - margen);
  const y0 = Math.max(0, Math.min(...lineas.map(l => l.caja.y0)) - margen);
  const x1 = Math.min(img.naturalWidth, Math.max(...lineas.map(l => l.caja.x1)) + margen);
  const y1 = Math.min(img.naturalHeight, Math.max(...lineas.map(l => l.caja.y1)) + margen);
  // Tesseract lee mejor con renglones de unos 40-50 píxeles de alto
  const escala = Math.min(3, Math.max(1, 46 / alto));
  const c = document.createElement('canvas');
  c.width = Math.round((x1 - x0) * escala);
  c.height = Math.round((y1 - y0) * escala);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  limpiarParaLeer(c);
  quitarSubrayados(c, alto * escala);
  await t.setParameters({ tessedit_pageseg_mode: '6' });
  try {
    const { data } = await t.recognize(c);
    const nuevas = (data.lines || []).map((l, i) => ({ id: i, texto: (l.text || '').trim() })).filter(l => l.texto);
    return unirLineas(nuevas);
  } finally {
    await t.setParameters({ tessedit_pageseg_mode: '3' });
  }
}
function unirLineas(lineas) {
  let r = '';
  for (const l of lineas) {
    const t = l.texto.trim();
    if (!t) continue;
    if (!r) r = t;
    else if (/[-‐]$/.test(r) && /^[a-záéíóúñü]/.test(t)) r = r.slice(0, -1) + t;
    else r += ' ' + t;
  }
  return r;
}

// ---------- Archivos (exportar e importar) ----------
async function entregarArchivo(nombre, contenido, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  const archivo = new File([blob], nombre, { type: tipo });
  if (navigator.canShare && navigator.canShare({ files: [archivo] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [archivo], title: nombre }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const base64De = dataURL => (String(dataURL || '').startsWith('data:') ? String(dataURL).split(',')[1] : null);
function dataURLDe(b64) {
  if (!b64) return '';
  const tipo = b64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${tipo};base64,${b64}`;
}
function hoyArchivo() { return new Date().toISOString().slice(0, 10); }

function crearCopia() {
  return {
    app: 'MisLibros', version: 3, fecha: ahora(),
    categorias: E.categorias.map(c => ({ orden: c.orden, nombre: c.nombre, colorHex: c.colorHex })),
    palabras: E.palabras.map(p => ({ ...p })),
    libros: E.libros.map(l => ({
      id: l.id, isbn: l.isbn, titulo: l.titulo, autores: l.autores, editorial: l.editorial, fechaPublicacion: l.fechaPublicacion,
      paginas: l.paginas || 0, descripcion: l.descripcion, portada: base64De(l.portada),
      portadaURL: l.portada && !l.portada.startsWith('data:') ? l.portada : undefined,
      estado: l.estado, procedencia: l.procedencia, lugar: l.lugar, fechaDevolucion: l.fechaDevolucion || undefined,
      paginaActual: l.paginaActual || 0, notas: l.notas, fechaInicio: l.fechaInicio || undefined,
      fechaFin: l.fechaFin || undefined, fechaAlta: l.fechaAlta, etiquetas: l.etiquetas || [],
      subrayados: citasDe(l.id).map(c => ({
        imagen: base64De(c.imagen), pagina: c.pagina || 0, comentario: c.comentario, fecha: c.fecha,
        texto: c.texto, categoria: c.categoria,
      })),
    })),
  };
}
async function restaurarCopia(json) {
  const copia = typeof json === 'string' ? JSON.parse(json) : json;
  if (!copia || !Array.isArray(copia.libros)) throw new Error('no es una copia');
  for (const ce of copia.categorias || []) {
    const c = { orden: ce.orden, nombre: ce.nombre, colorHex: ce.colorHex };
    const i = E.categorias.findIndex(x => x.orden === c.orden);
    if (i >= 0) E.categorias[i] = c; else E.categorias.push(c);
    await BD.poner('categorias', c);
  }
  let nuevos = 0;
  const librosNuevos = [];
  const citasNuevas = [];
  const equivalencias = {}; // id del libro en la copia -> id aquí
  for (const e of copia.libros) {
    const ya = libroExiste({ isbn: e.isbn || '', titulo: e.titulo || '', autores: e.autores || '' });
    if (ya) { if (e.id) equivalencias[e.id] = ya.id; continue; }
    const l = nuevoLibro({
      isbn: e.isbn, titulo: e.titulo, autores: e.autores, editorial: e.editorial, fechaPublicacion: e.fechaPublicacion,
      paginas: e.paginas, descripcion: e.descripcion, portada: e.portada ? dataURLDe(e.portada) : (e.portadaURL || ''),
    }, e.estado && e.estado !== 'Por revisar' ? e.estado : 'Cajón de sastre');
    Object.assign(l, {
      procedencia: e.procedencia || 'Mío', lugar: e.lugar || '', fechaDevolucion: e.fechaDevolucion || null,
      paginaActual: e.paginaActual || 0, notas: e.notas || '', fechaInicio: e.fechaInicio || null, fechaFin: e.fechaFin || null,
      fechaAlta: e.fechaAlta || ahora(), etiquetas: e.etiquetas || [],
    });
    if (e.id && !libroPorId(e.id)) l.id = e.id;
    if (e.id) equivalencias[e.id] = l.id;
    librosNuevos.push(l);
    E.libros.push(l);
    for (const s of e.subrayados || []) {
      citasNuevas.push({
        id: uid(), libroId: l.id, imagen: dataURLDe(s.imagen), pagina: s.pagina || 0, comentario: s.comentario || '',
        texto: s.texto || '', categoria: s.categoria ?? -1, fecha: s.fecha || ahora(),
      });
    }
    nuevos++;
  }
  await BD.ponerVarios('libros', librosNuevos);
  await BD.ponerVarios('citas', citasNuevas);
  E.citas.push(...citasNuevas);
  const palabrasNuevas = [];
  for (const p of copia.palabras || []) {
    if (!p?.id || E.palabras.some(x => x.id === p.id)) continue;
    palabrasNuevas.push({ ...p, libroId: equivalencias[p.libroId] || p.libroId });
  }
  if (palabrasNuevas.length) {
    await BD.ponerVarios('palabras', palabrasNuevas);
    E.palabras.push(...palabrasNuevas);
  }
  E.libros.sort((a, b) => b.fechaAlta.localeCompare(a.fechaAlta));
  return nuevos;
}
function csv(filas) {
  const campo = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return '﻿' + filas.map(f => f.map(campo).join(';')).join('\r\n');
}
function csvLibros() {
  return csv([
    ['Título', 'Autor', 'ISBN', 'Editorial', 'Publicación', 'Páginas', 'Estado', 'De quién es', 'Biblioteca o persona', 'Devolver antes de', 'Página actual', 'Empezado', 'Terminado', 'Etiquetas', 'Notas', 'Citas'],
    ...E.libros.map(l => [l.titulo, l.autores, l.isbn, l.editorial, l.fechaPublicacion, l.paginas || '', l.estado, l.procedencia, l.lugar,
      fechaCorta(l.fechaDevolucion), l.paginaActual || '', fechaCorta(l.fechaInicio), fechaCorta(l.fechaFin),
      (l.etiquetas || []).join(', '), l.notas, citasDe(l.id).length]),
  ]);
}
function csvCitas() {
  const filas = [['Cita', 'Categoría', 'Libro', 'Autor', 'Página', 'Comentario', 'Fecha']];
  for (const c of E.citas) {
    const l = libroPorId(c.libroId);
    filas.push([c.texto, categoria(c.categoria)?.nombre || '', l?.titulo || '', l?.autores || '', c.pagina || '', c.comentario, fechaCorta(c.fecha)]);
  }
  return csv(filas);
}
function htmlLegible() {
  const bloques = E.libros.map(l => {
    const datos = [l.estado, l.procedencia + (l.lugar ? ` (${l.lugar})` : '')];
    if (l.paginas) datos.push(l.paginas + ' págs.');
    if (l.paginaActual) datos.push(`Voy por la ${l.paginaActual}` + (l.paginas ? ` de ${l.paginas}` : ''));
    if (l.fechaInicio) datos.push('Empezado: ' + fechaCorta(l.fechaInicio));
    if (l.fechaFin) datos.push('Terminado: ' + fechaCorta(l.fechaFin));
    const citas = citasDe(l.id).map(c => {
      const cat = categoria(c.categoria);
      return `<div class="cita" style="border-left-color:${esc(cat?.colorHex || '#ccc')}">
        <div class="etq">${cat ? `<span class="cat" style="border-color:${esc(cat.colorHex)}">${esc(cat.nombre)}</span>` : ''}${c.pagina ? `<span class="pag">p. ${c.pagina}</span>` : ''}</div>
        ${c.texto ? `<blockquote>“${esc(c.texto)}”</blockquote>` : ''}
        ${c.comentario ? `<p class="coment">${esc(c.comentario)}</p>` : ''}
        ${c.imagen ? `<details><summary>Ver foto de la página</summary><img class="sub" src="${c.imagen}" alt=""></details>` : ''}
      </div>`;
    }).join('');
    return `<article><div class="cab">${l.portada ? `<img class="portada" src="${esc(l.portada)}" alt="">` : ''}<div>
      <h2>${esc(l.titulo)}</h2><p class="autor">${esc(l.autores)}</p><p class="meta">${esc(datos.join(' · '))}</p>
      <p class="meta">${esc([l.editorial, l.fechaPublicacion, l.isbn && 'ISBN ' + l.isbn].filter(Boolean).join(' · '))}</p>
      ${(l.etiquetas || []).length ? `<p class="tags">${l.etiquetas.map(e => '#' + esc(e)).join(' ')}</p>` : ''}</div></div>
      ${l.notas ? `<h3>Mis notas</h3><p class="notas">${esc(l.notas).replace(/\n/g, '<br>')}</p>` : ''}
      ${citas ? `<h3>Citas y subrayados</h3>${citas}` : ''}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mis Libros</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:0 auto;padding:16px;color:#222;background:#f6f7f9}
h1{font-size:26px;margin:8px 0 4px}.fecha{color:#777;margin:0 0 24px}article{background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:16px;margin:0 0 16px}
.cab{display:flex;gap:16px}.portada{width:90px;height:135px;object-fit:cover;border-radius:6px;flex-shrink:0}h2{font-size:19px;margin:0 0 4px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#59636f;margin:18px 0 6px}.autor{margin:0 0 6px;color:#555}.meta{margin:0 0 4px;color:#777;font-size:13px}
.tags{margin:4px 0 0;color:#1f4f8c;font-size:13px}.notas{background:#f3f5f8;padding:10px 12px;border-radius:8px;margin:0}
.cita{border-left:4px solid #ccc;padding:6px 0 6px 12px;margin:0 0 12px}.etq{display:flex;gap:6px;align-items:center;margin-bottom:4px}
.cat{font-size:12px;border:1px solid;border-radius:10px;padding:1px 8px}.pag{font-size:12px;color:#888}
blockquote{font-family:Georgia,serif;font-size:16px;line-height:1.5;margin:4px 0}.coment{font-size:14px;color:#555;margin:4px 0}
summary{font-size:13px;color:#1f4f8c;cursor:pointer}.sub{width:100%;max-width:520px;border-radius:8px;margin-top:6px}</style></head>
<body><h1>Mis Libros</h1><p class="fecha">Copia del ${fechaCorta(ahora())} · ${E.libros.length} libros</p>${bloques}</body></html>`;
}

// ---------- Libros guardados sin conexión ----------
function tituloVisible(l) {
  if (l.titulo) return l.titulo;
  if (l.isbn) return 'ISBN ' + l.isbn;
  return 'Sin título';
}

/** Crea un libro con lo poco que se sabe; sus datos se buscarán cuando haya red. */
function libroPendiente(t, estado) {
  const d = {};
  if (t.tipo === 'isbn') d.isbn = t.valor;
  if (t.tipo === 'texto') d.titulo = t.valor;
  if (t.tipo === 'enlace') {
    d.titulo = Buscador.tituloDeEnlace(t.valor);
    d.notas = 'Enlace: ' + t.valor;
    const isbn = Buscador.isbnEn(t.valor);
    if (isbn) d.isbn = Buscador.variantes(isbn)[0];
  }
  const l = nuevoLibro(d, estado);
  l.pendiente = { tipo: t.tipo, valor: t.valor, tituloProvisional: d.titulo || '' };
  return l;
}

/** Rellena solo lo que falta: lo que hayas escrito tú no se toca. */
function fusionarDatos(l, d) {
  const provisional = !l.titulo || l.titulo === l.pendiente?.tituloProvisional;
  if (provisional && d.titulo) l.titulo = d.titulo;
  for (const k of ['autores', 'editorial', 'fechaPublicacion', 'descripcion', 'portada', 'isbn']) {
    if (!l[k] && d[k]) l[k] = d[k];
  }
  if (!l.paginas && d.paginas) l.paginas = d.paginas;
}

let completando = false;
async function completarPendientes(manual = false, soloId = null) {
  if (completando) return;
  const lista = E.libros.filter(l => l.pendiente && (soloId ? l.id === soloId : (manual || !l.pendiente.fallido)));
  if (!lista.length) return;
  if (sinConexion()) { if (manual) avisar('Sigues sin conexión'); return; }
  completando = true;
  pintarColumna();
  let hechos = 0;
  let sinRed = false;
  for (const l of lista) {
    const p = l.pendiente;
    let r;
    if (p.tipo === 'isbn') {
      const x = await Buscador.buscarIsbn(p.valor);
      r = x.d ? { d: x.d } : (x.sinRed ? { sinRed: true } : null);
    } else {
      r = await Buscador.resolver(p.valor);
    }
    if (r?.sinRed) { sinRed = true; break; }
    if (r?.d) {
      fusionarDatos(l, r.d);
      delete l.pendiente;
      hechos++;
    } else {
      l.pendiente = { ...p, fallido: true };
    }
    await BD.poner('libros', l);
  }
  completando = false;
  pintarTodo();
  if (hechos) avisar(hechos === 1 ? 'Completado 1 libro guardado sin conexión' : `Completados ${hechos} libros guardados sin conexión`);
  else if (manual) avisar(sinRed ? 'La conexión no responde. Lo intento otra vez más tarde.' : 'No he encontrado datos para esos libros.');
}

function bandaPendientes() {
  const n = E.libros.filter(l => l.pendiente && !l.pendiente.fallido).length;
  if (!n) return '';
  return `<div class="consejo">${icono('nube')}<p><b>${n === 1 ? '1 libro espera' : n + ' libros esperan'}</b> a tener conexión para completar sus datos y su portada. Se hará solo.</p>
    ${completando ? '<span class="cargando"></span>' : `<button type="button" class="boton" data-accion="completar-ahora">Completar ahora</button>`}</div>`;
}

function avisoPendienteFicha(l) {
  const p = l.pendiente;
  const que = p.tipo === 'isbn' ? 'el ISBN ' + p.valor : p.tipo === 'enlace' ? 'el enlace' : '«' + p.valor + '»';
  if (p.fallido) {
    return `<div class="consejo">${icono('nube')}<p>No he encontrado datos para ${esc(que)}. Puedes completar la ficha a mano.</p>
      <span class="confirmar"><button type="button" class="boton" data-accion="reintentar-pendiente" data-id="${l.id}">Reintentar</button>
      <button type="button" class="boton plano" data-accion="quitar-pendiente" data-id="${l.id}">Quitar aviso</button></span></div>`;
  }
  return `<div class="consejo">${icono('nube')}<p>Guardado sin conexión. Cuando vuelva la cobertura buscaré los datos de ${esc(que)} y su portada; lo que escribas tú no se toca.</p>
    <button type="button" class="boton" data-accion="reintentar-pendiente" data-id="${l.id}">Completar ahora</button></div>`;
}

function pintarEstadoRed() {
  const b = $('#sin-red');
  if (b) b.hidden = !sinConexion();
}

// =====================================================================
//   PANTALLAS
// =====================================================================

function portadaHTML(l, clase = '') {
  const img = l?.portada ? `<img src="${esc(l.portada)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<span class="portada ${clase}">${icono('libro')}${img}</span>`;
}
function leidosEsteAno() {
  const ano = new Date().getFullYear();
  return E.libros.filter(l => l.estado === 'Leído' && new Date(l.fechaFin || l.fechaAlta).getFullYear() === ano).length;
}
function pasaFiltros(l) {
  const f = E.filtro;
  if (f.estado && l.estado !== f.estado) return false;
  if (f.prestados && l.procedencia === 'Mío') return false;
  if (f.etiqueta && !(l.etiquetas || []).some(e => e.toLowerCase() === f.etiqueta.toLowerCase())) return false;
  if (!f.texto) return true;
  const t = f.texto.toLowerCase();
  return [l.titulo, l.autores, l.isbn, ...(l.etiquetas || [])].some(x => String(x || '').toLowerCase().includes(t));
}

// ----- Columna de libros -----
function pintarColumna() {
  if (E.vista === 'citas') return pintarCitas();
  if (E.vista === 'palabras' && window.Palabras) return Palabras.pintarColumna();
  const c = $('#columna');
  const cuenta = id => E.libros.filter(l => l.estado === id).length;
  const etiquetas = todasLasEtiquetas();
  const hayFiltro = E.filtro.estado || E.filtro.prestados || E.filtro.etiqueta;
  const resumen = [['Cajón de sastre', cuenta('Cajón de sastre')], ['Quiero leerlo', cuenta('Quiero leerlo')], ['Leyendo', cuenta('Leyendo')], ['Leído', leidosEsteAno(), 'Leídos este año']]
    .map(([id, n, texto]) => `<button type="button" data-accion="filtro-estado" data-estado="${esc(id)}" aria-pressed="${E.filtro.estado === id}">
      <b>${n}</b><small>${esc(texto || estadoDe(id).corto)}</small></button>`).join('');

  if (!E.libros.length) {
    c.innerHTML = `${consejoInstalar()}<div class="lista"><div class="vacio">
      <svg class="icono grande-icono" aria-hidden="true"><use href="#i-libro"/></svg>
      <h2>Empieza tu biblioteca</h2>
      <p>Escanea el código de barras de un libro, búscalo por el título o pega un enlace de una librería.</p>
      <button type="button" class="boton principal grande" data-accion="anadir">${icono('mas')} Añadir el primer libro</button>
      <button type="button" class="boton plano" data-accion="copia">Recuperar una copia de seguridad</button>
    </div></div>`;
    return;
  }

  const texto = E.filtro.texto;
  const enFoco = document.activeElement?.id === 'buscar-libros';
  c.innerHTML = `${consejoInstalar()}${bandaPendientes()}
    <div class="caja-busqueda">${icono('buscar')}<input id="buscar-libros" class="campo" type="search" placeholder="Título, autor o etiqueta" value="${esc(texto)}" autocomplete="off"></div>
    <div class="resumen">${resumen}</div>
    <div class="filtros">
      <select class="chip ${E.filtro.estado && !['Cajón de sastre', 'Quiero leerlo', 'Leyendo', 'Leído'].includes(E.filtro.estado) ? 'activo' : ''}" id="filtro-estado" aria-label="Filtrar por estado">
        <option value="">Todos los estados</option>
        ${ESTADOS.map(e => `<option value="${esc(e.id)}" ${E.filtro.estado === e.id ? 'selected' : ''}>${e.emoji ? e.emoji + ' ' : ''}${esc(e.id)}</option>`).join('')}
      </select>
      ${etiquetas.length ? `<select class="chip ${E.filtro.etiqueta ? 'activo' : ''}" id="filtro-etiqueta" aria-label="Filtrar por etiqueta">
        <option value="">Todas las etiquetas</option>
        ${etiquetas.map(e => `<option value="${esc(e.nombre)}" ${E.filtro.etiqueta.toLowerCase() === e.nombre.toLowerCase() ? 'selected' : ''}>#${esc(e.nombre)} (${e.n})</option>`).join('')}
      </select>` : ''}
      <button type="button" class="chip ${E.filtro.prestados ? 'activo' : ''}" data-accion="filtro-prestados" aria-pressed="${E.filtro.prestados}">${icono('biblioteca')} Biblioteca y prestados</button>
      ${hayFiltro ? `<button type="button" class="boton plano" data-accion="quitar-filtros">Quitar filtros</button>` : ''}
    </div>
    <p class="contador" id="contador"></p>
    <div class="lista" role="list" id="lista-libros"></div>`;
  pintarListaLibros();
  if (enFoco) {
    const i = $('#buscar-libros');
    i.focus();
    i.setSelectionRange(i.value.length, i.value.length);
  }
}

/** Solo la lista (al escribir en el buscador no se toca el campo, así no se cierra el teclado). */
function pintarListaLibros() {
  const lista = $('#lista-libros');
  if (!lista) return;
  const libros = E.libros.filter(pasaFiltros);
  $('#contador').textContent = libros.length === E.libros.length ? `${libros.length} libros` : `${libros.length} de ${E.libros.length} libros`;
  lista.innerHTML = libros.length ? libros.map(filaLibro).join('') : `<div class="vacio"><p>Ningún libro coincide con lo que buscas.</p></div>`;
}

/** En el iPhone, Safari y el icono de la pantalla de inicio guardan los datos por separado. */
function consejoInstalar() {
  const esIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const instalada = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!esIOS || instalada || ajuste.leer('consejoVisto')) return '';
  return `<div class="consejo">${icono('descargar')}<p><b>Añádela a tu pantalla de inicio:</b> botón Compartir de Safari → «Añadir a pantalla de inicio». Úsala siempre desde ese icono: así funciona como una app y tus libros quedan guardados ahí.</p>
    <button type="button" class="boton icono-solo plano" data-accion="cerrar-consejo" aria-label="Cerrar">${icono('x')}</button></div>`;
}

function filaLibro(l) {
  const e = estadoDe(l.estado);
  const n = E.citas.filter(c => c.libroId === l.id).length;
  const meta = [`<span>${simboloEstado(e)} ${esc(l.estado)}</span>`];
  if (l.pendiente) meta.unshift(`<span class="pendiente">${icono('nube')} ${l.pendiente.fallido ? 'Sin datos encontrados' : 'Pendiente de completar'}</span>`);
  if (l.procedencia !== 'Mío') meta.push(`<span>${icono(PROCEDENCIAS.find(p => p.id === l.procedencia)?.icono || 'casa')} ${esc(l.procedencia)}</span>`);
  if (l.notas) meta.push(`<span title="Tiene notas">${icono('nota')}</span>`);
  if (n) meta.push(`<span title="Citas">${icono('marcador')} ${n}</span>`);
  let extra = '';
  if (l.estado === 'Leyendo' && l.paginas > 0) {
    const p = Math.min(100, Math.round((l.paginaActual || 0) / l.paginas * 100));
    extra += `<span class="avance"><span class="avance-barra"><i style="width:${p}%"></i></span><small>${p} %</small></span>`;
  }
  if ((l.etiquetas || []).length) extra += `<span class="fila-etiquetas">${l.etiquetas.map(t => '#' + esc(t)).join(' ')}</span>`;
  if (l.procedencia !== 'Mío' && l.fechaDevolucion && !['Leído', 'Abandonado'].includes(l.estado)) {
    const tarde = new Date(l.fechaDevolucion) < new Date(new Date().toDateString());
    extra += `<span class="devolver ${tarde ? 'tarde' : ''}">${tarde ? 'Tenías que devolverlo el ' : 'Devolver antes del '}${diaMes(l.fechaDevolucion)}</span>`;
  }
  return `<button type="button" class="fila" role="listitem" data-accion="abrir" data-id="${l.id}" aria-current="${E.sel === l.id}">
    ${portadaHTML(l)}
    <span class="fila-texto">
      <span class="fila-titulo">${esc(tituloVisible(l))}</span>
      ${l.autores ? `<span class="fila-autor">${esc(l.autores)}</span>` : ''}
      <span class="fila-meta">${meta.join('')}</span>${extra}
    </span></button>`;
}

// ----- Ficha del libro -----
function pintarFicha() {
  const panel = $('#ficha');
  const l = libroPorId(E.sel);
  document.body.classList.toggle('ficha-abierta', !!l);
  if (!l) {
    panel.classList.add('sin-libro');
    panel.innerHTML = `<div class="vacio">${icono('libro', 'grande-icono')}<h2>Elige un libro</h2><p>Su ficha aparecerá aquí: estado, notas, avance y citas.</p></div>`;
    return;
  }
  panel.classList.remove('sin-libro');
  const sugerencias = todasLasEtiquetas().filter(e => !(l.etiquetas || []).some(x => x.toLowerCase() === e.nombre.toLowerCase())).slice(0, 24);
  const citas = citasDe(l.id);
  const pct = l.paginas > 0 ? Math.min(100, Math.round((l.paginaActual || 0) / l.paginas * 100)) : null;
  const goodreads = l.isbn ? `https://www.goodreads.com/book/isbn/${encodeURIComponent(l.isbn)}` : `https://www.goodreads.com/search?q=${encodeURIComponent((l.titulo + ' ' + l.autores).trim())}`;
  const mostrarAvance = l.estado === 'Leyendo' || l.paginaActual > 0;

  panel.innerHTML = `
  <div class="ficha-barra">
    <button type="button" class="boton plano solo-movil" data-accion="cerrar-ficha">${icono('atras')} Libros</button>
    <span class="espacio"></span>
    <a class="boton plano" href="${esc(goodreads)}" target="_blank" rel="noopener">Reseñas en Goodreads ${icono('externo')}</a>
  </div>
  <div class="ficha">
    ${l.pendiente ? avisoPendienteFicha(l) : ''}
    <div class="ficha-cabeza">
      ${portadaHTML(l, 'grande')}
      <div style="min-width:0">
        <h1>${esc(tituloVisible(l))}</h1>
        ${l.autores ? `<p class="autor">${esc(l.autores)}</p>` : ''}
        <div class="acciones">
          <label class="boton">${icono('foto')} Cambiar portada<input type="file" accept="image/*" data-archivo="portada" hidden></label>
        </div>
      </div>
    </div>

    <section class="seccion">
      <h2>Estado</h2>
      <div class="estados">${ESTADOS.map(e => `<button type="button" class="estado" data-accion="estado" data-estado="${esc(e.id)}" aria-pressed="${l.estado === e.id}">
        <span class="simbolo">${simboloEstado(e)}</span><span><b>${esc(e.id)}</b><small>${esc(e.nota)}</small></span></button>`).join('')}</div>
      ${l.estado === 'Leyendo' || l.estado === 'Leído' || l.fechaInicio ? `<div class="dos">
        <label class="etiqueta-campo">Empezado<input class="campo" type="date" data-campo="fechaInicio" data-tipo="fecha" value="${aFechaInput(l.fechaInicio)}"></label>
        ${l.estado === 'Leído' || l.fechaFin ? `<label class="etiqueta-campo">Terminado<input class="campo" type="date" data-campo="fechaFin" data-tipo="fecha" value="${aFechaInput(l.fechaFin)}"></label>` : ''}
      </div>` : ''}
    </section>

    <section class="seccion">
      <h2>Etiquetas</h2>
      ${(l.etiquetas || []).length ? `<div class="etiquetas-libro">${l.etiquetas.map(t => `<button type="button" class="chip" data-accion="quitar-etiqueta" data-etiqueta="${esc(t)}" title="Quitar">#${esc(t)} ${icono('x')}</button>`).join('')}</div>` : ''}
      <form class="fila-campo" data-form="etiqueta"><input class="campo" id="nueva-etiqueta" placeholder="Añadir etiqueta (separa varias con comas)" autocomplete="off" enterkeyhint="done"><button class="boton" type="submit">Añadir</button></form>
      ${sugerencias.length ? `<div class="sugerencias">${sugerencias.map(e => `<button type="button" data-accion="poner-etiqueta" data-etiqueta="${esc(e.nombre)}">#${esc(e.nombre)}</button>`).join('')}</div>` : ''}
      <p class="ayuda">Lo que quieras: un tema, quién te lo recomendó, «para regalar»…</p>
    </section>

    ${mostrarAvance ? `<section class="seccion">
      <h2>Mi avance</h2>
      <div class="avance-control">
        <span>Voy por la página</span>
        <input class="campo" type="number" min="0" inputmode="numeric" data-campo="paginaActual" data-tipo="numero" value="${l.paginaActual || 0}">
        ${l.paginas ? `<span class="ayuda" style="font-size:15px">de ${l.paginas}</span><span class="espacio"></span><span class="porcentaje" id="porcentaje">${pct} %</span>` : ''}
      </div>
      ${l.paginas ? `<input type="range" min="0" max="${l.paginas}" step="1" value="${Math.min(l.paginaActual || 0, l.paginas)}" data-campo="paginaActual" data-tipo="numero" aria-label="Página actual">` : `<p class="ayuda">Pon el número de páginas en «Datos del libro» para ver el porcentaje.</p>`}
      ${l.fechaProgreso ? `<p class="ayuda" id="actualizado">Actualizado ${hace(l.fechaProgreso)}</p>` : ''}
    </section>` : ''}

    <section class="seccion">
      <h2>¿De quién es?</h2>
      <div class="segmentos">${PROCEDENCIAS.map(p => `<button type="button" data-accion="procedencia" data-valor="${p.id}" aria-pressed="${l.procedencia === p.id}">${icono(p.icono)} ${p.id}</button>`).join('')}</div>
      ${l.procedencia !== 'Mío' ? `<div class="dos">
        <label class="etiqueta-campo">${l.procedencia === 'Biblioteca' ? 'Biblioteca' : 'Quién te lo ha prestado'}<input class="campo" data-campo="lugar" value="${esc(l.lugar)}" placeholder="${l.procedencia === 'Biblioteca' ? 'Biblioteca municipal…' : 'Nombre'}"></label>
        <label class="etiqueta-campo">Devolver antes de<input class="campo" type="date" data-campo="fechaDevolucion" data-tipo="fecha" value="${aFechaInput(l.fechaDevolucion)}"></label>
      </div>` : ''}
    </section>

    <section class="seccion">
      <h2>Mis notas</h2>
      <textarea class="campo" data-campo="notas" rows="4" placeholder="Lo que me ha parecido, quién me lo recomendó, frases sueltas…">${esc(l.notas)}</textarea>
    </section>

    <section class="seccion">
      <h2>Citas y subrayados <span class="espacio"></span><span style="text-transform:none;letter-spacing:0;font-weight:400">${citas.length || ''}</span></h2>
      ${citas.length ? `<div class="miniaturas">${citas.map(miniaturaCita).join('')}</div>` : ''}
      <div class="fila-campo" style="flex-wrap:wrap">
        <button type="button" class="boton principal" data-accion="nueva-cita">${icono('cita')} Añadir cita</button>
        <label class="boton">${icono('camara')} Con foto de la página<input type="file" accept="image/*" data-archivo="cita" multiple hidden></label>
      </div>
      <p class="ayuda">${esIPhone()
        ? 'Lo mejor: pulsa «Añadir cita», toca el cuadro de texto y elige «Escanear texto». El iPhone lee la página con la cámara y solo tienes que seleccionar las líneas subrayadas.'
        : 'Escríbela o pégala. También puedes añadir una foto de la página y pasar el ratón por las líneas para sacar el texto.'}</p>
    </section>

    ${window.Palabras ? Palabras.seccionFicha(l) : ''}

    ${l.descripcion ? `<section class="seccion"><h2>Sinopsis</h2><textarea class="campo" data-campo="descripcion" rows="6">${esc(l.descripcion)}</textarea></section>` : ''}

    <section class="seccion">
      <h2>Datos del libro</h2>
      <div class="dos">
        <label class="etiqueta-campo">Título<input class="campo" data-campo="titulo" value="${esc(l.titulo)}"></label>
        <label class="etiqueta-campo">Autor<input class="campo" data-campo="autores" value="${esc(l.autores)}"></label>
        <label class="etiqueta-campo">Editorial<input class="campo" data-campo="editorial" value="${esc(l.editorial)}"></label>
        <label class="etiqueta-campo">Publicación<input class="campo" data-campo="fechaPublicacion" value="${esc(l.fechaPublicacion)}"></label>
        <label class="etiqueta-campo">Páginas<input class="campo" type="number" min="0" inputmode="numeric" data-campo="paginas" data-tipo="numero" data-repintar="1" value="${l.paginas || ''}"></label>
        <label class="etiqueta-campo">ISBN<input class="campo" data-campo="isbn" inputmode="numeric" value="${esc(l.isbn)}"></label>
      </div>
      ${l.descripcion ? '' : `<button type="button" class="boton plano" data-accion="anadir-sinopsis" style="align-self:flex-start">${icono('mas')} Añadir sinopsis</button>`}
    </section>

    <section class="seccion">
      <div class="confirmar" id="zona-borrar">
        <button type="button" class="boton peligro" data-accion="pedir-borrar">${icono('papelera')} Borrar este libro</button>
      </div>
      <p class="nota-pequena">Añadido el ${fechaCorta(l.fechaAlta)}</p>
    </section>
  </div>`;
}

function miniaturaCita(c) {
  const cat = categoria(c.categoria);
  const dentro = c.texto
    ? `<span class="cita-corta">${esc(c.texto)}</span>`
    : c.imagen ? `<img src="${c.imagen}" alt="">` : '';
  return `<button type="button" class="miniatura" data-accion="abrir-cita" data-id="${c.id}" style="border-color:${esc(cat?.colorHex || 'var(--linea)')}" title="${esc(cat?.nombre || 'Sin categoría')}">
    ${dentro}${c.pagina ? `<span class="pag">p. ${c.pagina}</span>` : ''}</button>`;
}

// ----- Columna de citas -----
function pintarCitas() {
  const c = $('#columna');
  const f = E.filtroCitas;
  const enFoco = document.activeElement?.id === 'buscar-citas';
  c.innerHTML = `
    <div class="caja-busqueda">${icono('buscar')}<input id="buscar-citas" class="campo" type="search" placeholder="Buscar en tus citas" value="${esc(f.texto)}" autocomplete="off"></div>
    <div class="chips-categoria">
      <button type="button" data-accion="filtro-cat" data-cat="-1" aria-pressed="${f.cat === -1}">Todas</button>
      ${E.categorias.sort((a, b) => a.orden - b.orden).map(k => `<button type="button" data-accion="filtro-cat" data-cat="${k.orden}" aria-pressed="${f.cat === k.orden}" style="--c:${esc(k.colorHex)}"><span class="punto" style="background:${esc(k.colorHex)}"></span>${esc(k.nombre)}</button>`).join('')}
      <button type="button" class="boton plano" data-accion="categorias">${icono('paleta')} Editar</button>
    </div>
    <div class="lista" id="lista-citas"></div>`;
  pintarListaCitas();
  if (enFoco) {
    const i = $('#buscar-citas');
    i.focus();
    i.setSelectionRange(i.value.length, i.value.length);
  }
}

function pintarListaCitas() {
  const cont = $('#lista-citas');
  if (!cont) return;
  const f = E.filtroCitas;
  const t = f.texto.toLowerCase();
  const lista = E.citas
    .filter(x => (f.cat === -1 || x.categoria === f.cat))
    .filter(x => {
      if (!t) return true;
      const l = libroPorId(x.libroId);
      return [x.texto, x.comentario, l?.titulo, l?.autores].some(v => String(v || '').toLowerCase().includes(t));
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  cont.innerHTML = lista.length ? lista.map(tarjetaCita).join('') : `<div class="vacio">${icono('cita', 'grande-icono')}<h2>${E.citas.length ? 'Ninguna cita coincide' : 'Aún no hay citas'}</h2><p>${E.citas.length ? 'Prueba con otra categoría o palabra.' : 'Abre un libro y añade una foto de una página que hayas subrayado.'}</p></div>`;
}
function tarjetaCita(c) {
  const l = libroPorId(c.libroId);
  const cat = categoria(c.categoria);
  const pie = [l?.titulo, c.pagina ? 'p. ' + c.pagina : '', cat?.nombre].filter(Boolean).join(' · ');
  return `<button type="button" class="tarjeta-cita" data-accion="abrir-cita" data-id="${c.id}">
    <span class="raya" style="background:${esc(cat?.colorHex || 'var(--linea)')}"></span>
    ${!c.texto && c.imagen ? `<img src="${c.imagen}" alt="">` : ''}
    <span style="min-width:0;flex:1">
      ${c.texto ? `<blockquote>“${esc(c.texto)}”</blockquote>` : `<p class="comentario"><i>Sin texto todavía</i></p>`}
      ${c.comentario ? `<p class="comentario">${esc(c.comentario)}</p>` : ''}
      <span class="pie">${esc(pie)}</span>
    </span></button>`;
}

function pintarTodo() {
  $$('.pestanas button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.vista === E.vista)));
  pintarColumna();
  pintarFicha();
}

// =====================================================================
//   VENTANAS
// =====================================================================
let alCerrarVentana = null;
function abrirVentana({ titulo, cuerpo, pie = '', ancha = false, alCerrar = null, izquierda = '' }) {
  const yaHabia = !!$('[data-velo]');
  cerrarVentana(true);
  alCerrarVentana = alCerrar;
  $('#ventanas').innerHTML = `<div class="velo ${yaHabia ? 'quieto' : ''}" data-velo>
    <div class="ventana ${ancha ? 'ancha' : ''}" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
      <div class="ventana-cabeza">${izquierda || '<span style="width:38px"></span>'}<h2>${esc(titulo)}</h2>
        <button type="button" class="boton icono-solo plano" data-accion="cerrar-ventana" aria-label="Cerrar">${icono('x')}</button></div>
      <div class="ventana-cuerpo" id="ventana-cuerpo">${cuerpo}</div>
      ${pie ? `<div class="ventana-pie" id="ventana-pie">${pie}</div>` : ''}
    </div></div>`;
}
function cerrarVentana(silencio = false) {
  const f = alCerrarVentana;
  alCerrarVentana = null;
  if (f) f();
  $('#ventanas').innerHTML = '';
  if (!silencio) pintarTodo();
}

// ----- Añadir libro -----
let pestanaAnadir = 'escanear';
let buscandoCodigo = false;
let escaner = null;

function ventanaAnadir(pestana) {
  if (pestana) pestanaAnadir = pestana;
  abrirVentana({
    titulo: 'Añadir libro',
    alCerrar: pararEscaner,
    cuerpo: `
      <div class="segmentos" style="grid-template-columns:repeat(4,1fr)">
        ${[['escanear', 'Escanear'], ['buscar', 'Buscar'], ['pegar', 'Pegar'], ['mano', 'A mano']].map(([k, t]) => `<button type="button" data-accion="pestana-anadir" data-pestana="${k}" aria-pressed="${pestanaAnadir === k}">${t}</button>`).join('')}
      </div>
      <div id="contenido-anadir"></div>`,
  });
  pintarPestanaAnadir();
}

async function pintarPestanaAnadir() {
  await pararEscaner();
  $$('[data-accion="pestana-anadir"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pestana === pestanaAnadir)));
  const c = $('#contenido-anadir');
  if (!c) return;
  if (pestanaAnadir === 'escanear') {
    c.innerHTML = `
      <div id="lector"></div>
      <p class="estado-escaner" id="estado-escaner"><span class="cargando"></span> Abriendo la cámara…</p>
      <div id="resultado-codigo"></div>
      <form class="fila-campo" data-form="isbn"><input class="campo" id="isbn-manual" inputmode="numeric" placeholder="O escribe el ISBN (13 cifras bajo el código)" autocomplete="off"><button class="boton principal" type="submit">Buscar</button></form>
      <label class="boton" style="align-self:flex-start">${icono('camara')} Hacer una foto al código<input type="file" accept="image/*" capture="environment" data-archivo="codigo" hidden></label>`;
    iniciarEscaner();
  } else if (pestanaAnadir === 'buscar') {
    c.innerHTML = `
      <form class="fila-campo" data-form="titulo"><input class="campo" id="consulta" type="search" placeholder="Título, autor o los dos" autocomplete="off" enterkeyhint="search"><button class="boton principal" type="submit">Buscar</button></form>
      <div id="resultados"><p class="ayuda">Para los libros que te recomiendan y no tienes delante. Se guardan en el Cajón de sastre.</p></div>`;
    setTimeout(() => $('#consulta')?.focus(), 50);
  } else if (pestanaAnadir === 'pegar') {
    c.innerHTML = `
      <textarea class="campo" id="pegado" rows="6" placeholder="Pega aquí enlaces de Amazon, Casa del Libro, Goodreads, Fnac…&#10;También vale un ISBN o un título por línea."></textarea>
      <div class="fila-campo" style="flex-wrap:wrap;align-items:center">
        <button type="button" class="boton" data-accion="pegar-portapapeles">${icono('pegar')} Pegar</button>
        <span class="espacio"></span>
        <label class="etiqueta-campo" style="flex-direction:row;align-items:center;gap:8px">Guardar en
          <select class="campo" id="destino" style="width:auto;min-height:38px">
            ${['Cajón de sastre', 'Quiero leerlo'].map(e => `<option ${e === 'Cajón de sastre' ? 'selected' : ''}>${esc(e)}</option>`).join('')}
          </select></label>
      </div>
      <button type="button" class="boton principal grande" data-accion="procesar-pegado">Añadir libros</button>
      <div id="progreso-pegado" class="progreso-lista"></div>`;
  } else {
    c.innerHTML = `
      <p class="ayuda">Crea la ficha vacía y rellénala tú.</p>
      <form class="fila-campo" data-form="mano"><input class="campo" id="titulo-mano" placeholder="Título del libro" autocomplete="off" required><button class="boton principal" type="submit">Crear</button></form>`;
    setTimeout(() => $('#titulo-mano')?.focus(), 50);
  }
}

function estadoEscaner(html) { const e = $('#estado-escaner'); if (e) e.innerHTML = html; }
// ----- Lector de códigos de barras -----
// Lee la franja central de la cámara a buena resolución con ZXing (más fiable con los
// códigos de los libros). Si ZXing no carga, se usa el lector anterior (html5-qrcode).
let pistasZX = null;
let lectorZX = null;
function lectorCodigos() {
  const ZX = window.ZXing;
  if (!ZX?.MultiFormatReader) return null;
  if (!lectorZX) {
    pistasZX = new Map();
    const formatos = [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E].filter(f => f !== undefined);
    pistasZX.set(ZX.DecodeHintType.POSSIBLE_FORMATS, formatos);
    pistasZX.set(ZX.DecodeHintType.TRY_HARDER, true);
    lectorZX = new ZX.MultiFormatReader();
    lectorZX.setHints(pistasZX);
  }
  return lectorZX;
}

/** Busca un código de barras en una zona de un lienzo. Devuelve el texto o null. */
function leerCodigoDeLienzo(ctx, x, y, w, h) {
  const lector = lectorCodigos();
  if (!lector || w < 20 || h < 20) return null;
  const ZX = window.ZXing;
  const d = ctx.getImageData(x, y, w, h).data;
  const gris = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < gris.length; i++, j += 4) gris[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  const fuente = new ZX.RGBLuminanceSource(gris, w, h);
  for (const Binarizador of [ZX.HybridBinarizer, ZX.GlobalHistogramBinarizer]) {
    try {
      return lector.decodeWithState(new ZX.BinaryBitmap(new Binarizador(fuente))).getText();
    } catch { /* no hay código en esta pasada */ }
  }
  return null;
}

async function leerCodigoDeFoto(archivo) {
  if (lectorCodigos()) {
    const url = URL.createObjectURL(archivo);
    try {
      const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = url; });
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d', { willReadFrequently: true });
      for (const maximo of [1600, 2400, 1000]) {
        const e = Math.min(1, maximo / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * e);
        const h = Math.round(img.naturalHeight * e);
        for (const girada of [false, true]) {
          if (girada) {
            c.width = h; c.height = w;
            ctx.save(); ctx.translate(h, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0, w, h); ctx.restore();
          } else {
            c.width = w; c.height = h;
            ctx.drawImage(img, 0, 0, w, h);
          }
          let r = leerCodigoDeLienzo(ctx, 0, 0, c.width, c.height);
          if (r) return r;
          const alto = Math.round(c.height / 3);
          for (let y = 0; y + alto <= c.height; y += Math.round(alto / 2)) {
            r = leerCodigoDeLienzo(ctx, 0, y, c.width, alto);
            if (r) return r;
          }
        }
      }
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (window.Html5Qrcode) {
    const h = new Html5Qrcode('lector-oculto', { verbose: false });
    try { return await h.scanFile(archivo, false); } catch { return null; }
  }
  throw new Error('sin-libreria');
}

function mensajeErrorCamara(err) {
  const nombre = String(err?.name || err);
  if (/NotAllowed|Permission|Security/i.test(nombre)) {
    return 'No hay permiso para usar la cámara. En el iPhone: Ajustes → Safari → Cámara → «Preguntar» o «Permitir», y vuelve a abrir la app. También puedes escribir el ISBN o hacer una foto al código.';
  }
  if (/NotReadable|TrackStart/i.test(nombre)) return 'Otra app está usando la cámara. Ciérrala y vuelve a intentarlo.';
  return 'No encuentro ninguna cámara. Escribe el ISBN o haz una foto al código.';
}

async function iniciarEscaner() {
  const zona = $('#lector');
  if (!zona) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    zona.hidden = true;
    estadoEscaner('Este navegador no deja usar la cámara en directo. Escribe el ISBN o haz una foto al código.');
    return;
  }
  if (!lectorCodigos()) return iniciarEscanerAlternativo();

  zona.innerHTML = `<video playsinline muted autoplay></video><div class="guia" aria-hidden="true"><span></span></div>`;
  const video = $('video', zona);
  const sesion = { activa: true, stream: null, t: null };
  escaner = sesion;
  try {
    sesion.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    if (escaner !== sesion) return;
    escaner = null;
    zona.hidden = true;
    estadoEscaner(mensajeErrorCamara(err));
    return;
  }
  if (escaner !== sesion || !document.body.contains(zona)) {
    sesion.stream.getTracks().forEach(t => t.stop());
    return;
  }
  video.srcObject = sesion.stream;
  try { await video.play(); } catch { /* en iOS arranca solo al estar silenciado */ }

  // Enfoque continuo y algo de zoom: así se lee sin acercar tanto el libro
  // (los iPhone Pro no enfocan bien muy de cerca).
  const pista = sesion.stream.getVideoTracks()[0];
  try {
    const cap = pista.getCapabilities?.() || {};
    const extra = {};
    if (Array.isArray(cap.focusMode) && cap.focusMode.includes('continuous')) extra.focusMode = 'continuous';
    if (cap.zoom && cap.zoom.max >= 1.5) extra.zoom = Math.min(2, cap.zoom.max);
    if (Object.keys(extra).length) await pista.applyConstraints({ advanced: [extra] });
  } catch { /* no todas las cámaras lo permiten */ }

  estadoEscaner('Pon el código de barras dentro del recuadro. Si se ve borroso, aleja un poco el libro.');
  const lienzo = document.createElement('canvas');
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  const vuelta = () => {
    if (escaner !== sesion || !sesion.activa) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      const sw = Math.round(vw * 0.9);
      const sh = Math.round(vh * (vh > vw ? 0.3 : 0.45));
      const sx = Math.round((vw - sw) / 2);
      const sy = Math.round((vh - sh) / 2);
      const e = Math.min(1, 1280 / sw);
      lienzo.width = Math.round(sw * e);
      lienzo.height = Math.round(sh * e);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, lienzo.width, lienzo.height);
      let codigo = null;
      try { codigo = leerCodigoDeLienzo(ctx, 0, 0, lienzo.width, lienzo.height); } catch { /* sigue intentándolo */ }
      if (codigo) {
        sesion.activa = false;
        navigator.vibrate?.(60);
        alLeerCodigo(codigo);
        return;
      }
    }
    sesion.t = setTimeout(vuelta, 90);
  };
  vuelta();
}

async function iniciarEscanerAlternativo() {
  const zona = $('#lector');
  if (!window.Html5Qrcode) {
    zona.hidden = true;
    estadoEscaner('No se ha podido cargar el lector de códigos (la primera vez necesita conexión). Escribe el ISBN aquí debajo.');
    return;
  }
  const h = new Html5Qrcode('lector', { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
  const sesion = { parar: async () => { try { await h.stop(); } catch { /* nada */ } try { h.clear(); } catch { /* nada */ } } };
  escaner = sesion;
  try {
    await h.start({ facingMode: 'environment' }, { fps: 10, videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } }, codigo => alLeerCodigo(codigo), () => {});
    if (escaner !== sesion) { await sesion.parar(); return; }
    estadoEscaner('Apunta al código de barras de la contraportada.');
  } catch (err) {
    if (escaner !== sesion) return;
    escaner = null;
    zona.hidden = true;
    estadoEscaner(mensajeErrorCamara(err));
  }
}

async function pararEscaner() {
  const s = escaner;
  escaner = null;
  if (!s) return;
  if (s.parar) { await s.parar(); return; }
  s.activa = false;
  clearTimeout(s.t);
  s.stream?.getTracks().forEach(t => t.stop());
}

async function alLeerCodigo(codigo) {
  if (buscandoCodigo) return;
  const isbn = Buscador.limpiar(codigo);
  if (!(isbn.length === 13 && /^97[89]/.test(isbn)) && isbn.length !== 10) {
    estadoEscaner(`He leído ${esc(codigo)}, pero no es un ISBN. Busca el código que empieza por 978 o 979.`);
    return;
  }
  buscandoCodigo = true;
  await pararEscaner();
  if ($('#lector')) $('#lector').hidden = true;
  await buscarYAnadirIsbn(isbn);
  buscandoCodigo = false;
}

async function buscarYAnadirIsbn(isbn) {
  const destino = $('#resultado-codigo');
  estadoEscaner(`<span class="cargando"></span> Leído <b>${esc(isbn)}</b>. Buscando el libro…`);
  const ya = libroExiste({ isbn, titulo: '\u0000', autores: '' });
  if (ya) {
    estadoEscaner(`Ya tienes «${esc(ya.titulo)}».`);
    destino.innerHTML = `<div class="fila-campo"><button type="button" class="boton principal" data-accion="ir-a-libro" data-id="${ya.id}">Abrir su ficha</button><button type="button" class="boton" data-accion="seguir-escaneando">Escanear otro</button></div>`;
    return;
  }
  const r = await Buscador.buscarIsbn(isbn);
  if (!r.d && r.sinRed) {
    const l = libroPendiente({ tipo: 'isbn', valor: isbn }, 'Cajón de sastre');
    await anadirLibro(l);
    estadoEscaner(`${icono('nube')} Sin conexión: he guardado el ISBN <b>${esc(isbn)}</b>. Se completará solo cuando vuelvas a tener cobertura.`);
    destino.innerHTML = `<div class="fila-campo" style="flex-wrap:wrap">
      <button type="button" class="boton principal" data-accion="seguir-escaneando">Escanear otro</button>
      <button type="button" class="boton" data-accion="ir-a-libro" data-id="${l.id}">Ver la ficha</button></div>`;
    pintarColumna();
    return;
  }
  if (r.d) {
    const l = nuevoLibro(r.d, 'Cajón de sastre');
    await anadirLibro(l);
    E.sel = l.id;
    E.vista = 'libros';
    cerrarVentana();
    avisar(`Añadido: ${l.titulo}`);
    return;
  }
  estadoEscaner(`No he encontrado datos para el ISBN <b>${esc(isbn)}</b>.`);
  destino.innerHTML = `<p class="informe">${esc('Respuestas:\n' + r.informe.join('\n'))}</p>
    <div class="fila-campo" style="flex-wrap:wrap">
      <button type="button" class="boton principal" data-accion="crear-con-isbn" data-isbn="${esc(isbn)}">Crear la ficha a mano</button>
      <button type="button" class="boton" data-accion="pestana-anadir" data-pestana="buscar">Buscar por título</button>
      <button type="button" class="boton" data-accion="seguir-escaneando">Escanear otro</button>
    </div>`;
}

let ultimosResultados = [];
async function buscarPorTitulo(q) {
  const cont = $('#resultados');
  if (!q.trim()) return;
  cont.innerHTML = `<p class="ayuda"><span class="cargando"></span> Buscando…</p>`;
  ultimosResultados = await Buscador.buscarTexto(q);
  if (!$('#resultados')) return;
  if (!ultimosResultados.length && Buscador.ultimaSinRed) {
    cont.innerHTML = `<div class="consejo">${icono('nube')}<p>Ahora no hay conexión. Puedo guardar «${esc(q.trim())}» en el Cajón de sastre y buscar sus datos cuando vuelva la cobertura.</p></div>
      <button type="button" class="boton principal" data-accion="guardar-titulo-pendiente" data-texto="${esc(q.trim())}">Guardar para completar luego</button>`;
    return;
  }
  if (!ultimosResultados.length) {
    cont.innerHTML = `<p class="ayuda">No he encontrado nada. Prueba con menos palabras o solo con el apellido del autor.</p>`;
    return;
  }
  cont.innerHTML = `<div class="resultados">${ultimosResultados.map((d, i) => `<button type="button" class="resultado" data-accion="elegir-resultado" data-i="${i}">
    ${portadaHTML(d, 'media')}<span style="min-width:0"><b>${esc(d.titulo)}</b><small>${esc(d.autores)}</small><small>${esc([d.editorial, String(d.fechaPublicacion || '').slice(0, 4)].filter(Boolean).join(' · '))}</small></span></button>`).join('')}</div>`;
}

async function elegirResultado(i) {
  const d0 = ultimosResultados[i];
  if (!d0) return;
  const ya = libroExiste(d0);
  if (ya) { avisar('Ya lo tenías'); E.sel = ya.id; cerrarVentana(); return; }
  $('#resultados').innerHTML = `<p class="ayuda"><span class="cargando"></span> Preparando la ficha…</p>`;
  const d = await Buscador.completar(d0);
  const l = nuevoLibro(d, 'Cajón de sastre');
  await anadirLibro(l);
  E.sel = l.id;
  E.vista = 'libros';
  cerrarVentana();
  avisar(`Al cajón de sastre: ${l.titulo}`);
}

async function procesarPegado() {
  const texto = $('#pegado')?.value || '';
  const entradas = entradasPegadas(texto);
  if (!entradas.length) { avisar('Pega antes algún enlace, ISBN o título'); return; }
  const destino = $('#destino').value;
  const cont = $('#progreso-pegado');
  $('[data-accion="procesar-pegado"]').disabled = true;
  const filas = entradas.map(e => ({ entrada: e, estado: 'cola', titulo: '' }));
  const pintar = () => {
    cont.innerHTML = filas.map(f => {
      const i = { cola: '<span class="nota-pequena">·</span>', buscando: '<span class="cargando"></span>', ok: icono('check', 'ok'), igual: icono('libro', 'igual'), mal: icono('x', 'mal'), pend: icono('nube', 'igual') }[f.estado];
      const nota = { cola: 'En cola', buscando: 'Buscando…', ok: f.dudoso ? 'Añadido (buscado por el nombre; revisa que sea el que querías)' : 'Añadido', igual: 'Ya lo tenías', mal: 'No lo he encontrado', pend: 'Guardado sin conexión: se completará al volver la cobertura' }[f.estado];
      return `<div>${i}<span style="min-width:0">${esc(f.titulo || f.entrada)}<small>${esc(nota)}${f.titulo ? ' · ' + esc(f.entrada) : ''}</small></span></div>`;
    }).join('');
  };
  pintar();
  let anadidos = 0;
  for (const f of filas) {
    f.estado = 'buscando';
    pintar();
    const r = await Buscador.resolver(f.entrada);
    if (r?.sinRed) {
      const t = Buscador.tipoDe(f.entrada);
      if (t.tipo === 'isbn' && libroExiste({ isbn: t.valor, titulo: '\u0000', autores: '' })) { f.estado = 'igual'; pintar(); continue; }
      await anadirLibro(libroPendiente(t, destino));
      anadidos++;
      f.estado = 'pend';
      pintar();
      pintarColumna();
      continue;
    }
    if (!r?.d) { f.estado = 'mal'; pintar(); continue; }
    f.titulo = r.d.titulo;
    f.dudoso = r.dudoso;
    if (libroExiste(r.d)) { f.estado = 'igual'; pintar(); continue; }
    const l = nuevoLibro(r.d, destino);
    if (/^https?:/i.test(f.entrada)) l.notas = 'Enlace: ' + f.entrada;
    await anadirLibro(l);
    anadidos++;
    f.estado = 'ok';
    pintar();
    pintarColumna();
  }
  cont.insertAdjacentHTML('afterend', `<div class="fila-campo" id="tras-pegado"><span class="ayuda" style="flex:1">${anadidos === 1 ? '1 libro añadido' : anadidos + ' libros añadidos'} a «${esc(destino)}».</span>
    <button type="button" class="boton" data-accion="pestana-anadir" data-pestana="pegar">Pegar más</button>
    <button type="button" class="boton principal" data-accion="cerrar-ventana">Hecho</button></div>`);
}

// ----- Cita -----
const esIPhone = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const NOMBRE_ATAJO = 'Cita Mis Libros';
let citaEsperandoAtajo = null;
let citaProtegida = null; // la cita en blanco no se descarta mientras se explican los pasos del atajo

// Al volver del atajo, se invita a pegar el texto que ha copiado.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !citaEsperandoAtajo) return;
  const id = citaEsperandoAtajo;
  citaEsperandoAtajo = null;
  if ($('[data-accion="copiar-cita"]')?.dataset.id !== id) return;
  const aviso = $('#aviso-atajo');
  if (aviso) aviso.innerHTML = `<div class="consejo">${icono('pegar')}<p><b>¿Ya has elegido las líneas?</b> Pulsa «Pegar» para traer el texto.</p><button type="button" class="boton principal" data-accion="pegar-cita">Pegar</button></div>`;
});

/** Explica cómo crear el atajo de Atajos que hace la foto, lee el texto y lo copia. */
function ventanaAtajo(idCita) {
  citaProtegida = idCita || null;
  abrirVentana({
    titulo: 'Escanear con el iPhone',
    cuerpo: `
      <p class="ayuda">Este botón abre un <b>Atajo</b> del iPhone que hace una foto a la página, lee el texto con el lector de Apple (el mismo de la app Fotos), te deja elegir las líneas subrayadas y las copia. Al volver aquí, pulsas «Pegar». Solo hay que crearlo una vez:</p>
      <ol class="pasos-atajo">
        <li>Abre la app <b>Atajos</b> y pulsa <b>+</b> (arriba a la derecha) para crear uno nuevo.</li>
        <li>Pulsa el nombre de arriba y llámalo exactamente <b>${NOMBRE_ATAJO}</b>.</li>
        <li>Añade estas acciones, en este orden (búscalas con el buscador de abajo):
          <ol>
            <li><b>Hacer foto</b> <span class="nota-pequena">(o «Seleccionar fotos» si prefieres elegir una ya hecha)</span></li>
            <li><b>Extraer texto de la imagen</b></li>
            <li><b>Dividir texto</b> → toca «Espacios» y cámbialo a <b>Saltos de línea</b></li>
            <li><b>Seleccionar de la lista</b> → toca la flecha y activa <b>Seleccionar varios</b></li>
            <li><b>Combinar texto</b> → con <b>Espacios</b></li>
            <li><b>Copiar al portapapeles</b></li>
          </ol></li>
        <li>Pulsa <b>OK</b> para guardarlo.</li>
      </ol>
      <p class="ayuda">Al usarlo: haz la foto, marca las líneas de la cita en la lista, pulsa <b>OK</b> y vuelve a Mis Libros con el enlace «◀» de arriba a la izquierda. La primera vez el iPhone puede pedir permiso para la cámara o el portapapeles: acepta.</p>`,
    pie: `<button type="button" class="boton" data-accion="${idCita ? 'volver-cita' : 'cerrar-ventana'}" data-id="${esc(idCita || '')}">Ahora no</button>
      <button type="button" class="boton principal" data-accion="atajo-listo" data-id="${esc(idCita || '')}">Ya lo he creado${idCita ? ': escanear' : ''}</button>`,
  });
}
const citaVacia = c => !String(c.texto || '').trim() && !String(c.comentario || '').trim() && !c.imagen;

function ventanaCita(id, empezarMarcando = false, enfocar = false) {
  const c = E.citas.find(x => x.id === id);
  if (!c) return;
  const l = libroPorId(c.libroId);
  abrirVentana({
    titulo: 'Cita',
    // Una cita que se abrió y se dejó en blanco no se guarda.
    alCerrar: () => {
      if (citaVacia(c) && E.citas.includes(c) && citaProtegida !== c.id) {
        E.citas = E.citas.filter(x => x !== c);
        BD.borrar('citas', c.id);
      }
    },
    cuerpo: `
      ${!c.texto && !c.imagen && esIPhone() ? `<div class="consejo">${icono('texto')}<p><b>Escanear texto:</b> toca el cuadro de abajo y, en el menú que aparece, elige «Escanear texto» (o el icono de un recuadro con líneas del teclado). Apunta a la página, selecciona las líneas subrayadas y pulsa «Insertar». O usa el botón «Escanear con el iPhone».</p></div>` : ''}
      <div id="aviso-atajo"></div>
      <label class="etiqueta-campo">Texto de la cita
        <textarea class="campo" id="cita-texto" rows="5" style="font-family:var(--f-titulo);font-size:16px" placeholder="Escríbela o sácala de la foto">${esc(c.texto)}</textarea></label>
      <div class="fila-campo" style="flex-wrap:wrap">
        ${c.imagen ? `<button type="button" class="boton" data-accion="marcar-cita" data-id="${c.id}">${icono('texto')} ${c.texto ? 'Volver a marcar en la foto' : 'Sacar el texto de la foto'}</button>` : ''}
        ${esIPhone() ? `<button type="button" class="boton" data-accion="lanzar-atajo" data-id="${c.id}">${icono('camara')} Escanear con el iPhone</button>` : ''}
        <button type="button" class="boton" data-accion="pegar-cita" id="boton-pegar-cita">${icono('pegar')} Pegar</button>
      </div>
      ${esIPhone() ? `<button type="button" class="boton plano" style="align-self:flex-start" data-accion="como-atajo">¿Cómo funciona «Escanear con el iPhone»?</button>` : ''}
      ${c.imagen && /iPhone|iPad/.test(navigator.userAgent) ? `<p class="nota-pequena">Truco: el iPhone lee el texto de las fotos muy bien. Abre la foto en la app Fotos, mantén el dedo sobre el texto, ajusta la selección, pulsa «Copiar» y luego «Pegar» aquí.</p>` : ''}
      <div class="seccion"><h2>Categoría <span class="espacio"></span><button type="button" class="boton plano" data-accion="categorias" style="text-transform:none;letter-spacing:0">${icono('paleta')} Editar</button></h2>
        <div class="chips-categoria" id="chips-cita">${chipsCategoria(c.categoria)}</div></div>
      <div class="dos">
        <label class="etiqueta-campo">Página<input class="campo" id="cita-pagina" type="number" min="0" inputmode="numeric" value="${c.pagina || ''}"></label>
        <label class="etiqueta-campo">Libro<input class="campo" value="${esc(l?.titulo || '')}" disabled></label>
      </div>
      <label class="etiqueta-campo">Comentario<textarea class="campo" id="cita-comentario" rows="3" placeholder="Por qué lo marqué, qué me hizo pensar…">${esc(c.comentario)}</textarea></label>
      ${c.imagen ? `<img class="foto-cita" src="${c.imagen}" alt="Foto de la página">` : ''}`,
    pie: `<div class="confirmar" id="zona-borrar-cita"><button type="button" class="boton peligro" data-accion="pedir-borrar-cita" data-id="${c.id}">${icono('papelera')} Borrar</button></div>
      <span class="espacio"></span>
      <button type="button" class="boton" data-accion="copiar-cita" data-id="${c.id}">${icono('copiar')} Copiar</button>
      <button type="button" class="boton principal" data-accion="cerrar-ventana">Hecho</button>`,
  });
  const guardar = () => {
    c.texto = $('#cita-texto').value;
    c.comentario = $('#cita-comentario').value;
    c.pagina = parseInt($('#cita-pagina').value, 10) || 0;
    BD.poner('citas', c);
  };
  ['#cita-texto', '#cita-comentario', '#cita-pagina'].forEach(s => $(s).addEventListener('input', guardar));
  if (empezarMarcando && c.imagen) ventanaMarcar(c.id);
  else if (enfocar) $('#cita-texto').focus();
}
function chipsCategoria(sel) {
  return E.categorias.sort((a, b) => a.orden - b.orden).map(k => `<button type="button" data-accion="cat-cita" data-cat="${k.orden}" aria-pressed="${sel === k.orden}" style="--c:${esc(k.colorHex)}"><span class="punto" style="background:${esc(k.colorHex)}"></span>${esc(k.nombre)}</button>`).join('');
}

// ----- Marcar la cita en la foto -----
function ventanaMarcar(id) {
  const c = E.citas.find(x => x.id === id);
  if (!c?.imagen) return;
  let lineas = [];
  const sel = new Set();
  let modo = null;
  let tam = null;
  const libro = libroPorId(c.libroId);
  let idioma = c.idiomaTexto || libro?.idioma || 'es';
  let lectura = 0; // para ignorar una lectura antigua si cambias de idioma a mitad
  abrirVentana({
    titulo: 'Marca la cita',
    ancha: true,
    izquierda: `<button type="button" class="boton plano" data-accion="volver-cita" data-id="${c.id}">${icono('atras')} Cita</button>`,
    cuerpo: `
      <div class="fila-campo" style="align-items:center;flex-wrap:wrap"><span class="ayuda">Idioma del texto</span>
        <div class="segmentos" id="idioma-ocr" style="flex:1;min-width:220px">${Object.entries(IDIOMAS_OCR).map(([k, v]) => `<button type="button" data-ocr-idioma="${k}" aria-pressed="${idioma === k}">${v.nombre}</button>`).join('')}</div></div>
      <p class="ayuda" id="ayuda-ocr"><span class="cargando"></span> Leyendo el texto de la foto… <span id="pct-ocr"></span></p>
      <div class="zona-ocr" id="zona-ocr"><img id="img-ocr" src="${c.imagen}" alt="Foto de la página"></div>
      <p class="texto-elegido" id="texto-elegido" hidden></p>`,
    pie: `<button type="button" class="boton" data-accion="ocr-todo">Todo</button><button type="button" class="boton" data-accion="ocr-nada">Nada</button>
      <span class="espacio"></span><button type="button" class="boton principal" id="usar-texto" disabled>Usar este texto</button>`,
  });
  const zona = $('#zona-ocr');
  const img = $('#img-ocr');
  const actualizar = () => {
    $$('.linea-ocr', zona).forEach(d => d.classList.toggle('marcada', sel.has(+d.dataset.id)));
    const texto = unirLineas(lineas.filter(l => sel.has(l.id)));
    const p = $('#texto-elegido');
    p.hidden = !texto;
    p.textContent = texto;
    $('#usar-texto').disabled = !texto;
  };
  const linea = ev => {
    const r = zona.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * tam.w;
    const y = ((ev.clientY - r.top) / r.height) * tam.h;
    return lineas.find(l => x >= l.caja.x0 - 6 && x <= l.caja.x1 + 6 && y >= l.caja.y0 - 4 && y <= l.caja.y1 + 4);
  };
  const tocar = ev => {
    if (!tam) return;
    const l = linea(ev);
    if (!l) return;
    if (modo === null) modo = !sel.has(l.id);
    if (modo) sel.add(l.id); else sel.delete(l.id);
    actualizar();
  };
  zona.addEventListener('pointerdown', ev => { ev.preventDefault(); zona.setPointerCapture?.(ev.pointerId); modo = null; tocar(ev); });
  zona.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType === 'touch') { if (modo !== null) tocar(ev); } });
  zona.addEventListener('pointerup', () => { modo = null; });
  zona.addEventListener('pointercancel', () => { modo = null; });
  $('[data-accion="ocr-todo"]').onclick = () => { lineas.forEach(l => sel.add(l.id)); actualizar(); };
  $('[data-accion="ocr-nada"]').onclick = () => { sel.clear(); actualizar(); };
  $('#usar-texto').onclick = async () => {
    const elegidas = lineas.filter(l => sel.has(l.id));
    const primera = unirLineas(elegidas);
    const boton = $('#usar-texto');
    boton.disabled = true;
    boton.innerHTML = '<span class="cargando"></span> Afinando el texto…';
    alProgresoOCR = null;
    let texto = primera;
    try {
      const afinado = await releerLineas(c.imagen, elegidas, idioma);
      // Si la segunda lectura sale muy distinta en longitud, algo ha ido mal: se queda la primera.
      if (afinado && afinado.length > primera.length * 0.6 && afinado.length < primera.length * 1.5) texto = afinado;
    } catch { /* se queda la primera lectura */ }
    c.texto = texto;
    BD.poner('citas', c);
    ventanaCita(c.id);
  };

  const preparar = async () => {
    const esta = ++lectura;
    lineas = [];
    sel.clear();
    $$('.linea-ocr', zona).forEach(d => d.remove());
    actualizar();
    const ayuda0 = $('#ayuda-ocr');
    if (ayuda0) ayuda0.innerHTML = `<span class="cargando"></span> Leyendo el texto en ${IDIOMAS_OCR[idioma].nombre.toLowerCase()}… <span id="pct-ocr"></span>`;
    await (img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; }));
    tam = { w: img.naturalWidth, h: img.naturalHeight };
    alProgresoOCR = m => {
      const p = $('#pct-ocr');
      if (!p) return;
      if (m.status === 'recognizing text') p.textContent = Math.round(m.progress * 100) + ' %';
      else if (/load|initializ/i.test(m.status)) p.textContent = '(preparando el lector la primera vez, puede tardar un poco)';
    };
    let leidas;
    try {
      leidas = await leerTextoDeFoto(c.imagen, idioma);
    } catch (e) {
      if (esta !== lectura) return;
      const ayuda = $('#ayuda-ocr');
      if (ayuda) ayuda.textContent = e.message === 'sin-libreria'
        ? (sinConexion()
          ? 'Sin conexión: el lector de texto necesita internet la primera vez que se usa. La foto queda guardada; vuelve a esta cita cuando tengas cobertura, o escribe la cita a mano.'
          : 'No se ha podido cargar el lector de texto. Puedes escribir la cita a mano.')
        : (sinConexion()
          ? 'Sin conexión no puedo preparar el lector de texto. La foto queda guardada: vuelve a esta cita cuando tengas cobertura.'
          : 'No he podido leer el texto de la foto. Puedes escribir la cita a mano.');
      return;
    }
    if (!$('#zona-ocr') || esta !== lectura) return;
    lineas = leidas;
    zona.insertAdjacentHTML('beforeend', lineas.map(l => `<div class="linea-ocr" data-id="${l.id}" style="left:${(l.caja.x0 / tam.w) * 100}%;top:${(l.caja.y0 / tam.h) * 100}%;width:${((l.caja.x1 - l.caja.x0) / tam.w) * 100}%;height:${((l.caja.y1 - l.caja.y0) / tam.h) * 100}%"></div>`).join(''));
    $('#ayuda-ocr').textContent = lineas.length
      ? 'Pasa el dedo (o el ratón) por las líneas que subrayaste para marcarlas.'
      : 'No he encontrado texto. Prueba con otra foto, con más luz o más cerca.';
  };
  $$('[data-ocr-idioma]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.ocrIdioma === idioma) return;
    idioma = b.dataset.ocrIdioma;
    $$('[data-ocr-idioma]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.ocrIdioma === idioma)));
    c.idiomaTexto = idioma;
    BD.poner('citas', c);
    if (libro && !libro.idioma) { libro.idioma = idioma; guardarLibro(libro, true); }
    preparar();
  }));
  preparar();
}

// ----- Categorías -----
function ventanaCategorias() {
  abrirVentana({
    titulo: 'Mis categorías',
    cuerpo: `<p class="ayuda">Pon el nombre y el color que quieras. Las citas que ya tienes se actualizan solas.</p>
      <div class="lista-categorias">${E.categorias.sort((a, b) => a.orden - b.orden).map(k => `<div>
        <input type="color" value="${esc(k.colorHex)}" data-cat-color="${k.orden}" aria-label="Color de ${esc(k.nombre)}">
        <input class="campo" value="${esc(k.nombre)}" data-cat-nombre="${k.orden}" aria-label="Nombre de la categoría"></div>`).join('')}</div>`,
    pie: `<button type="button" class="boton principal" data-accion="cerrar-ventana">Hecho</button>`,
  });
}

// ----- Copia de seguridad y ajustes -----
function ventanaCopia() {
  const ultima = ajuste.leer('ultimaCopia');
  abrirVentana({
    titulo: 'Copia y ajustes',
    cuerpo: `
      ${window.Sync ? Sync.htmlAjustes() : ''}
      <div class="bloque-copia">
        <h3 class="seccion" style="margin:0;font-size:15px">Copia de seguridad</h3>
        <p class="ayuda">Además de sincronizar, conviene guardar de vez en cuando una copia en iCloud Drive, Google Drive o tu correo. Con la copia también puedes pasar libros de un dispositivo a otro a mano.</p>
        <p class="ayuda">${ultima ? 'Última copia: ' + fechaCorta(ultima) + ' (' + hace(ultima) + ')' : '<b class="mal">Aún no has hecho ninguna copia.</b>'} · ${E.libros.length} libros, ${E.citas.length} citas, ${E.palabras.length} palabras</p>
        <div class="botones">
          <button type="button" class="boton principal" data-accion="exportar" data-que="json">${icono('descargar')} Guardar copia completa</button>
          <button type="button" class="boton" data-accion="exportar" data-que="html">Versión para leer (.html)</button>
          <button type="button" class="boton" data-accion="exportar" data-que="csv">Libros para Excel</button>
          <button type="button" class="boton" data-accion="exportar" data-que="citas">Citas para Excel</button>
          <button type="button" class="boton" data-accion="exportar" data-que="palabras">Palabras para Anki</button>
        </div>
      </div>
      <div class="bloque-copia">
        <h3 class="seccion" style="margin:0;font-size:15px">Recuperar o pasar libros</h3>
        <p class="ayuda">Elige un archivo de copia (.json). Los libros que ya tienes no se duplican. También vale una copia de la app de iPhone.</p>
        <div class="botones"><label class="boton">${icono('subir')} Elegir copia…<input type="file" accept=".json,application/json" data-archivo="copia" hidden></label></div>
        <p class="ayuda" id="resultado-importar"></p>
      </div>
      <div class="bloque-copia">
        <h3 class="seccion" style="margin:0;font-size:15px">Búsqueda de libros</h3>
        <label class="etiqueta-campo">Clave de Google Books (opcional)
          <input class="campo" id="clave-google" value="${esc(ajuste.leer('claveGoogle'))}" placeholder="Solo si muchos libros no aparecen" autocomplete="off" autocapitalize="off" spellcheck="false" style="font-family:ui-monospace,monospace;font-size:13px"></label>
        <p class="nota-pequena">Google la da gratis en console.cloud.google.com: activa «Books API» y crea una clave de API.</p>
      </div>`,
    pie: `<button type="button" class="boton principal" data-accion="cerrar-ventana">Hecho</button>`,
  });
  $('#clave-google').addEventListener('input', e => ajuste.guardar('claveGoogle', e.target.value.trim()));
}

// =====================================================================
//   ACCIONES
// =====================================================================
function abrirLibro(id) {
  E.sel = id;
  E.vista = 'libros';
  pintarTodo();
  const f = $('#ficha');
  if (f) f.scrollTop = 0;
}

const acciones = {
  vista: b => { E.vista = b.dataset.vista; if (E.vista !== 'libros' && innerWidth < 920) E.sel = null; pintarTodo(); },
  anadir: () => ventanaAnadir(matchMedia('(pointer: coarse)').matches ? 'escanear' : 'buscar'),
  copia: () => ventanaCopia(),
  abrir: b => abrirLibro(b.dataset.id),
  'ir-a-libro': b => { E.sel = b.dataset.id; E.vista = 'libros'; cerrarVentana(); },
  'cerrar-ficha': () => { E.sel = null; pintarTodo(); },
  'cerrar-consejo': () => { ajuste.guardar('consejoVisto', '1'); pintarColumna(); },
  'completar-ahora': () => completarPendientes(true),
  'reintentar-pendiente': b => { const l = libroPorId(b.dataset.id); if (l?.pendiente) { l.pendiente.fallido = false; completarPendientes(true, l.id); } },
  'quitar-pendiente': b => { const l = libroPorId(b.dataset.id); delete l.pendiente; guardarLibro(l, true); pintarTodo(); },
  'guardar-titulo-pendiente': async b => {
    const l = libroPendiente({ tipo: 'texto', valor: b.dataset.texto }, 'Cajón de sastre');
    await anadirLibro(l);
    E.sel = l.id;
    E.vista = 'libros';
    cerrarVentana();
    avisar('Guardado. Se completará cuando vuelva la cobertura.');
  },
  'cerrar-ventana': () => cerrarVentana(),
  'filtro-estado': b => { E.filtro.estado = E.filtro.estado === b.dataset.estado ? null : b.dataset.estado; pintarColumna(); },
  'filtro-prestados': () => { E.filtro.prestados = !E.filtro.prestados; pintarColumna(); },
  'quitar-filtros': () => { E.filtro = { estado: null, etiqueta: '', prestados: false, texto: E.filtro.texto }; pintarColumna(); },
  'filtro-cat': b => { E.filtroCitas.cat = +b.dataset.cat; pintarColumna(); },
  estado: b => { const l = libroPorId(E.sel); cambiarEstado(l, b.dataset.estado); guardarLibro(l, true); pintarTodo(); },
  procedencia: b => { const l = libroPorId(E.sel); l.procedencia = b.dataset.valor; guardarLibro(l, true); pintarTodo(); },
  'quitar-etiqueta': b => { const l = libroPorId(E.sel); l.etiquetas = l.etiquetas.filter(t => t !== b.dataset.etiqueta); guardarLibro(l, true); pintarTodo(); },
  'poner-etiqueta': b => ponerEtiquetas(b.dataset.etiqueta),
  'anadir-sinopsis': () => { const l = libroPorId(E.sel); l.descripcion = ' '; pintarFicha(); const t = $('[data-campo="descripcion"]'); t.value = ''; t.focus(); },
  'pedir-borrar': () => {
    $('#zona-borrar').innerHTML = `<span>¿Borrar el libro y sus citas?</span>
      <button type="button" class="boton peligro" data-accion="borrar">Sí, borrar</button><button type="button" class="boton" data-accion="no-borrar">Cancelar</button>`;
  },
  'no-borrar': () => pintarFicha(),
  borrar: async () => { const l = libroPorId(E.sel); await borrarLibro(l); E.sel = null; pintarTodo(); avisar('Libro borrado'); },

  'pestana-anadir': b => { pestanaAnadir = b.dataset.pestana; if (!$('#contenido-anadir')) ventanaAnadir(); else pintarPestanaAnadir(); },
  'seguir-escaneando': () => { buscandoCodigo = false; pintarPestanaAnadir(); },
  'crear-con-isbn': async b => {
    const l = nuevoLibro({ isbn: b.dataset.isbn }, 'Cajón de sastre');
    await anadirLibro(l);
    E.sel = l.id;
    cerrarVentana();
    setTimeout(() => $('[data-campo="titulo"]')?.focus(), 100);
  },
  'elegir-resultado': b => elegirResultado(+b.dataset.i),
  'pegar-portapapeles': async () => {
    try {
      const t = await navigator.clipboard.readText();
      const area = $('#pegado');
      area.value = area.value ? area.value + '\n' + t : t;
    } catch {
      avisar('Mantén pulsado el cuadro de texto y elige «Pegar»');
      $('#pegado')?.focus();
    }
  },
  'procesar-pegado': () => procesarPegado(),

  'abrir-cita': b => ventanaCita(b.dataset.id),
  'lanzar-atajo': b => {
    if (!ajuste.leer('atajoCreado')) { ventanaAtajo(b.dataset.id); return; }
    citaEsperandoAtajo = b.dataset.id;
    location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(NOMBRE_ATAJO);
  },
  'como-atajo': () => ventanaAtajo($('[data-accion="copiar-cita"]')?.dataset.id || ''),
  'atajo-listo': b => {
    ajuste.guardar('atajoCreado', '1');
    const id = b.dataset.id;
    if (id) {
      ventanaCita(id);
      citaProtegida = null;
      citaEsperandoAtajo = id;
      location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(NOMBRE_ATAJO);
    } else cerrarVentana();
  },
  'nueva-cita': () => {
    const l = libroPorId(E.sel);
    if (!l) return;
    const c = { id: uid(), libroId: l.id, imagen: '', pagina: l.paginaActual || 0, comentario: '', texto: '', categoria: -1, fecha: ahora() };
    E.citas.push(c);
    BD.poner('citas', c);
    ventanaCita(c.id, false, true);
  },
  'volver-cita': b => { ventanaCita(b.dataset.id); citaProtegida = null; },
  'marcar-cita': b => ventanaMarcar(b.dataset.id),
  'cat-cita': b => {
    const id = $('[data-accion="copiar-cita"]')?.dataset.id;
    const c = E.citas.find(x => x.id === id);
    if (!c) return;
    const n = +b.dataset.cat;
    c.categoria = c.categoria === n ? -1 : n;
    BD.poner('citas', c);
    $('#chips-cita').innerHTML = chipsCategoria(c.categoria);
  },
  'pedir-borrar-cita': b => {
    $('#zona-borrar-cita').innerHTML = `<button type="button" class="boton peligro" data-accion="borrar-cita" data-id="${b.dataset.id}">Sí, borrar</button>`;
  },
  'borrar-cita': async b => {
    E.citas = E.citas.filter(c => c.id !== b.dataset.id);
    await BD.borrar('citas', b.dataset.id);
    cerrarVentana();
    avisar('Cita borrada');
  },
  'pegar-cita': async () => {
    const area = $('#cita-texto');
    try {
      const t = (await navigator.clipboard.readText()).replace(/\s*\n\s*/g, ' ').replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2').trim();
      if (!t) { avisar('No hay texto copiado'); return; }
      area.value = t;
      area.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      avisar('Mantén el dedo en el cuadro de texto y elige «Pegar»');
      area.focus();
    }
  },
  'copiar-cita': async b => {
    const c = E.citas.find(x => x.id === b.dataset.id);
    const l = libroPorId(c.libroId);
    const texto = `“${c.texto}”\n— ${l?.titulo || ''}${l?.autores ? ', ' + l.autores : ''}${c.pagina ? ' (p. ' + c.pagina + ')' : ''}`;
    try { await navigator.clipboard.writeText(texto); avisar('Cita copiada'); } catch { avisar('No se ha podido copiar'); }
  },
  categorias: () => ventanaCategorias(),

  exportar: async b => {
    const q = b.dataset.que;
    const base = 'MisLibros-' + hoyArchivo();
    if (q === 'json') {
      await entregarArchivo(base + '.json', JSON.stringify(crearCopia()), 'application/json');
      ajuste.guardar('ultimaCopia', ahora());
    } else if (q === 'html') await entregarArchivo(base + '.html', htmlLegible(), 'text/html');
    else if (q === 'csv') await entregarArchivo(base + '.csv', csvLibros(), 'text/csv');
    else if (q === 'palabras') await entregarArchivo(base + '-palabras.txt', Palabras.txtAnki(E.palabras), 'text/plain');
    else await entregarArchivo(base + '-citas.csv', csvCitas(), 'text/csv');
  },
};

async function ponerEtiquetas(texto) {
  const l = libroPorId(E.sel);
  if (!l) return;
  const existentes = todasLasEtiquetas();
  for (const trozo of String(texto).split(',')) {
    const e = limpiarEtiqueta(trozo);
    if (!e || l.etiquetas.some(t => t.toLowerCase() === e.toLowerCase())) continue;
    l.etiquetas.push(existentes.find(x => x.nombre.toLowerCase() === e.toLowerCase())?.nombre || e);
  }
  guardarLibro(l, true);
  pintarTodo();
  $('#nueva-etiqueta')?.focus();
}

document.addEventListener('click', e => {
  if (e.target.matches('[data-velo]')) { cerrarVentana(); return; }
  const b = e.target.closest('[data-accion]');
  if (!b || b.disabled) return;
  const f = acciones[b.dataset.accion];
  if (f) { e.preventDefault(); f(b, e); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('#ventanas').innerHTML) cerrarVentana();
    else if (E.sel && innerWidth < 920) { E.sel = null; pintarTodo(); }
  }
});

document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const tipo = f.dataset.form;
  if (tipo === 'etiqueta') ponerEtiquetas($('#nueva-etiqueta').value);
  if (tipo === 'isbn') {
    const isbn = Buscador.limpiar($('#isbn-manual').value);
    if (isbn.length !== 10 && isbn.length !== 13) { avisar('Un ISBN tiene 10 o 13 cifras'); return; }
    await pararEscaner();
    if ($('#lector')) $('#lector').hidden = true;
    buscarYAnadirIsbn(isbn);
  }
  if (tipo === 'titulo') buscarPorTitulo($('#consulta').value);
  if (tipo === 'mano') {
    const titulo = $('#titulo-mano').value.trim();
    if (!titulo) return;
    const l = nuevoLibro({ titulo }, 'Cajón de sastre');
    await anadirLibro(l);
    E.sel = l.id;
    cerrarVentana();
  }
});

// Campos de la ficha y buscadores
let temporizadorLista;
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'buscar-libros') { E.filtro.texto = t.value; pintarListaLibros(); return; }
  if (t.id === 'buscar-citas') { E.filtroCitas.texto = t.value; pintarListaCitas(); return; }
  if (t.dataset.catNombre !== undefined) {
    const k = categoria(+t.dataset.catNombre);
    k.nombre = t.value;
    BD.poner('categorias', k);
    return;
  }
  if (t.dataset.catColor !== undefined) {
    const k = categoria(+t.dataset.catColor);
    k.colorHex = t.value.toUpperCase();
    BD.poner('categorias', k);
    return;
  }
  const campo = t.dataset.campo;
  if (!campo) return;
  const l = libroPorId(E.sel);
  if (!l) return;
  let v = t.value;
  if (t.dataset.tipo === 'numero') v = Math.max(0, parseInt(v, 10) || 0);
  if (t.dataset.tipo === 'fecha') v = deFechaInput(v);
  l[campo] = v;
  if (campo === 'paginaActual') {
    l.fechaProgreso = ahora();
    $$('[data-campo="paginaActual"]').forEach(x => { if (x !== t) x.value = v; });
    const p = $('#porcentaje');
    if (p && l.paginas) p.textContent = Math.min(100, Math.round(v / l.paginas * 100)) + ' %';
    const a = $('#actualizado');
    if (a) a.textContent = 'Actualizado ahora';
  }
  guardarLibro(l);
  clearTimeout(temporizadorLista);
  temporizadorLista = setTimeout(pintarListaLibros, 300);
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'filtro-estado') { E.filtro.estado = t.value || null; pintarColumna(); return; }
  if (t.id === 'filtro-etiqueta') { E.filtro.etiqueta = t.value; pintarColumna(); return; }
  if (t.dataset.repintar) { pintarFicha(); return; }
  if (t.dataset.catColor !== undefined || t.dataset.catNombre !== undefined) return;
  const archivo = t.dataset.archivo;
  if (!archivo || !t.files?.length) return;
  const archivos = [...t.files];
  t.value = '';
  if (archivo === 'portada') {
    const l = libroPorId(E.sel);
    l.portada = await comprimirImagen(archivos[0], 700, 0.85);
    guardarLibro(l, true);
    pintarTodo();
  }
  if (archivo === 'cita') {
    const l = libroPorId(E.sel);
    avisar(archivos.length > 1 ? `Preparando ${archivos.length} fotos…` : 'Preparando la foto…');
    let ultima = null;
    for (const a of archivos) {
      try {
        const c = { id: uid(), libroId: l.id, imagen: await comprimirImagen(a, 2200, 0.85), pagina: l.paginaActual || 0, comentario: '', texto: '', categoria: -1, fecha: ahora() };
        E.citas.push(c);
        await BD.poner('citas', c);
        ultima = c;
      } catch { avisar('Una de las fotos no se ha podido leer'); }
    }
    pintarTodo();
    if (ultima && archivos.length === 1) ventanaCita(ultima.id, true);
  }
  if (archivo === 'codigo') {
    estadoEscaner('<span class="cargando"></span> Buscando el código en la foto…');
    try {
      const codigo = await leerCodigoDeFoto(archivos[0]);
      if (!codigo) {
        estadoEscaner('No he encontrado un código de barras en esa foto. Hazla con el código recto, bien iluminado y ocupando buena parte de la foto.');
        return;
      }
      await pararEscaner();
      if ($('#lector')) $('#lector').hidden = true;
      alLeerCodigo(codigo);
    } catch {
      estadoEscaner('No se ha podido cargar el lector de códigos (la primera vez necesita conexión). Escribe el ISBN aquí debajo.');
    }
  }
  if (archivo === 'copia') {
    const salida = $('#resultado-importar');
    try {
      const n = await restaurarCopia(await archivos[0].text());
      salida.textContent = n ? (n === 1 ? 'Recuperado 1 libro.' : `Recuperados ${n} libros.`) : 'No había libros nuevos: ya los tenías todos.';
      pintarColumna();
    } catch {
      salida.textContent = 'Ese archivo no es una copia de Mis Libros.';
    }
  }
});

// =====================================================================
//   ARRANQUE
// =====================================================================
async function arrancar() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo sin conexión */ });
  }
  const persistente = await BD.abrir();
  try { await navigator.storage?.persist?.(); } catch { /* el navegador decide */ }
  [E.libros, E.citas, E.categorias, E.palabras] = await Promise.all([BD.todos('libros'), BD.todos('citas'), BD.todos('categorias'), BD.todos('palabras')]);
  for (const c of CATEGORIAS_INICIALES) {
    if (!E.categorias.some(k => k.orden === c.orden)) { E.categorias.push({ ...c }); await BD.ponerCrudo('categorias', { ...c }); }
  }
  for (const c of E.citas.filter(citaVacia)) await BD.borrar('citas', c.id); // citas en blanco que quedaron sueltas
  E.citas = E.citas.filter(c => !citaVacia(c));
  const porRevisar = E.libros.filter(l => l.estado === 'Por revisar');
  for (const l of porRevisar) l.estado = 'Cajón de sastre';
  if (porRevisar.length) await BD.ponerVarios('libros', porRevisar);
  E.libros.sort((a, b) => String(b.fechaAlta).localeCompare(String(a.fechaAlta)));
  if (innerWidth >= 920 && E.libros.length) E.sel = E.libros[0].id;
  pintarTodo();
  pintarEstadoRed();
  addEventListener('online', () => { pintarEstadoRed(); setTimeout(() => completarPendientes(), 1500); });
  addEventListener('offline', pintarEstadoRed);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') completarPendientes(); });
  setTimeout(() => completarPendientes(), 2000);
  window.Sync?.arrancar();
  if (!persistente) avisar('Este navegador no deja guardar datos (¿modo privado?). Lo que añadas se perderá al cerrar.');
}
arrancar();
