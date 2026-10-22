/* Service worker mínimo: solo existe para que Chrome dispare
   beforeinstallprompt (requisito de la heurística de instalación).
   Sin caché — passthrough para no servir assets viejos. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => Response.error()));
});
