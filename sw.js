/* Mis Libros: guarda la app en el dispositivo para que se abra sin conexión.
   - Archivos de la app: primero la red (así las actualizaciones llegan solas); sin red, la copia guardada.
   - Librerías, tipos de letra y lector de texto: se guardan la primera vez y después se usan sin red.
   - Portadas: se guardan al verlas, para que también se vean sin cobertura.
   - Las búsquedas de datos de libros no se guardan (necesitan red de verdad). */

const VERSION = 'mislibros-app-v4';
const EXTERNOS = 'mislibros-externos-v1';
const IMAGENES = 'mislibros-portadas-v1';

const APP = ['./', 'index.html', 'app.js', 'sync.js', 'manifest.webmanifest', 'icono-180.png', 'icono-192.png', 'icono-512.png'];
const LIBRERIAS = [
  'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
];
const HOSTS_EXTERNOS = /(^|\.)(unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
const HOSTS_PORTADAS = /(^|\.)(books\.google\.[a-z.]+|books\.googleusercontent\.com|covers\.openlibrary\.org|archive\.org|mzstatic\.com)$/;

self.addEventListener('install', evento => {
  evento.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(APP);
    const e = await caches.open(EXTERNOS);
    await Promise.all(LIBRERIAS.map(async url => {
      try {
        const r = await fetch(url, { mode: 'cors' });
        if (r.ok) await e.put(url, r);
      } catch { /* sin red al instalar: se guardará la próxima vez */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', evento => {
  evento.waitUntil((async () => {
    const validas = [VERSION, EXTERNOS, IMAGENES];
    for (const k of await caches.keys()) if (!validas.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', evento => {
  const req = evento.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    evento.respondWith(redPrimero(req));
  } else if (HOSTS_EXTERNOS.test(url.hostname)) {
    evento.respondWith(guardadoPrimero(req, EXTERNOS));
  } else if (req.destination === 'image' && HOSTS_PORTADAS.test(url.hostname)) {
    evento.respondWith(guardadoPrimero(req, IMAGENES, 500));
  }
  // Lo demás (búsquedas de libros) va directo a la red.
});

async function redPrimero(req) {
  const c = await caches.open(VERSION);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch {
    const guardada = await c.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? (await c.match('index.html')) || (await c.match('./')) : null);
    return guardada || Response.error();
  }
}

async function guardadoPrimero(req, nombre, maximo) {
  const guardada = await caches.match(req);
  if (guardada) return guardada;
  try {
    const r = await fetch(req);
    if (r.ok || r.type === 'opaque') {
      const c = await caches.open(nombre);
      await c.put(req, r.clone());
      if (maximo) recortar(c, maximo);
    }
    return r;
  } catch {
    return Response.error();
  }
}

async function recortar(c, maximo) {
  const claves = await c.keys();
  for (let i = 0; i < claves.length - maximo; i++) await c.delete(claves[i]);
}
