// Wetterwahl – Service Worker: App-Shell offline, Kartenkacheln begrenzt zwischenspeichern.
// Wetterdaten cached die App selbst (localStorage, 3 h).
const VERSION = 'ww-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/geo.js', 'js/links.js', 'js/map.js', 'js/regions.js', 'js/score.js', 'js/store.js',
  'data/land.json', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];
const TILES = 'ww-tiles-v1';
const MAX_TILES = 400;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // App-Dateien: erst Netz (damit Updates sofort ankommen), offline aus dem Cache
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
    return;
  }
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(async (res) => {
        if (res.ok) {
          await c.put(e.request, res.clone());
          const keys = await c.keys();
          if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => c.delete(k)));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
  }
});
