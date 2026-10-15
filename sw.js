// Service worker for the app shell (same-origin only: map tiles and API calls always go to the network).
// HTML/JS is network-first, so an update reaches people as soon as they are online; the cached copy is the offline fallback.
// Bump CACHE_NAME on every release.
const CACHE_NAME = 'lifelink-cache-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './libs/leaflet/leaflet.js',
  './libs/leaflet/leaflet.css'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

const fresh = request => fetch(request).then(res => {
  if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(request, copy)); }
  return res;
});

self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const shell = req.mode === 'navigate' || /\.(html|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  event.respondWith(
    shell
      ? fresh(req).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
      : caches.match(req).then(r => r || fresh(req)).catch(() => caches.match('./index.html'))
  );
});
