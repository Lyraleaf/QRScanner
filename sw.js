/* Service worker: keeps the app itself (page, scripts, styles, camera library) available offline.
 * Network first (so updates arrive as soon as there is internet), cache as the fallback.
 * Calls to the Apps Script server are cross-origin and are never touched here. */
const CACHE = 'qr-scanner-shell-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'config.js', 'rules.js', 'xlsx.js', 'app.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'vendor/html5-qrcode.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
